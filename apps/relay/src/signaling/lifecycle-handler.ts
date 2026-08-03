/**
 * Connection lifecycle: the `wss.on('connection', ...)` accept body
 * (inter-relay handshake tagging + re-fan-on-attach, F60 stop-accept gate,
 * per-socket message/close/error wiring) and peer/room teardown on
 * disconnect.
 *
 * Requirements: RELAY-05
 */

import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import type { MetricsTracker } from '../metrics.js';
import type { PeerStatsWindow } from '../stats-window.js';
import { removePeer } from '../room-handler.js';
import {
  isValidInterRelayToken,
  DEFAULT_PEER_RELAY_ID,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import { resolveInterRelayPeerId } from '../inter-relay-socket-map.js';
import { sendJson } from './helpers.js';
import type { SignalingMessage } from './messages.js';
import type { SignalingServerState, InterRelayContext } from './state.js';

/**
 * F60 (DOH-021): flip the stop-accept gate. `setAccepting(false)` makes the
 * connection handler refuse NEW non-inter-relay upgrades (1001). Synchronous;
 * P8 calls it first in the graceful-shutdown sequence (runGracefulShutdown).
 */
export function setAccepting(state: SignalingServerState, next: boolean): void {
  state.accepting = next;
}

/**
 * F60 (DOH-021): force-close the remaining CLIENT peer sockets. Iterates
 * `wsToRoom.keys()` (only peers that have joined a room; inter-relay peers
 * never `join` → auto-exempt) and closes each with 1001. The existing
 * `ws.on('close')` → `handleDisconnect` does the room teardown — no double-free.
 */
export function closeRooms(state: SignalingServerState): void {
  for (const ws of state.wsToRoom.keys()) {
    ws.close(1001);
  }
}

export async function handleDisconnect(
  state: SignalingServerState,
  ws: WebSocket,
  metrics: MetricsTracker,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
  /**
   * Call-quality feature: the SAME `PeerStatsWindow` instance passed to
   * `startMetricsServer` (index.ts) — cleared here so a disconnected peer's
   * client-reported stats stop showing up in every future scrape/scenario
   * snapshot instead of lingering until the relay process restarts. Optional
   * ⇒ every pre-existing ≤5-arg call site/test is unaffected (no-op cleanup).
   */
  statsWindow?: PeerStatsWindow,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const { roomId, peerId } = mapping;
  const room = state.rooms.get(roomId);

  if (room) {
    await removePeer(room, peerId, logger);
    metrics.clearSession(roomId, peerId);
    statsWindow?.clear(peerId);

    // Clean up empty rooms
    if (room.peers.size === 0) {
      // Close MCU pipeline if active
      if (room.mcuPipeline) {
        await room.mcuPipeline.close();
        logger.info({ roomId }, 'MCU pipeline closed for room');
      }
      room.router.close();
      state.rooms.delete(roomId);
      // REQ-RMS-036 (part-3 reverse leg): drop the per-room origin registry so a
      // reused roomId starts fresh (mirror rooms.delete; per-producer cleanup
      // already fires on each minted producer's '@close').
      state.originRegistry.delete(roomId);
      metrics.clearRoom(roomId);
      // G1: drop ALL inter-relay announce buckets (room-wide; clearRoom not clear --
      // per-peer reverse buckets, REQ-RMS-036).
      interRelay?.registry.clearRoom(roomId);
      // F1 (REQ-RO-009): release this room's pipe ports + coordinator state so a
      // reused roomId starts fresh and the [min..max] range does not leak.
      interRelay?.releaseRoom?.(roomId);
      // W5 M2 P1.0 (REQ-MCS-012): drop the room ADMISSION config + rate-limiter
      // so a reused roomId starts fresh (first-joiner-sets-it again). The
      // per-peer sessionPubkey roster is already gone (removePeer dropped the
      // PeerState).
      state.roomConfigs.delete(roomId);
      state.passwordAttempts.delete(roomId);
      logger.info({ roomId }, 'Room closed (no peers remaining)');
    }
  }

  state.wsToRoom.delete(ws);
  logger.info({ roomId, peerId }, 'Peer disconnected from relay');
}

/**
 * The `wss.on('connection', ...)` accept body: G3.2b inter-relay handshake
 * detection/tagging + the REQ-RMS-037 re-fan-on-attach, the F60 stop-accept
 * gate, and per-socket `message`/`close`/`error` wiring. `dispatch` is the
 * index.ts-owned `handleMessage` switch — kept out of this module so lifecycle
 * wiring stays decoupled from the full handler set.
 */
export function handleConnection(
  state: SignalingServerState,
  ws: WebSocket,
  req: IncomingMessage,
  interRelayToken: string,
  metrics: MetricsTracker,
  interRelay: InterRelayContext | undefined,
  dispatch: (ws: WebSocket, msg: SignalingMessage) => Promise<void>,
  logger: Logger,
): void {
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
  if (!state.accepting && !isInterRelay) {
    ws.close(1001);
    return;
  }

  // G3.2b: tag inter-relay peers → attach as the announce socket. Untagged
  // clients fall through; their server-side pipe-producer frames are dropped at
  // the dispatch gate.
  if (isInterRelay) {
    state.interRelayPeers.add(ws);
    if (state.attachedInterRelaySocket !== null) {
      // Single-box announce socket (per-room keying is the carry-forward): a
      // second tagged peer DISPLACES the first — announces now flow to the new
      // socket. Warn so a reconnect flap or an unexpected extra standby is
      // observable rather than silently re-pointing the announce stream.
      logger.warn('G3.2b: inter-relay peer re-attached, displacing the prior announce socket');
    }
    state.attachedInterRelaySocket = ws;
    // REQ-RMS-008: ALSO attach into the per-peer map under the cascade peerRelayId
    // (default sentinel when the upgrade carries no x-inter-relay-peer-id — the M1
    // single-standby path). Additive: the legacy attachedInterRelaySocket above is
    // untouched, so the default-peer announce stream is byte-unchanged.
    const peerRelayId = resolveInterRelayPeerId(req.headers, DEFAULT_PEER_RELAY_ID);
    state.interRelaySockets.attach(peerRelayId, ws as unknown as InterRelaySocketLike);
    interRelay?.attachPeerSocket?.(ws);
    logger.info({ peerRelayId }, 'G3.2b: inter-relay peer connected + attached (tagged)');

    // REQ-RMS-037 (Task B4b) — RE-FAN-ON-ATTACH. The handleProduce fanout only
    // reaches inter-relay peers attached AT produce time; a standby that attaches
    // AFTER the primary already has producers would otherwise never receive them.
    // For every room this relay is PRIMARY of, re-announce existing producers DOWN
    // to JUST this newly-attached peer (NEVER a re-broadcast to already-synced
    // peers — we target peerRelayId, not interRelaySockets.keys()), reusing the
    // forward onPrimaryProducer hook (DRY-1, no new pipe path). The iteration
    // mirrors handleJoin's room.peers[*].producers shape.
    // MULTI-ROOM CARRY-FORWARD: this iterates ALL `rooms` and targets the
    // per-DAEMON `interRelaySockets` peer (peerRelayId), NOT a per-(room,peer)
    // membership — fine under the single-room demo scope (every attached peer is a
    // standby of this room), but a per-(room,peer) filter is needed before
    // multi-room (out-of-scope for part-3). Mirrors the same caveat on
    // registerReverseMinted + the handleProduce fanout.
    if (interRelay && interRelay.role === 'primary') {
      for (const [reRoomId, reRoom] of state.rooms) {
        // 3a(i) eager reverse leg (defense-in-depth): create this peer's reverse
        // pipe leg even if the primary never produced, so a pure-reverse room
        // (media only on the standby) still forms its leg before the first
        // reverse announce. Optional hook — a no-op on the in-process bench.
        // CONTAINED: ensureReverseLeg does real mediasoup transport create+connect;
        // apps/relay has NO global unhandledRejection handler, so a bare `void` on a
        // rejecting promise would terminate the process — .catch + warn instead.
        void interRelay.ensureReverseLeg?.(reRoomId, reRoom.router, peerRelayId)
          ?.catch((err) =>
            logger.warn({ err, roomId: reRoomId, peerRelayId }, 'REQ-RMS-037: eager reverse-leg failed'),
          );
        // 3a(ii) [LOAD-BEARING]: re-announce existing LOCAL producers DOWN to the
        // new peer. producerPeerId = the local owner so a cross-relay consume binds
        // the stream/E2EE-key to the real publisher, not the relayId (REQ-RMS-029).
        for (const [ownerPeerId, ownerPeer] of reRoom.peers) {
          for (const producer of ownerPeer.producers) {
            interRelay.onPrimaryProducer?.(reRoomId, reRoom.router, producer, peerRelayId, ownerPeerId);
          }
        }
        // 3a(ii) reverse-minted: also re-announce the hub copies of OTHER standbys'
        // streams DOWN to the new peer, EXCLUDING any whose origin IS this peer
        // (never echo a producer back to its own origin, REQ-RMS-036). The live
        // minted Producer is held in the originRegistry entry (recorded at mint
        // time), so it resolves without fabricating a handle.
        const originBucket = state.originRegistry.get(reRoomId);
        if (originBucket) {
          for (const entry of originBucket.values()) {
            if (entry.originRelayId === peerRelayId) continue; // REQ-RMS-036 — no echo to origin
            if (entry.producer.closed) continue; // defense-in-depth: a missed '@close' must never replay a dead handle to the new peer
            interRelay.onPrimaryProducer?.(reRoomId, reRoom.router, entry.producer, peerRelayId, entry.producerPeerId);
          }
        }
      }
      logger.info(
        { peerRelayId },
        'REQ-RMS-037: re-fanned existing producers DOWN to the newly-attached inter-relay peer',
      );
    }
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
      await dispatch(ws, msg);
    } catch (err) {
      logger.error({ err, type: msg.type }, 'Error handling signaling message');
      sendJson(ws, { type: 'error', message: 'Internal server error' });
    }
  });

  ws.on('close', () => {
    // G3.2b: detach the inter-relay announce socket when this tagged peer goes
    // away (single-box; only if it is still the attached one).
    if (state.attachedInterRelaySocket === ws) {
      state.attachedInterRelaySocket = null;
      interRelay?.attachPeerSocket?.(null);
    }
    // REQ-RMS-008: detach from the per-peer map under the SAME resolver — only
    // this peer's leg is removed (multi-peer cascade), and the guarded detach is
    // a no-op if a reconnect flap already replaced this socket (stale close).
    const closingPeerId = resolveInterRelayPeerId(req.headers, DEFAULT_PEER_RELAY_ID);
    state.interRelaySockets.detach(closingPeerId, ws as unknown as InterRelaySocketLike);
    void handleDisconnect(state, ws, metrics, interRelay, logger);
  });

  ws.on('error', (err) => {
    logger.error({ err }, 'WebSocket error');
  });
}
