/**
 * WebSocket server for mediasoup client-relay signaling.
 *
 * Protocol: JSON messages over WebSocket for mediasoup transport negotiation.
 * Manages rooms, peers, transports, producers, and consumers.
 *
 * Requirements: RELAY-05
 */

import { createHash } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import type { MediasoupManager } from './mediasoup-manager.js';
import type { MetricsTracker } from './metrics.js';
import {
  type RoomState,
  type PeerState,
  createWebRtcTransport,
  notifyNewProducer,
  createConsumer,
  removePeer,
  ensureRelayProbe,
} from './room-handler.js';
import { McuPipeline } from './mcu-pipeline.js';
import {
  type InterRelayProducerRegistry,
  type InterRelaySocketLike,
  isPipeProducerAnnounce,
  isValidInterRelayToken,
  INTER_RELAY_SUBPROTOCOL,
} from './inter-relay.js';
import type { RelayRole } from './relay-role-manager.js';

// ── Protocol message types ──────────────────────────────────────────

interface JoinMessage {
  type: 'join';
  roomId: string;
  peerId: string;
  /** Room mode: 'sfu' (default) or 'mcu'. First joiner sets the mode. */
  mode?: 'sfu' | 'mcu';
  /**
   * W5 M2 P1.0 (REQ-MCS-012, CONTEXT D-M2-18) — Zoom-style ADMISSION password.
   * Carried in cleartext over the (TLS) WS; the relay hashes it and checks it
   * online (first-joiner-sets-it, §below). DISTINCT from the mediasoup ICE
   * `iceParameters.password` (DTLS/ICE credential) — this is the room-join
   * secret, NOT a media-transport credential. Wire field name `roomPassword`
   * (shared verbatim with the client `buildJoinMessage`) — deliberately NOT
   * `password`, to avoid the ICE `iceParameters.password` collision.
   */
  roomPassword?: string;
  /**
   * W5 M2 P1.0 (REQ-MCS-013) — the joiner's in-browser ed25519 SESSION public
   * key, base64 (decodes to exactly 32 bytes). Recorded in the room roster as
   * `{ peerId → sessionPubkey }`; the coordinator later seals K_room to it
   * (P1/P3). PUBLIC key only — safe to log/announce. A malformed (non-32-byte)
   * key FAILS admission loud (no silent placeholder).
   */
  peerPubkey?: string;
  /**
   * W5 M2 P1.0 (decision #2) — proof-of-possession signature over the join, and
   * its nonce. The client signs these (auth.ts byte-shape); for M2 the relay
   * does NOT verify them (admission gate = the password, D-M2-8) — they ride the
   * wire UNVERIFIED, reserved for the M3 on-chain-bind hardening. Carried so the
   * wire contract is stable now and verification is purely additive in M3.
   */
  signature?: string;
  nonce?: number;
  /**
   * W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5 `RoomModeProperty`) — the HOST (first
   * joiner) declares whether the room runs the SFrame E2EE transform. Stored on
   * the per-room `RoomConfig` (NOT on-chain, D-M2-2); LATER joiners INHERIT the
   * host-set value and CANNOT flip it (the field is read only when the room is
   * first created). Absent ⇒ `false` (legacy / M1 rooms unchanged — opt-in, like
   * `roomPassword`). The relay only PROPAGATES this as a room property
   * (signaling/client-asserted, NOT tamper-evident, D-M2-2); it does not gate
   * media on it. Crypto-claim discipline (D-M2-8): E2EE here is the per-room
   * SFrame state — NOT a relay/validator "cannot decrypt" guarantee.
   */
  e2ee?: boolean;
}

interface CreateTransportMessage {
  type: 'createTransport';
  direction: 'send' | 'recv';
}

interface ConnectTransportMessage {
  type: 'connectTransport';
  transportId: string;
  dtlsParameters: msTypes.DtlsParameters;
}

interface ProduceMessage {
  type: 'produce';
  transportId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
}

interface ConsumeMessage {
  type: 'consume';
  /**
   * Optional. On the PRIMARY a client supplies the producerId it learned via a
   * `newProducer` notification. On the STANDBY (G1 reconciliation) the client
   * sends `{ type:'consume', rtpCapabilities }` WITHOUT a producerId and the
   * standby resolves the piped producer from room context (the inter-relay
   * announce registry). See dev-fe client-consume contract reconciliation.
   */
  producerId?: string;
  rtpCapabilities: msTypes.RtpCapabilities;
}

interface LeaveMessage {
  type: 'leave';
}

/**
 * W5 M1 (REQ-MCS-002) — client requests the relay apply a per-consumer simulcast
 * layer preference. `setPreferredLayers` is a SERVER-SIDE mediasoup call
 * (CONTRACTS.md C0): the client NEVER calls it, it only sends this request and
 * the relay looks up the stored Consumer by `consumerId` and applies it.
 */
interface SetConsumerLayersMessage {
  type: 'setConsumerLayers';
  /** mediasoup Consumer.id, as returned to the client in the `consumed` reply. */
  consumerId: string;
  /** Spatial layer 0|1|2 (CONTRACTS.md C1: 0=low/thumbnail, 2=high/active-speaker). */
  spatialLayer: number;
  /**
   * Temporal layer 0|1|2 (VP8 L1T3). Optional-semantics: omit → relay keeps the
   * current temporal layer (passes only { spatialLayer } to setPreferredLayers).
   */
  temporalLayer?: number;
}

/**
 * W5 M1 P6 (REQ-MCS-004) — client requests the relay pause a consumer to stop
 * forwarding RTP for an off-page tile. Server effect: paused consumer forwards
 * RTCP only (~0 media bytes). CONTRACTS.md C2.2.
 */
interface PauseConsumerMessage {
  type: 'pauseConsumer';
  /** mediasoup Consumer.id for the off-page consumer to stop paying for. */
  consumerId: string;
}

/**
 * W5 M1 P6 (REQ-MCS-004) — client requests the relay resume a consumer to
 * restart RTP for a tile entering the visible set. CONTRACTS.md C2.3.
 */
interface ResumeConsumerMessage {
  type: 'resumeConsumer';
  /** mediasoup Consumer.id for the on-page consumer to resume. */
  consumerId: string;
}

/**
 * Inbound inter-relay producer-announce frame (G1). Received by the STANDBY
 * relay on the same WS server, distinguished from client frames by `type`.
 * Shape matches PipeProducerAnnounce in inter-relay.ts.
 */
interface PipeProducerMessage {
  type: 'pipe-producer';
  roomId: string;
  producerId: string;
  kind: msTypes.MediaKind;
}

/**
 * W5 M2 P4 (REQ-MCS-012, transport half) — the coordinator-sealed group-key
 * bundle, broadcast BLIND over signaling (CONTRACTS.md §1, FROZEN). The client's
 * KeyManager (P3) PRODUCES this; signaling only FORWARDS it recipient-oblivious
 * to the OTHER room members. Signaling NEVER holds, derives, decrypts, or logs a
 * key — every field below is opaque transport, and `sealedKey` is NEVER logged.
 */
interface SealedEnvelope {
  /** base64 of the recipient's ed25519 session pubkey (matches a roster entry). */
  recipientPubkey: string;
  /**
   * base64 libsodium crypto_box_seal( K_room, X25519(recipientPubkey) ). OPAQUE
   * to signaling + relay — NEVER logged (only the envelope COUNT is, see §1).
   */
  sealedKey: string;
}

interface E2EEKeyBundleMessage {
  type: 'e2eeKeyBundle';
  /** Sui room id (0x-hex); MUST match the sender's joined room or it is ignored. */
  roomId: string;
  /** monotonic membership epoch; == kid. u32 range. */
  epoch: number;
  /** SFrame Key ID written to the cleartext header (== epoch). u8 wire. */
  kid: number;
  /** base64 ed25519 session pubkey of the electing coordinator (audit/anti-spoof). */
  coordinatorPubkey: string;
  /** one per roster member; ORDER-INSENSITIVE (recipient-oblivious). */
  envelopes: SealedEnvelope[];
}

type SignalingMessage =
  | JoinMessage
  | CreateTransportMessage
  | ConnectTransportMessage
  | ProduceMessage
  | ConsumeMessage
  | SetConsumerLayersMessage
  | PauseConsumerMessage
  | ResumeConsumerMessage
  | LeaveMessage
  | PipeProducerMessage
  | E2EEKeyBundleMessage;

/**
 * S30.C — Optional TURN credential injection. When provided, the signaling
 * server calls `buildIceServers(peerId)` during createTransport and inlines
 * the result into the `transportCreated` response so mediasoup-client can
 * add TURN relay candidates. Returning null skips for that transport; the
 * server logs and degrades gracefully on errors (no TURN, baseline path).
 */
export interface TurnContext {
  buildIceServers(
    peerId: string,
  ): Promise<
    Array<{ urls: string | string[]; username?: string; credential?: string }> | null
  >;
}

/**
 * G1 inter-relay coordination context. When provided, the signaling server:
 *  - PRIMARY: after handleProduce, calls `announceProducer(roomId, producer)`
 *    to push a `pipe-producer` frame to the paired standby.
 *  - STANDBY: records inbound `pipe-producer` frames into `registry`, and
 *    resolves a client `consume` that omits producerId from room context.
 *
 * Injected by index.ts (the wiring layer) — kept optional + decoupled so the
 * baseline single-relay signaling path is unchanged (mirrors TurnContext).
 *
 * LIVE two-relay verification DEFERRED to bench (Phase 5.3).
 */
export interface InterRelayContext {
  /** This relay's role for the rooms it serves. */
  role: RelayRole;
  /** Standby-side registry of producers announced by the primary. */
  registry: InterRelayProducerRegistry;
  /**
   * Primary-side: push a producer announce to the paired standby.
   * The wiring layer holds the inter-relay WS link to the standby endpoint.
   */
  announceProducer(roomId: string, producer: Pick<msTypes.Producer, 'id' | 'kind'>): void;
  /**
   * G3.2b PRIMARY-side: the server accepted a TAGGED inter-relay peer (the
   * standby dialing in over the authenticated link). The wiring layer stores it
   * as the live `interRelayLink.socket` the announce sender transmits over;
   * `null` is passed when that peer disconnects (single-box detach). Optional —
   * absent on the in-process bench (which sets the socket directly).
   */
  attachPeerSocket?(socket: InterRelaySocketLike | null): void;
  /**
   * G3.2b STANDBY-side: fired ONCE on the first peer join for a room this relay
   * is standby for (room creation). The wiring layer builds the room's
   * RoomTopology + calls StandbyWarmPipeCoordinator.ensure() so the paused warm
   * pipe runs in the LIVE signaling path (M1 built ensureWarmPipe but never ran
   * it in production). Optional.
   */
  onStandbyRoomReady?(roomId: string, router: msTypes.Router): void;
}

/** Send a JSON message to a WebSocket. */
function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── W5 M2 P1.0 (REQ-MCS-012/013) — Zoom-style admission helpers ─────────

/**
 * Per-room ADMISSION config (NOT on-chain; D-M2-2). Co-located with `rooms`.
 * `passwordHash` is SHA-256(password) base64 — set by the FIRST joiner
 * (first-joiner-sets-it host model, decision #3) and matched by every later
 * joiner. NEVER stores the plaintext password.
 */
interface RoomConfig {
  passwordHash: string;
  /**
   * W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5): the per-room E2EE flag declared by
   * the FIRST joiner (host) at create-time. Later joiners INHERIT it (read-only
   * after create). `true` ⇒ the SFrame transform is active for the room. NOT
   * on-chain (D-M2-2) — signaling/client-asserted, not tamper-evident.
   */
  e2ee: boolean;
}

/**
 * W5 M2 P6 (REQ-MCS-013, CONTRACTS.md §5 `RoomModeProperty`): the E2EE room-mode
 * state propagated to clients over signaling. `mode` is the E2EE state-machine
 * value — DISTINCT from the relay forwarding `room.mode` ('sfu'|'mcu'). Mapping:
 * an SFU room maps to 'SFU-E2EE'; an MCU room maps to 'MCU-floor' (the
 * graceful-degradation floor, D-M2-6 — the SFU-E2EE→MCU-floor consent gate is P7).
 *
 * ⚠️ HONESTY INVARIANT (D-M2-8): an MCU relay server-MIXES (decode → re-encode)
 * media, which structurally breaks SFrame content-E2EE — an MCU room is content-
 * blind to the participant by the RELAY, it is NOT end-to-end encrypted. So we
 * FORCE `e2ee:false` under MCU regardless of the host's request, keeping the
 * asserted property honest (the client badge keys on this flag). Matches
 * CONTRACTS.md §5 field-for-field.
 */
function deriveRoomMode(
  forwardingMode: 'sfu' | 'mcu',
  e2ee: boolean,
): { e2ee: boolean; mode: 'SFU-E2EE' | 'MCU-floor' } {
  // MCU server-mixing is incompatible with SFrame E2EE → e2ee:false (honest).
  if (forwardingMode === 'mcu') return { e2ee: false, mode: 'MCU-floor' };
  return { e2ee, mode: 'SFU-E2EE' };
}

/**
 * Hash the admission room-password. Reuses the SAME approach as the shipped TURN
 * credential verifier — SHA-256 → base64 (cp-daemon `turn-issuer.ts:94-96`
 * `hashCredentialPassword`); relay is a separate app so the small helper is
 * replicated locally rather than imported. NOT a new/invented hash. The plain
 * password is NEVER logged or stored (only this digest is kept).
 */
function hashRoomPassword(password: string): string {
  return createHash('sha256').update(password).digest('base64');
}

/**
 * Validate + return the joiner's base64 ed25519 SESSION pubkey, or `null` if it
 * is malformed (non-base64 / not exactly 32 bytes). Mirrors the cap-token-issuer
 * length-check (`cap-token-issuer.ts:251-264`) — the relay is a separate app so
 * the small check is replicated locally (no cross-app import). A `null` return
 * means admission must FAIL LOUD (no silent placeholder key).
 */
function validateSessionPubkey(pubkeyB64: string | undefined): string | null {
  if (typeof pubkeyB64 !== 'string' || pubkeyB64.length === 0) return null;
  // Buffer.from(base64) is lenient (drops invalid chars), so a non-base64 input
  // typically surfaces as a wrong-length decode rather than a throw.
  const decoded = Buffer.from(pubkeyB64, 'base64');
  if (decoded.length !== 32) return null;
  return pubkeyB64;
}

/**
 * Per-roomId wrong-password attempt tracker — Zoom-equivalent brute-force
 * defense. Counts failed admission attempts within a sliding window; once the
 * threshold is hit, further attempts for that room are refused with a
 * rate-limit error (not a plain wrong-password error) until the window lapses.
 * A correct password (admission) resets the room's counter. Cleared when the
 * room empties (so a reused roomId starts fresh).
 */
interface AttemptRecord {
  count: number;
  windowStart: number;
}

/**
 * Create the mediasoup signaling WebSocket server.
 *
 * @returns The WebSocketServer instance and a function to get room count.
 */
export function createSignalingServer(
  manager: MediasoupManager,
  metrics: MetricsTracker,
  logger: Logger,
  turnContext?: TurnContext,
  interRelay?: InterRelayContext,
): {
  wss: WebSocketServer;
  getRoomCount: () => number;
  setAccepting: (accepting: boolean) => void;
  closeRooms: () => void;
} {
  const port = parseInt(process.env['WS_PORT'] ?? '4000', 10);
  const relayMode = (process.env['RELAY_MODE']?.toLowerCase() ?? 'sfu') as 'sfu' | 'mcu';

  // W5 M1 P5 (REQ-MCS-003): AudioLevelObserver tunables — PLACEHOLDER defaults
  // pending the P5/P9 tune (CONTRACTS.md C4). No hardcodes (feedback_no_hardcodes):
  // both are env knobs. interval ms ~800; threshold dBov ~−60; maxEntries fixed 1
  // (dominant speaker only) per C2.4.
  const audioObserverIntervalMs = parseInt(
    process.env['RELAY_AUDIO_LEVEL_INTERVAL_MS'] ?? '800',
    10,
  );
  const audioObserverThresholdDb = parseInt(
    process.env['RELAY_AUDIO_LEVEL_THRESHOLD_DB'] ?? '-60',
    10,
  );

  // W5 M1 P7 (REQ-MCS-005): server-side BWE backstop — cap per recv transport so
  // a client cannot request high simulcast layers for every tile and blow its
  // downlink. Applied on recvTransport only (NOT the send transport). Value is a
  // PLACEHOLDER pending the P9 bench (CONTRACTS.md C4); ~4 Mbps is a reasonable
  // starting floor for a 9-tile gallery at 720p speaker + 360p/180p thumbnails.
  // Set to 0 to disable the cap (opt-out; e.g. bench runs that intentionally
  // push max bitrate). Parsed once at server start; no hardcodes (feedback_no_hardcodes).
  const maxIncomingBitrate = parseInt(
    process.env['RELAY_MAX_INCOMING_BITRATE'] ?? '4000000',
    10,
  );

  // W5 M2 P1.0 (REQ-MCS-012): Zoom-equivalent brute-force defense knobs. Max
  // wrong-password attempts per roomId within the sliding window; once exceeded,
  // admission for that room is refused with a rate-limit error until the window
  // lapses. Env-tunable (no hardcodes, feedback_no_hardcodes); placeholders.
  const passwordMaxAttempts = parseInt(
    process.env['RELAY_PASSWORD_MAX_ATTEMPTS'] ?? '10',
    10,
  );
  const passwordWindowMs = parseInt(
    process.env['RELAY_PASSWORD_WINDOW_MS'] ?? '60000',
    10,
  );

  const rooms = new Map<string, RoomState>();
  /**
   * W5 M2 P1.0 (REQ-MCS-012, D-M2-18): per-room ADMISSION config (passwordHash),
   * co-located with `rooms`. Set by the first joiner (host); checked online for
   * every later joiner. NOT on-chain (D-M2-2). Cleaned when the room empties.
   */
  const roomConfigs = new Map<string, RoomConfig>();
  /**
   * W5 M2 P1.0 (REQ-MCS-012): per-roomId wrong-password attempt counters for the
   * brute-force rate-limiter. Cleaned when the room empties.
   */
  const passwordAttempts = new Map<string, AttemptRecord>();
  /** Track which room each WebSocket belongs to for cleanup. */
  const wsToRoom = new Map<WebSocket, { roomId: string; peerId: string }>();
  /** Per-room async lock for the "get or create" critical section in
   *  handleJoin. Without serialization, two peers arriving in the same
   *  Node tick both observe rooms.get(roomId) === undefined, both await
   *  manager.createRouter, both write rooms.set — second wins, the loser's
   *  Router is orphan and newProducer pushes never cross peers. Real fix
   *  for CI-18; replaces the 250 ms inter-join delay workaround in
   *  scripts/bench/mediasoup-client-harness.ts. */
  const roomCreationLocks = new Map<string, Promise<void>>();

  // F60 graceful shutdown (DOH-021): while draining we stop accepting NEW client
  // upgrades (setAccepting(false)). Inter-relay standby peers stay exempt so the
  // G3.2b warm-pipe link is not severed. Default true → normal operation unchanged.
  let accepting = true;

  // G3.2b: cross-daemon inter-relay auth. INTER_RELAY_TOKEN (when set) tags the
  // standby's inbound link; tagged peers are attached as the announce socket and
  // are the only sockets allowed to inject pipe-producer frames server-side.
  // Unset (single-host / in-process bench) → the gate is open (unchanged path).
  const interRelayToken = process.env['INTER_RELAY_TOKEN'] ?? '';
  const interRelayPeers = new WeakSet<WebSocket>();
  let attachedInterRelaySocket: WebSocket | null = null;

  const wss = new WebSocketServer({
    port,
    maxPayload: 64 * 1024,
    // Select the inter-relay subprotocol when a peer advertises it (a normal
    // client offers none → handleProtocols is not invoked). Identity signal
    // alongside the Bearer token; not the auth itself.
    handleProtocols: (protocols) =>
      protocols.has(INTER_RELAY_SUBPROTOCOL) ? INTER_RELAY_SUBPROTOCOL : false,
  });

  wss.on('connection', (ws: WebSocket, req) => {
    // G3.2b: identify inter-relay peers by their Bearer token (timingSafeEqual).
    // Computed once and reused for both the F60 stop-accept gate and the tagging
    // below. A client connects with NO Authorization header → untagged.
    const isInterRelay =
      interRelayToken !== '' &&
      isValidInterRelayToken(req.headers['authorization'], interRelayToken);

    // F60 stop-accept (DOH-021): once draining, refuse NEW client upgrades with
    // 1001 (going-away). Inter-relay peers are EXEMPT — closing a standby dial-in
    // would sever the G3.2b warm-pipe announce link (relay-overlap failover).
    // In normal operation (accepting === true) no client is ever rejected — the
    // client gate stays at dispatch, not the handshake.
    if (!accepting && !isInterRelay) {
      ws.close(1001);
      return;
    }

    // G3.2b: tag inter-relay peers → attach as the announce socket. Untagged
    // clients fall through; their server-side pipe-producer frames are dropped at
    // the dispatch gate.
    if (isInterRelay) {
      interRelayPeers.add(ws);
      if (attachedInterRelaySocket !== null) {
        // Single-box announce socket (per-room keying is the carry-forward): a
        // second tagged peer DISPLACES the first — announces now flow to the new
        // socket. Warn so a reconnect flap or an unexpected extra standby is
        // observable rather than silently re-pointing the announce stream.
        logger.warn('G3.2b: inter-relay peer re-attached, displacing the prior announce socket');
      }
      attachedInterRelaySocket = ws;
      interRelay?.attachPeerSocket?.(ws);
      logger.info('G3.2b: inter-relay peer connected + attached (tagged)');
    }

    logger.debug('New WebSocket connection');

    ws.on('message', async (data) => {
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(data.toString()) as SignalingMessage;
      } catch {
        logger.warn('Invalid JSON received on relay signaling');
        return;
      }

      try {
        await handleMessage(ws, msg);
      } catch (err) {
        logger.error({ err, type: msg.type }, 'Error handling signaling message');
        sendJson(ws, { type: 'error', message: 'Internal server error' });
      }
    });

    ws.on('close', () => {
      // G3.2b: detach the inter-relay announce socket when this tagged peer goes
      // away (single-box; only if it is still the attached one).
      if (attachedInterRelaySocket === ws) {
        attachedInterRelaySocket = null;
        interRelay?.attachPeerSocket?.(null);
      }
      handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
    });
  });

  wss.on('listening', () => {
    logger.info({ port, relayMode }, 'Relay signaling server listening');
  });

  async function handleMessage(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    switch (msg.type) {
      case 'join': {
        await handleJoin(ws, msg);
        break;
      }

      case 'createTransport': {
        await handleCreateTransport(ws, msg);
        break;
      }

      case 'connectTransport': {
        await handleConnectTransport(ws, msg);
        break;
      }

      case 'produce': {
        await handleProduce(ws, msg);
        break;
      }

      case 'consume': {
        await handleConsume(ws, msg);
        break;
      }

      case 'leave': {
        handleDisconnect(ws);
        break;
      }

      case 'pipe-producer': {
        handlePipeProducerAnnounce(msg, ws);
        break;
      }

      case 'setConsumerLayers': {
        await handleSetConsumerLayers(ws, msg);
        break;
      }

      case 'pauseConsumer': {
        await handlePauseConsumer(ws, msg);
        break;
      }

      case 'resumeConsumer': {
        await handleResumeConsumer(ws, msg);
        break;
      }

      case 'e2eeKeyBundle': {
        handleE2eeKeyBundle(ws, msg);
        break;
      }

      default: {
        logger.warn({ type: (msg as { type: string }).type }, 'Unknown signaling message type');
      }
    }
  }

  /**
   * G1 STANDBY side — record an inbound inter-relay producer announce.
   * The primary pushes these so the standby can resolve the real producerId
   * for its warm pipe + for client consume requests that omit producerId.
   */
  function handlePipeProducerAnnounce(msg: PipeProducerMessage, ws: WebSocket): void {
    if (!interRelay) {
      logger.debug('Received pipe-producer announce but no InterRelayContext — ignoring');
      return;
    }
    // G3.2b dispatch gate: with INTER_RELAY_TOKEN set, only a tagged inter-relay
    // peer may inject a server-side announce (an unauthed client cannot poison
    // the standby registry — the original threat). Token unset → gate open.
    if (interRelayToken !== '' && !interRelayPeers.has(ws)) {
      logger.warn(
        { roomId: msg.roomId },
        'G3.2b: dropping pipe-producer from untagged (non-inter-relay) socket',
      );
      return;
    }
    if (!isPipeProducerAnnounce(msg)) {
      logger.warn({ msg }, 'Malformed pipe-producer announce — ignoring');
      return;
    }
    interRelay.registry.record(msg);
    logger.info(
      { roomId: msg.roomId, producerId: msg.producerId, kind: msg.kind },
      'Inter-relay: recorded announced pipe producer (standby)',
    );
  }

  async function handleJoin(ws: WebSocket, msg: JoinMessage): Promise<void> {
    const { roomId, peerId } = msg;

    // CI-18 real fix: serialize the ENTIRE admission critical section per-room.
    // If another join is already in flight for this roomId, await its completion
    // before reading rooms/roomConfigs. W5 M2 P1.0 (REQ-MCS-012): this same lock
    // makes "first-joiner-sets-the-password" race-safe — two peers arriving in
    // the same Node tick can't both observe "no passwordHash" and both become
    // host (mirrors the original CI-18 router-orphan race).
    const pending = roomCreationLocks.get(roomId);
    if (pending) await pending;

    let release!: () => void;
    const creation = new Promise<void>((resolve) => {
      release = resolve;
    });
    roomCreationLocks.set(roomId, creation);

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
        if (isRateLimited(roomId)) {
          sendJson(ws, { type: 'error', message: 'Too many attempts — rate limited' });
          logger.warn({ roomId, peerId }, 'Admission rejected: room rate-limited (brute-force defense)');
          return; // released in finally
        }

        // 3) First-joiner-sets-it password gate (host model, decision #3). The
        //    plaintext password is NEVER logged or stored — only its hash.
        const config = roomConfigs.get(roomId);
        if (!config) {
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
          roomConfigs.set(roomId, {
            passwordHash: hashRoomPassword(msg.roomPassword),
            e2ee: msg.e2ee === true,
          });
          logger.info(
            { roomId, peerId, e2ee: msg.e2ee === true },
            'Room password + E2EE mode SET by first joiner (host)',
          );
        } else {
          // Later joiner: must match the host-set passwordHash.
          if (hashRoomPassword(msg.roomPassword) !== config.passwordHash) {
            recordFailedAttempt(roomId);
            sendJson(ws, { type: 'error', message: 'Incorrect room password' });
            logger.warn({ roomId, peerId }, 'Admission rejected: incorrect room password');
            return; // released in finally — NO router/room/transport created
          }
          // Correct password → reset the brute-force counter for this room.
          passwordAttempts.delete(roomId);
        }
        sessionPubkey = validPubkey;
      }

      // ── Admission passed (or legacy path). Get-or-create the room. ──
      const existing = rooms.get(roomId);
      if (existing) {
        room = existing;
      } else {
        const roomMode = msg.mode ?? relayMode;
        const worker = manager.getNextWorker();
        const router = await manager.createRouter(worker);
        room = {
          roomId,
          router,
          mode: roomMode,
          peers: new Map(),
        };

        // Initialize MCU pipeline for MCU rooms
        if (roomMode === 'mcu') {
          room.mcuPipeline = new McuPipeline(router, logger);
          logger.info({ roomId }, 'MCU pipeline initialized for room');
        }

        rooms.set(roomId, room);
        logger.info({ roomId, mode: roomMode }, 'Room created');

        // W5 M1 P5 (REQ-MCS-003): attach one AudioLevelObserver per router.
        // maxEntries:1 → only the dominant speaker. On `volumes` the relay maps
        // the dominant producerId → peerId and BROADCASTS `activeSpeaker` to all
        // room peers (it only REPORTS — the client reacts with setConsumerLayers,
        // CONTRACTS.md C0/C2.4). Best-effort: a creation failure must not break
        // room setup, so the observer stays optional and every use is guarded.
        await attachAudioLevelObserver(room);

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
      roomCreationLocks.delete(roomId);
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
    wsToRoom.set(ws, { roomId, peerId });

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
    const e2ee = roomConfigs.get(roomId)?.e2ee ?? false;
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

  /**
   * W5 M2 P1.0 (REQ-MCS-012): is this room currently locked out for too many
   * wrong-password attempts within the sliding window? A lapsed window resets
   * the counter implicitly (the record is treated as fresh on the next failure).
   */
  function isRateLimited(roomId: string): boolean {
    const rec = passwordAttempts.get(roomId);
    if (!rec) return false;
    if (Date.now() - rec.windowStart >= passwordWindowMs) {
      // Window lapsed — clear so the next attempt starts a fresh window.
      passwordAttempts.delete(roomId);
      return false;
    }
    return rec.count >= passwordMaxAttempts;
  }

  /**
   * W5 M2 P1.0 (REQ-MCS-012): record a wrong-password attempt against a room,
   * starting (or rolling) the sliding window. NEVER logs the attempted password.
   */
  function recordFailedAttempt(roomId: string): void {
    const now = Date.now();
    const rec = passwordAttempts.get(roomId);
    if (!rec || now - rec.windowStart >= passwordWindowMs) {
      passwordAttempts.set(roomId, { count: 1, windowStart: now });
      return;
    }
    rec.count += 1;
  }

  /**
   * W5 M2 P4 (REQ-MCS-012, transport half) — BLIND broadcast of the coordinator's
   * sealed `e2eeKeyBundle` to the OTHER members of the SENDER's room (CONTRACTS.md
   * §1, FROZEN; SEQUENCES.md §1). Signaling is BLIND transport: it FORWARDS the
   * whole opaque bundle as-is, recipient-oblivious — it never holds/derives/decrypts
   * a key, never routes per-recipient, and NEVER logs `sealedKey` / envelope
   * contents (only { kid, epoch, roomId, envelopeCount, recipientCount }).
   *
   * Room is derived from the WS (the `wsToRoom` mapping), NOT trusted from
   * `msg.roomId` — the same resolution every other handler uses (handleProduce
   * et al). A spoofed `roomId` (≠ the sender's room) is ignored + warned so a
   * peer cannot inject into another room. A sender not in any room is ignored.
   */
  function handleE2eeKeyBundle(ws: WebSocket, msg: E2EEKeyBundleMessage): void {
    const mapping = wsToRoom.get(ws);
    if (!mapping) {
      // Sender never joined a room — ignore (no throw). Mirrors handleProduce.
      logger.warn('e2eeKeyBundle from a peer not in any room — ignoring');
      return;
    }

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    // Anti-spoof: the room is the SENDER's room (from the ws), not msg.roomId. A
    // mismatch is a peer trying to inject into another room → ignore + warn (the
    // bundle is NOT broadcast anywhere).
    if (msg.roomId !== mapping.roomId) {
      logger.warn(
        { senderRoomId: mapping.roomId, claimedRoomId: msg.roomId, peerId: mapping.peerId },
        'e2eeKeyBundle roomId mismatch (spoof attempt) — ignoring',
      );
      return;
    }

    // Defensive: a malformed bundle (missing/non-array `envelopes`) is dropped
    // cleanly — ignore + warn — mirroring the guards above, rather than
    // half-broadcasting a junk `envelopes:undefined` frame and THEN throwing on
    // `.length`. The only possible sender is an admitted in-room peer (post
    // password gate); a malformed frame should degrade quietly, not error-reply.
    if (!Array.isArray(msg.envelopes)) {
      logger.warn(
        { roomId: mapping.roomId, peerId: mapping.peerId },
        'e2eeKeyBundle missing/invalid envelopes — ignoring',
      );
      return;
    }

    // Broadcast the WHOLE bundle as-is to every OTHER peer (recipient-oblivious;
    // NO per-recipient filtering/fan-out). Reuses the per-room peer-iteration
    // idiom + sendJson (which guards readyState===OPEN). Opaque forward — the
    // envelopes are passed through byte-for-byte.
    let recipientCount = 0;
    for (const [existingPeerId, existingPeer] of room.peers) {
      if (existingPeerId === mapping.peerId) continue; // skip self — no echo
      sendJson(existingPeer.ws, {
        type: 'e2eeKeyBundle',
        roomId: msg.roomId,
        epoch: msg.epoch,
        kid: msg.kid,
        coordinatorPubkey: msg.coordinatorPubkey,
        envelopes: msg.envelopes,
      });
      recipientCount += 1;
    }

    // Logging discipline (CONTRACTS.md §1 / ROADMAP HARD-GATE): KID/epoch/roomId +
    // COUNTS only — NEVER the sealedKey or any envelope contents.
    logger.info(
      { kid: msg.kid, epoch: msg.epoch, roomId: msg.roomId, envelopeCount: msg.envelopes.length, recipientCount },
      'Broadcast e2eeKeyBundle (blind)',
    );
  }

  async function handleCreateTransport(ws: WebSocket, msg: CreateTransportMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) {
      sendJson(ws, { type: 'error', message: 'Not in a room' });
      return;
    }

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) {
      sendJson(ws, { type: 'error', message: 'Room or peer not found' });
      return;
    }

    const transport = await createWebRtcTransport(room.router, logger);

    if (msg.direction === 'send') {
      peer.sendTransport = transport;
    } else {
      peer.recvTransport = transport;
      // W5 M1 P7 (REQ-MCS-005): apply the BWE backstop cap on the receive transport
      // ONLY (the consuming side). Server-internal — not a wire message (CONTRACTS.md C0).
      // Guard: skip when cap is 0 (opt-out) or NaN (invalid env value).
      if (maxIncomingBitrate > 0) {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate);
        logger.debug(
          { transportId: transport.id, maxIncomingBitrate, peerId: mapping.peerId },
          'recv transport BWE backstop cap applied',
        );
      }
    }

    // S23.1.A1: start a latency-probe sampler on this transport when
    // BENCH_LATENCY=1. Probe is null otherwise — zero-cost branch.
    const probe = ensureRelayProbe(logger);
    if (probe !== null) {
      const stop = probe.startSampler(transport, {
        roomId: mapping.roomId,
        peerId: mapping.peerId,
        transportId: transport.id,
      });
      peer.samplerStops.set(transport.id, stop);
    }

    let iceServers:
      | Array<{ urls: string | string[]; username?: string; credential?: string }>
      | undefined;
    if (turnContext) {
      try {
        const built = await turnContext.buildIceServers(mapping.peerId);
        if (built !== null) iceServers = built;
      } catch (err) {
        logger.warn(
          { err, peerId: mapping.peerId },
          'TURN credential fetch failed; sending transportCreated without iceServers',
        );
      }
    }

    sendJson(ws, {
      type: 'transportCreated',
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      ...(iceServers ? { iceServers } : {}),
    });

    logger.debug(
      { transportId: transport.id, direction: msg.direction, peerId: mapping.peerId },
      'Transport created',
    );
  }

  async function handleConnectTransport(ws: WebSocket, msg: ConnectTransportMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    // Find the transport by ID
    const transport =
      peer.sendTransport?.id === msg.transportId
        ? peer.sendTransport
        : peer.recvTransport?.id === msg.transportId
          ? peer.recvTransport
          : null;

    if (!transport) {
      sendJson(ws, { type: 'error', message: 'Transport not found' });
      return;
    }

    await transport.connect({ dtlsParameters: msg.dtlsParameters });

    logger.debug(
      { transportId: msg.transportId, peerId: mapping.peerId },
      'Transport connected',
    );
  }

  async function handleProduce(ws: WebSocket, msg: ProduceMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer || !peer.sendTransport) {
      sendJson(ws, { type: 'error', message: 'No send transport' });
      return;
    }

    const producer = await peer.sendTransport.produce({
      kind: msg.kind,
      rtpParameters: msg.rtpParameters,
    });

    peer.producers.push(producer);

    // W5 M1 P5 (REQ-MCS-003): register AUDIO producers with the room's
    // AudioLevelObserver so it can surface the dominant speaker. Guarded on the
    // observer existing (undefined when attach failed / MCU). mediasoup auto-
    // detaches a producer from the observer when the producer closes (removePeer
    // → producer.close()), so no explicit removeProducer is required here; we
    // defensively removeProducer on the close event regardless.
    if (msg.kind === 'audio' && room.audioLevelObserver) {
      try {
        await room.audioLevelObserver.addProducer({ producerId: producer.id });
        producer.on('@close', () => {
          room.audioLevelObserver
            ?.removeProducer({ producerId: producer.id })
            .catch(() => {
              /* observer/producer already gone — auto-detached; ignore */
            });
        });
      } catch (err) {
        logger.warn(
          { roomId: mapping.roomId, producerId: producer.id, err: (err as Error).message },
          'AudioLevelObserver.addProducer failed — speaker detection skips this producer',
        );
      }
    }

    sendJson(ws, {
      type: 'produced',
      producerId: producer.id,
    });

    // Notify all other peers about the new producer (SFU fan-out)
    await notifyNewProducer(room, mapping.peerId, producer, logger);

    // G1 PRIMARY side — announce this producer to the paired standby so it can
    // resolve the real producerId for its warm pipe + client consume requests.
    // Only the primary announces (the standby is the consumer of announces).
    if (interRelay && interRelay.role === 'primary') {
      interRelay.announceProducer(mapping.roomId, producer);
      logger.info(
        { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId },
        'Inter-relay: announced producer to standby (primary)',
      );
    }

    logger.info(
      { producerId: producer.id, kind: msg.kind, peerId: mapping.peerId, roomId: mapping.roomId },
      'Producer created',
    );
  }

  async function handleConsume(ws: WebSocket, msg: ConsumeMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    // G1 client-consume reconciliation. dev-fe's client sends
    // `{ type:'consume', rtpCapabilities }` to the STANDBY relay WITHOUT a
    // producerId, expecting the standby to resolve the piped producer from room
    // context. We resolve from the inter-relay announce registry. On the PRIMARY
    // (or when the client did supply a producerId) the explicit producerId is used.
    let producerId = msg.producerId;
    if (!producerId && interRelay) {
      const announced = interRelay.registry.resolve(mapping.roomId);
      if (announced) {
        producerId = announced.producerId;
        logger.debug(
          { roomId: mapping.roomId, producerId, peerId: mapping.peerId },
          'Inter-relay: resolved piped producer from room context for client consume (standby)',
        );
      }
    }

    if (!producerId) {
      // No producerId supplied and none announced yet — standby not ready.
      sendJson(ws, { type: 'error', message: 'No producer available for room yet' });
      logger.warn(
        { roomId: mapping.roomId, peerId: mapping.peerId },
        'Consume request without producerId and no announced producer — standby not ready',
      );
      return;
    }

    const consumer = await createConsumer(room, peer, producerId, msg.rtpCapabilities, logger);
    if (!consumer) {
      sendJson(ws, { type: 'error', message: 'Cannot consume producer' });
      return;
    }

    sendJson(ws, {
      type: 'consumed',
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });

    logger.debug(
      { consumerId: consumer.id, producerId, peerId: mapping.peerId },
      'Consumer created for peer',
    );
  }

  /**
   * W5 M1 (REQ-MCS-002) — apply a client-requested simulcast layer preference.
   *
   * `consumer.setPreferredLayers(...)` is a SERVER-SIDE mediasoup call
   * (CONTRACTS.md C0): the client only *requests* it over the wire; the relay
   * looks up the stored Consumer on the peer (`peer.consumers`, pushed in
   * createConsumer at room-handler.ts:189) by `consumerId` and applies it.
   *
   * Omit-semantics (C2.1): when `temporalLayer` is absent the relay passes only
   * `{ spatialLayer }`, keeping the consumer's current temporal layer. An unknown
   * `consumerId` is logged and ignored — it must not throw / crash the WS loop.
   *
   * W5 M2 P5 — RELAY BLIND-FORWARD INVARIANT (REQ-MCS-011): layer-select coexists
   * with E2EE. SFrame keeps layer + KID metadata in the CLEARTEXT RTP/SFrame
   * header (RFC 9605 §4.4.3, CONTRACTS.md §2), so this server-side
   * `setPreferredLayers` switches simulcast spatial layers over CIPHERTEXT
   * payloads WITHOUT decoding them — the relay reads only the header. No payload
   * decode/decrypt path exists here (proven by the relay-blind invariant test).
   */
  async function handleSetConsumerLayers(
    ws: WebSocket,
    msg: SetConsumerLayersMessage,
  ): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    const consumer = peer.consumers.find((c) => c.id === msg.consumerId);
    if (!consumer) {
      logger.warn(
        { consumerId: msg.consumerId, peerId: mapping.peerId, roomId: mapping.roomId },
        'setConsumerLayers for unknown consumerId — ignoring',
      );
      return;
    }

    const preferredLayers =
      msg.temporalLayer === undefined
        ? { spatialLayer: msg.spatialLayer }
        : { spatialLayer: msg.spatialLayer, temporalLayer: msg.temporalLayer };

    await consumer.setPreferredLayers(preferredLayers);

    logger.debug(
      {
        consumerId: msg.consumerId,
        peerId: mapping.peerId,
        spatialLayer: msg.spatialLayer,
        temporalLayer: msg.temporalLayer,
      },
      'Applied setPreferredLayers for consumer',
    );
  }

  /**
   * W5 M1 P6 (REQ-MCS-004): pause a consumer so the peer's off-page tile
   * forwards RTCP only (~0 media bytes). Unknown consumerId → warn + ignore
   * (mirrors setConsumerLayers unknown-id handling). CONTRACTS.md C2.2.
   */
  async function handlePauseConsumer(ws: WebSocket, msg: PauseConsumerMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    const consumer = peer.consumers.find((c) => c.id === msg.consumerId);
    if (!consumer) {
      logger.warn(
        { consumerId: msg.consumerId, peerId: mapping.peerId, roomId: mapping.roomId },
        'pauseConsumer for unknown consumerId — ignoring',
      );
      return;
    }

    await consumer.pause();

    logger.debug(
      { consumerId: msg.consumerId, peerId: mapping.peerId },
      'Paused consumer (off-page tile)',
    );
  }

  /**
   * W5 M1 P6 (REQ-MCS-004): resume a consumer so the peer's on-page tile
   * restarts RTP. Unknown consumerId → warn + ignore (mirrors setConsumerLayers
   * unknown-id handling). CONTRACTS.md C2.3.
   */
  async function handleResumeConsumer(ws: WebSocket, msg: ResumeConsumerMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    const consumer = peer.consumers.find((c) => c.id === msg.consumerId);
    if (!consumer) {
      logger.warn(
        { consumerId: msg.consumerId, peerId: mapping.peerId, roomId: mapping.roomId },
        'resumeConsumer for unknown consumerId — ignoring',
      );
      return;
    }

    await consumer.resume();

    logger.debug(
      { consumerId: msg.consumerId, peerId: mapping.peerId },
      'Resumed consumer (on-page tile)',
    );
  }

  /**
   * W5 M1 P5 (REQ-MCS-003): create one AudioLevelObserver for the room's router
   * and wire its `volumes` event to an `activeSpeaker` broadcast. maxEntries:1 →
   * only the dominant speaker is reported. Best-effort: any failure is logged and
   * leaves `room.audioLevelObserver` undefined (the produce-side addProducer + the
   * broadcast are both guarded on its presence).
   */
  async function attachAudioLevelObserver(room: RoomState): Promise<void> {
    try {
      const observer = await room.router.createAudioLevelObserver({
        maxEntries: 1,
        threshold: audioObserverThresholdDb,
        interval: audioObserverIntervalMs,
      });
      room.audioLevelObserver = observer;

      observer.on('volumes', (volumes) => {
        const dominant = volumes[0];
        if (!dominant) return;
        const dominantProducerId = dominant.producer.id;

        // Map producerId → peerId via the room's peer→producers structure.
        let speakerPeerId: string | undefined;
        for (const [peerId, peer] of room.peers) {
          if (peer.producers.some((p) => p.id === dominantProducerId)) {
            speakerPeerId = peerId;
            break;
          }
        }
        if (!speakerPeerId) {
          logger.debug(
            { roomId: room.roomId, producerId: dominantProducerId },
            'activeSpeaker: dominant producerId not mapped to a peer — skipping broadcast',
          );
          return;
        }

        // Broadcast to ALL peers in the room (existing fan-out idiom).
        for (const [, peer] of room.peers) {
          sendJson(peer.ws, { type: 'activeSpeaker', peerId: speakerPeerId });
        }
        logger.debug(
          { roomId: room.roomId, peerId: speakerPeerId },
          'activeSpeaker broadcast',
        );
      });

      observer.on('silence', () => {
        logger.debug({ roomId: room.roomId }, 'activeSpeaker: room silent');
      });

      logger.info(
        {
          roomId: room.roomId,
          intervalMs: audioObserverIntervalMs,
          thresholdDb: audioObserverThresholdDb,
        },
        'AudioLevelObserver attached',
      );
    } catch (err) {
      logger.warn(
        { roomId: room.roomId, err: (err as Error).message },
        'AudioLevelObserver attach failed — active-speaker disabled for this room',
      );
    }
  }

  async function handleDisconnect(ws: WebSocket): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const { roomId, peerId } = mapping;
    const room = rooms.get(roomId);

    if (room) {
      await removePeer(room, peerId, logger);
      metrics.clearSession(roomId, peerId);

      // Clean up empty rooms
      if (room.peers.size === 0) {
        // Close MCU pipeline if active
        if (room.mcuPipeline) {
          await room.mcuPipeline.close();
          logger.info({ roomId }, 'MCU pipeline closed for room');
        }
        room.router.close();
        rooms.delete(roomId);
        metrics.clearRoom(roomId);
        // G1: drop the inter-relay announce records for this room (standby side).
        interRelay?.registry.clear(roomId);
        // W5 M2 P1.0 (REQ-MCS-012): drop the room ADMISSION config + rate-limiter
        // so a reused roomId starts fresh (first-joiner-sets-it again). The
        // per-peer sessionPubkey roster is already gone (removePeer dropped the
        // PeerState).
        roomConfigs.delete(roomId);
        passwordAttempts.delete(roomId);
        logger.info({ roomId }, 'Room closed (no peers remaining)');
      }
    }

    wsToRoom.delete(ws);
    logger.info({ roomId, peerId }, 'Peer disconnected from relay');
  }

  /**
   * F60 (DOH-021): flip the stop-accept gate. `setAccepting(false)` makes the
   * connection handler refuse NEW non-inter-relay upgrades (1001). Synchronous;
   * P8 calls it first in the graceful-shutdown sequence (runGracefulShutdown).
   */
  function setAccepting(next: boolean): void {
    accepting = next;
  }

  /**
   * F60 (DOH-021): force-close the remaining CLIENT peer sockets. Iterates
   * `wsToRoom.keys()` (only peers that have joined a room; inter-relay peers
   * never `join` → auto-exempt) and closes each with 1001. The existing
   * `ws.on('close')` → `handleDisconnect` does the room teardown — no double-free.
   */
  function closeRooms(): void {
    for (const ws of wsToRoom.keys()) {
      ws.close(1001);
    }
  }

  return {
    wss,
    getRoomCount: () => rooms.size,
    setAccepting,
    closeRooms,
  };
}
