/**
 * `join` handling: room admission (password + E2EE gate, brute-force rate
 * limiting), room get-or-create, peer registration, and the post-admission
 * sync (existing producers, inter-relay forwarded producers, roster pubkeys).
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import type { MediasoupManager } from '../mediasoup-manager.js';
import type { MetricsTracker } from '../metrics.js';
import type { RoomState, PeerState } from '../room-handler.js';
import { McuPipeline } from '../mcu-pipeline.js';
import type { JoinMessage } from './messages.js';
import { sendJson, deriveRoomMode, hashRoomPassword, validateSessionPubkey } from './helpers.js';
import type { SignalingServerState, SignalingConfig, InterRelayContext } from './state.js';
import { attachAudioLevelObserver } from './media-handler.js';

/**
 * W5 M2 P1.0 (REQ-MCS-012): is this room currently locked out for too many
 * wrong-password attempts within the sliding window? A lapsed window resets
 * the counter implicitly (the record is treated as fresh on the next failure).
 */
export function isRateLimited(state: SignalingServerState, roomId: string, config: SignalingConfig): boolean {
  const rec = state.passwordAttempts.get(roomId);
  if (!rec) return false;
  if (Date.now() - rec.windowStart >= config.passwordWindowMs) {
    // Window lapsed — clear so the next attempt starts a fresh window.
    state.passwordAttempts.delete(roomId);
    return false;
  }
  return rec.count >= config.passwordMaxAttempts;
}

/**
 * W5 M2 P1.0 (REQ-MCS-012): record a wrong-password attempt against a room,
 * starting (or rolling) the sliding window. NEVER logs the attempted password.
 */
export function recordFailedAttempt(state: SignalingServerState, roomId: string, config: SignalingConfig): void {
  const now = Date.now();
  const rec = state.passwordAttempts.get(roomId);
  if (!rec || now - rec.windowStart >= config.passwordWindowMs) {
    state.passwordAttempts.set(roomId, { count: 1, windowStart: now });
    return;
  }
  rec.count += 1;
}

export async function handleJoin(
  state: SignalingServerState,
  ws: WebSocket,
  msg: JoinMessage,
  manager: MediasoupManager,
  metrics: MetricsTracker,
  config: SignalingConfig,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
): Promise<void> {
  const { roomId, peerId } = msg;

  // CI-18 real fix: serialize the ENTIRE admission critical section per-room.
  // If another join is already in flight for this roomId, await its completion
  // before reading rooms/roomConfigs. W5 M2 P1.0 (REQ-MCS-012): this same lock
  // makes "first-joiner-sets-the-password" race-safe — two peers arriving in
  // the same Node tick can't both observe "no passwordHash" and both become
  // host (mirrors the original CI-18 router-orphan race).
  const pending = state.roomCreationLocks.get(roomId);
  if (pending) await pending;

  let release!: () => void;
  const creation = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.roomCreationLocks.set(roomId, creation);

  let room: RoomState;
  let sessionPubkey: string | undefined;
  try {
    // ── W5 M2 P1.0 (REQ-MCS-012/013): Zoom-style admission gate (BEFORE any
    //    room/router is created). Reject loud + early on a bad pubkey, missing
    //    or wrong password. ──
    //
    // OPT-IN by design (backward-compatible, LOW blast): the gate engages ONLY
    // when the join carries an admission `password`. A join with NO `password`
    // is the legacy / M1 path (no E2EE admission) and is admitted exactly as
    // before — so the entire M1 signaling/bench suite is untouched. E2EE rooms
    // opt in by sending the room-password (and their session pubkey).
    if (typeof msg.roomPassword === 'string') {
      // 1) Validate the in-browser ed25519 session pubkey (32-byte base64).
      //    A malformed key FAILS admission loud (no silent placeholder, D-M2-18).
      const validPubkey = validateSessionPubkey(msg.peerPubkey);
      if (validPubkey === null) {
        sendJson(ws, { type: 'error', message: 'Invalid or missing session pubkey' });
        logger.warn(
          { roomId, peerId },
          'Admission rejected: session pubkey missing or not a 32-byte ed25519 key',
        );
        return; // released in finally
      }

      // 2) Rate-limiter (Zoom-equivalent brute-force defense): refuse further
      //    admission attempts for a room that has exceeded the wrong-password
      //    threshold within the sliding window, BEFORE checking the password.
      if (isRateLimited(state, roomId, config)) {
        sendJson(ws, { type: 'error', message: 'Too many attempts — rate limited' });
        logger.warn({ roomId, peerId }, 'Admission rejected: room rate-limited (brute-force defense)');
        return; // released in finally
      }

      // 3) First-joiner-sets-it password gate (host model, decision #3). The
      //    plaintext password is NEVER logged or stored — only its hash.
      const roomConfig = state.roomConfigs.get(roomId);
      if (!roomConfig) {
        // First joiner = host: SET the room password from hash(password).
        if (msg.roomPassword.length === 0) {
          sendJson(ws, { type: 'error', message: 'Room password required' });
          logger.warn({ roomId, peerId }, 'Admission rejected: host did not supply a room password');
          return; // released in finally
        }
        // W5 M2 P6 (REQ-MCS-013): the host also declares the room's E2EE flag
        // here (first-joiner-sets-it, mirrors the password). `msg.e2ee` is the
        // host's explicit opt-in; absent ⇒ false. Later joiners inherit this
        // (the config is read, never re-written, below).
        state.roomConfigs.set(roomId, {
          passwordHash: hashRoomPassword(msg.roomPassword),
          e2ee: msg.e2ee === true,
        });
        logger.info(
          { roomId, peerId, e2ee: msg.e2ee === true },
          'Room password + E2EE mode SET by first joiner (host)',
        );
      } else {
        // Later joiner: must match the host-set passwordHash.
        if (hashRoomPassword(msg.roomPassword) !== roomConfig.passwordHash) {
          recordFailedAttempt(state, roomId, config);
          sendJson(ws, { type: 'error', message: 'Incorrect room password' });
          logger.warn({ roomId, peerId }, 'Admission rejected: incorrect room password');
          return; // released in finally — NO router/room/transport created
        }
        // Correct password → reset the brute-force counter for this room.
        state.passwordAttempts.delete(roomId);
      }
      sessionPubkey = validPubkey;
    }

    // ── Admission passed (or legacy path). Get-or-create the room. ──
    const existing = state.rooms.get(roomId);
    if (existing) {
      room = existing;
    } else {
      const roomMode = msg.mode ?? config.relayMode;
      const worker = manager.getNextWorker();
      const router = await manager.createRouter(worker);
      room = {
        roomId,
        router,
        mode: roomMode,
        peers: new Map(),
      };

      // Initialize MCU pipeline for MCU rooms. W5 M2 P7 (REQ-MCS-015): pass the
      // host-set per-room E2EE flag (the SAME `roomConfigs` flag P6 reads above —
      // set by the first joiner above, immutable after create) so the pipeline
      // STRUCTURALLY refuses to mix if this room is E2EE. Belt-and-braces:
      // `deriveRoomMode` already forces `e2ee:false` under MCU at the wire, so
      // `e2ee:true && roomMode==='mcu'` should never co-occur — this guard makes
      // that impossible to violate silently (defense-in-depth, D-M2-6). NOTE: in
      // M2 an MCU room is opened only by an explicit non-E2EE host (or the P7
      // client opt-out-of-E2EE), so this is normally `false`.
      if (roomMode === 'mcu') {
        const roomE2ee = state.roomConfigs.get(roomId)?.e2ee ?? false;
        room.mcuPipeline = new McuPipeline(router, logger, roomE2ee);
        logger.info({ roomId, e2ee: roomE2ee }, 'MCU pipeline initialized for room');
      }

      state.rooms.set(roomId, room);
      logger.info({ roomId, mode: roomMode }, 'Room created');

      // W5 M1 P5 (REQ-MCS-003): attach one AudioLevelObserver per router.
      // maxEntries:1 → only the dominant speaker. On `volumes` the relay maps
      // the dominant producerId → peerId and BROADCASTS `activeSpeaker` to all
      // room peers (it only REPORTS — the client reacts with setConsumerLayers,
      // CONTRACTS.md C0/C2.4). Best-effort: a creation failure must not break
      // room setup, so the observer stays optional and every use is guarded.
      await attachAudioLevelObserver(room, config, logger);

      // G3.2b: on the first peer join for a room this relay is STANDBY for,
      // hand the room's router to the wiring layer so it builds the
      // RoomTopology + opens the paused warm pipe (StandbyWarmPipeCoordinator
      // .ensure) — running M1's ensureWarmPipe in the LIVE signaling path.
      // Fired once per room (inside the creation block); the primary never
      // warm-pipes to itself.
      if (interRelay?.role === 'standby') {
        interRelay.onStandbyRoomReady?.(roomId, room.router);
      }
    }
  } finally {
    release();
    state.roomCreationLocks.delete(roomId);
  }

  // Create peer state. W5 M2 P1.0 (REQ-MCS-013): record the validated session
  // pubkey on the peer → the in-memory `{ peerId → sessionPubkey }` roster the
  // coordinator later seals K_room to (P1/P3).
  const peer: PeerState = {
    peerId,
    ws,
    sessionPubkey,
    sendTransport: null,
    recvTransport: null,
    producers: [],
    consumers: [],
    samplerStops: new Map(),
  };
  room.peers.set(peerId, peer);
  state.wsToRoom.set(ws, { roomId, peerId });

  // Track session in metrics
  metrics.trackBytes(roomId, peerId, 0);

  // Send router RTP capabilities to client
  sendJson(ws, {
    type: 'routerRtpCapabilities',
    rtpCapabilities: room.router.rtpCapabilities,
    mode: room.mode,
  });

  // W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5 `RoomModeProperty`; FROZEN P6 wire
  // contract): propagate the per-room E2EE mode to the joining ws on successful
  // admission. `e2ee` is the host-set room flag (legacy rooms have no config ⇒
  // false; a later joiner reads the host's value here, never its own — it
  // CANNOT flip it). `mode` is the E2EE state-machine value derived from the
  // relay forwarding mode (DISTINCT from `room.mode` 'sfu'|'mcu'). Asserted,
  // not tamper-evident (D-M2-2); the client mirrors it into RoomMode state +
  // renders the E2EE badge (P6 dev-fe). NEVER logs the password or any key.
  const e2ee = state.roomConfigs.get(roomId)?.e2ee ?? false;
  const roomMode = deriveRoomMode(room.mode, e2ee);
  sendJson(ws, { type: 'roomMode', roomId, roomMode });
  logger.info({ roomId, peerId, e2ee, mode: roomMode.mode }, 'Sent roomMode to joiner');

  // Notify newly joined peer about existing producers in the room
  for (const [existingPeerId, existingPeer] of room.peers) {
    if (existingPeerId === peerId) continue;
    for (const producer of existingPeer.producers) {
      sendJson(ws, {
        type: 'newProducer',
        peerId: existingPeerId,
        producerId: producer.id,
        kind: producer.kind,
      });
    }
  }

  // Stage B / G2 — re-announce STANDBY-forwarded producers to the fresh joiner.
  // A standby's minted (active-forward) LOCAL producers are produced by the
  // coordinator (produceLocalFromPipe, id == announced.producerId), NOT by
  // handleProduce, so they are NEVER in room.peers[*].producers — the loop above
  // misses them. Without this, a browser that HOMES to a standby and joins AFTER
  // the producers were minted never learns their ids (a mid-session client gets
  // them via fanLocalProducer's live fan-out; a FRESH join does not). The client
  // consumes each by id; handleConsume resolves the SAME id from this registry
  // (REQ-RMS-029). producerPeerId carries the original publisher for tile/E2EE
  // attribution (the consume RESPONSE re-binds authoritatively, REQ-RO-018). On a
  // PRIMARY the registry ALSO holds reverse-announced (piped-up) producers from
  // standby clients (recorded unconditionally at the pipe-producer handler), so
  // this loop re-announces them to fresh primary-homed joiners too -- for free
  // (DESIGN-1, REQ-RMS-037).
  if (interRelay) {
    const roomE2ee = state.roomConfigs.get(roomId)?.e2ee ?? false;
    for (const fwd of interRelay.registry.listForRoom(roomId)) {
      // REQ-RMS-038 E2EE fail-closed (C1): never re-announce a cross-relay
      // producer that lacks the ORIGINAL publisher id into an E2EE room.
      if (roomE2ee && fwd.producerPeerId === undefined) continue;
      sendJson(ws, {
        type: 'newProducer',
        peerId: fwd.producerPeerId ?? fwd.producerId,
        producerId: fwd.producerId,
        kind: fwd.kind,
      });
    }
  }

  // W5 M2 P1.0 (REQ-MCS-013): roster sync over signaling (reuses the per-room
  // peer-iteration idiom). Session pubkeys are PUBLIC keys — safe to send/log.
  // Only the E2EE/admission path captures a sessionPubkey; legacy joins skip
  // this entirely (no `rosterPeer` frames → M1 wire unchanged).
  //  (a) announce the NEW peer's sessionPubkey to every EXISTING peer, and
  //  (b) send each existing member's sessionPubkey to the new joiner,
  // so the coordinator (P3) can seal K_room to the full `{peerId→pubkey}` set.
  if (sessionPubkey !== undefined) {
    for (const [existingPeerId, existingPeer] of room.peers) {
      if (existingPeerId === peerId) continue;
      // (a) tell the existing peer about the new joiner.
      sendJson(existingPeer.ws, {
        type: 'rosterPeer',
        peerId,
        sessionPubkey,
      });
      // (b) tell the new joiner about this existing peer (if it has a pubkey).
      if (existingPeer.sessionPubkey !== undefined) {
        sendJson(ws, {
          type: 'rosterPeer',
          peerId: existingPeerId,
          sessionPubkey: existingPeer.sessionPubkey,
        });
      }
    }
  }

  logger.info(
    { roomId, peerId, peerCount: room.peers.size },
    'Peer joined room',
  );
}
