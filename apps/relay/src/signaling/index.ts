/**
 * WebSocket server for mediasoup client-relay signaling.
 *
 * Protocol: JSON messages over WebSocket for mediasoup transport negotiation.
 * Manages rooms, peers, transports, producers, and consumers.
 *
 * This is the thin wiring entrypoint: it builds config + a SignalingServerState,
 * sets up the WebSocketServer, wires `wss.on('connection', ...)` (lifecycle-
 * handler.ts) to a `handleMessage` dispatcher that routes into the extracted
 * per-concern handlers, and returns the same public API the original
 * monolithic `signaling.ts` returned. Also the barrel for this directory:
 * `TurnContext` / `InterRelayContext` are DEFINED in `./state.ts` (to avoid a
 * circular import between this file and the handlers that need those types)
 * and RE-EXPORTED here.
 *
 * Requirements: RELAY-05
 */

import { WebSocketServer, WebSocket } from 'ws';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import type { MediasoupManager } from '../mediasoup-manager.js';
import type { MetricsTracker } from '../metrics.js';
import type { PeerStatsWindow } from '../stats-window.js';
import type { RoomState } from '../room-handler.js';
import { INTER_RELAY_SUBPROTOCOL } from '@dvconf/inter-relay-client';
import type { InterRelaySocketMap } from '../inter-relay-socket-map.js';
import { createSpillTrigger, type SpillTrigger } from '../spill-trigger.js';
import { recordRtcQuality } from '../rtc-quality-metrics.js';
import type { SignalingMessage } from './messages.js';
import {
  createSignalingServerState,
  getRoom as getRoomState,
  type SignalingServerState,
  type SignalingConfig,
  type TurnContext,
  type InterRelayContext,
} from './state.js';
import { handleJoin } from './join-handler.js';
import { ensureRoomPrewarmed } from '../room-prewarm.js';
import { handleE2eeKeyBundle } from './e2ee-handler.js';
import {
  handleCreateTransport,
  handleConnectTransport,
  handleProduce,
  handleConsume,
  handleSetConsumerLayers,
  handlePauseConsumer,
  handleResumeConsumer,
} from './media-handler.js';
import {
  handlePipeProducerAnnounce,
  handlePipeConnect,
  fanLocalProducer as fanLocalProducerImpl,
  registerReverseMinted as registerReverseMintedImpl,
  reannounceLocalProducersUp as reannounceLocalProducersUpImpl,
} from './pipe-handler.js';
import {
  handleConnection,
  handleDisconnect,
  setAccepting as setAcceptingImpl,
  closeRooms as closeRoomsImpl,
} from './lifecycle-handler.js';

export type { TurnContext, InterRelayContext };

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
  /**
   * REQ-RMS-028 (L1.3-b, Bridge A) — the per-peer inter-relay socket map, OWNED by
   * the wiring layer (index.ts) so the PRIMARY's per-peer announce/param send and
   * this server's tagged-peer attach share ONE map. Optional: absent ⇒ a fresh
   * internal map (every existing ≤5-arg call site + test is unchanged).
   */
  providedSockets?: InterRelaySocketMap,
  /**
   * Call-quality feature: shared with `startMetricsServer` (index.ts) so a
   * peer's cached quality stats are cleared on disconnect (handleDisconnect
   * below) instead of lingering in Prometheus forever. Optional ⇒ every
   * existing ≤6-arg call site + test is unchanged (no-op cleanup).
   */
  statsWindow?: PeerStatsWindow,
): {
  wss: WebSocketServer;
  getRoomCount: () => number;
  /**
   * Rooms-dashboard metrics migration (formerly `apps/signaling/src/rooms.ts`'s
   * `registerRoomMetrics`, deleted with the standalone signaling app): live
   * per-room participant counts, sourced directly from this relay's own
   * `room.peers` map (best visibility — the relay sees every join/leave on its
   * own WebSocket connections). Read by `startMetricsServer`'s
   * `dvconf_room_participants{roomId}` gauge on each `/metrics/prom` scrape.
   */
  getRoomParticipantCounts: () => Array<{ roomId: string; count: number }>;
  setAccepting: (accepting: boolean) => void;
  closeRooms: () => void;
  /**
   * REQ-RMS-027 (L1.3-b, Bridge B) — fan a standby-minted LOCAL forwarded producer
   * to the room's OWN local WebRTC clients (a `newProducer` notification). Called
   * by the wiring layer (index.ts) from StandbyWarmPipeCoordinator's onLocalProducer.
   *
   * REQ-RMS-034 (part-3 reverse leg) — widened to 4-arg: the publisher-binding
   * `??` resolution lives in the body. REQ-RMS-038 (C1) — the body applies the
   * cross-relay E2EE fail-closed gate: in an E2EE room a producer with no ORIGINAL
   * publisher id is DROPPED (never bound to the relayId); an open room keeps the
   * `producerPeerId ?? peerRelayId` graceful fallback.
   */
  fanLocalProducer: (
    roomId: string,
    producerPeerId: string | undefined,
    producer: msTypes.Producer,
    peerRelayId?: string,
  ) => void;
  /**
   * REQ-RMS-034/036 (part-3 reverse leg) — the wiring layer's onReverseAnnounce
   * reads a live room (to mint onto room.router) then seeds + fans the hub copy.
   */
  getRoom: (roomId: string) => RoomState | undefined;
  registerReverseMinted: (
    roomId: string,
    minted: msTypes.Producer,
    originRelayId: string,
    producerPeerId?: string,
    originProducerId?: string,
    inboundHopTtl?: number,
  ) => void;
  /**
   * REQ-RMS-037 (part-3 reverse leg, Task B4b) — STANDBY re-announce-on-reopen:
   * re-drive every existing LOCAL producer UP toward the primary (back-fill after an
   * outbound-link flap). No-op on a primary / when the room is unknown.
   */
  reannounceLocalProducersUp: (roomId: string) => void;
  /**
   * Pre-warm standby — get-or-create a room's mediasoup Router (and open the
   * standby warm pipe) ahead of any real peer join. Called by the wiring
   * layer (index.ts) from the `RoomAssigned` poller's `role === 'standby'`
   * branch, and by its periodic re-warm sweep. Idempotent: a no-op if the
   * room already exists (created here, or by a real join racing it).
   */
  prewarmRoom: (roomId: string, roomMode: 'sfu' | 'mcu') => Promise<void>;
  /** Clears the WS ping/pong liveness interval (P17 shutdown, LAST group). */
  stopWsHeartbeat: () => void;
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
  // REQ-RMS-012 — server-side audio last-N: forward only the k loudest audio
  // producers. NEVER hardcode k (feedback_no_hardcodes); 0 or unset => last-N
  // disabled (audioTopK stays undefined, audio fans out unconditionally).
  const audioLastNK = parseInt(process.env['AUDIO_LASTN_K'] ?? '0', 10);

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

  // G3.2b: cross-daemon inter-relay auth. INTER_RELAY_TOKEN (when set) tags the
  // standby's inbound link; tagged peers are attached as the announce socket and
  // are the only sockets allowed to inject pipe-producer frames server-side.
  // Unset (single-host / in-process bench) → the gate is open (unchanged path).
  const interRelayToken = process.env['INTER_RELAY_TOKEN'] ?? '';

  const config: SignalingConfig = {
    relayMode,
    audioObserverIntervalMs,
    audioObserverThresholdDb,
    audioLastNK,
    maxIncomingBitrate,
    passwordMaxAttempts,
    passwordWindowMs,
    interRelayToken,
  };

  const state: SignalingServerState = createSignalingServerState(providedSockets);

  // G-DEMO-9 (relay byte accounting): the per-room /metrics endpoint reported bytesForwarded=0
  // because `trackBytes` was only ever called with 0 (peer-join registration). Periodically
  // sample each consumer's outbound-rtp `byteCount` (relay -> receiver = the bytes mediasoup put on
  // the wire = the ground truth used by REQ-MCS-006 bench) and record the per-poll DELTA, so the
  // validator's work-based session proof reads REAL forwarded bytes (was the deferred Phase-2
  // bench wiring named in metrics.ts). Additive: closes the loop, no existing caller changes.
  const byteSampleMs = parseInt(process.env['RELAY_BYTE_SAMPLE_MS'] ?? '3000', 10);
  const byteSampler = setInterval(() => {
    void (async () => {
      for (const [roomId, room] of state.rooms) {
        for (const [peerId, peer] of room.peers) {
          for (const consumer of peer.consumers) {
            try {
              const stats = await consumer.getStats();
              const outbound = stats.find((s) => s.type === 'outbound-rtp') as
                | {
                    byteCount?: number;
                    bitrate?: number;
                    jitter?: number;
                    fractionLost?: number;
                    roundTripTime?: number;
                  }
                | undefined;
              const total = outbound?.byteCount ?? 0;
              const last = state.consumerLastByteCount.get(consumer.id) ?? 0;
              const delta = total - last;
              if (delta > 0) {
                state.consumerLastByteCount.set(consumer.id, total);
                metrics.trackBytes(roomId, peerId, delta);
              }
              if (outbound) {
                // Academic-eval "Media Quality" row: reuse this already-fetched
                // outbound-rtp sample -- zero extra polling. `jitter` is in RTP
                // timestamp units (RFC3550); convert via the stream's own
                // clockRate rather than assuming a fixed rate (video=90000,
                // audio=48000 typically differ).
                const clockRate = consumer.rtpParameters.codecs[0]?.clockRate;
                const jitterMs =
                  clockRate && outbound.jitter !== undefined
                    ? (outbound.jitter / clockRate) * 1000
                    : undefined;
                recordRtcQuality(roomId, peerId, 'down', consumer.kind, {
                  jitterMs,
                  packetLossRatio: outbound.fractionLost,
                  bitrateKbps: outbound.bitrate !== undefined ? outbound.bitrate / 1000 : undefined,
                  rttMs: outbound.roundTripTime,
                });
              }
            } catch {
              /* consumer may have closed between iteration and getStats() */
            }
          }
          for (const producer of peer.producers) {
            try {
              const stats = await producer.getStats();
              const inbound = stats.find((s) => s.type === 'inbound-rtp') as
                | { bitrate?: number; jitter?: number; fractionLost?: number; roundTripTime?: number }
                | undefined;
              if (inbound) {
                const clockRate = producer.rtpParameters.codecs[0]?.clockRate;
                const jitterMs =
                  clockRate && inbound.jitter !== undefined ? (inbound.jitter / clockRate) * 1000 : undefined;
                recordRtcQuality(roomId, peerId, 'up', producer.kind, {
                  jitterMs,
                  packetLossRatio: inbound.fractionLost,
                  bitrateKbps: inbound.bitrate !== undefined ? inbound.bitrate / 1000 : undefined,
                  rttMs: inbound.roundTripTime,
                });
              }
            } catch {
              /* producer may have closed between iteration and getStats() */
            }
          }
        }
      }
    })();
  }, byteSampleMs);
  byteSampler.unref();

  // REQ-RMS-006: self-observed spill trigger. Wired ONLY when RMS_C_WORKER_PATHS is
  // set (the cascade-bench env), so the M1 single-room path is byte-unchanged — a
  // vanilla stack has no trigger and shouldRecordPath(undefined) === false. The
  // trigger fires ONCE per room when its forward-path count crosses the threshold;
  // the request is logged (cp-daemon placement reads the canary-attested signal, not
  // this self-report — see spill-trigger.ts header). FIRE-ONCE by design: it is NOT
  // decremented on consumer/producer/room close in M2 (see Done Criteria / concerns).
  const spillTrigger: SpillTrigger | undefined =
    process.env['RMS_C_WORKER_PATHS'] !== undefined
      ? createSpillTrigger({
          onSpillRequested: (roomId, paths) =>
            logger.info({ roomId, paths }, 'REQ-RMS-006: relay self-observed spill request'),
          logger,
        })
      : undefined;

  const wss = new WebSocketServer({
    port,
    maxPayload: 64 * 1024,
    // Select the inter-relay subprotocol when a peer advertises it (a normal
    // client offers none → handleProtocols is not invoked). Identity signal
    // alongside the Bearer token; not the auth itself.
    handleProtocols: (protocols) =>
      protocols.has(INTER_RELAY_SUBPROTOCOL) ? INTER_RELAY_SUBPROTOCOL : false,
  });

  // Client sockets whose TCP connection dies without a clean close handshake
  // were never cleaned up -- ws.on('close') never fires, so the peer's
  // producers sit in room state forever as "ghost" producers, endlessly
  // re-announced to every future joiner (join-handler.ts) but never deliver
  // real media. Standard `ws` ping/pong liveness pattern: each tick, terminate
  // any socket that didn't pong since the LAST tick, then ping+reset every
  // survivor. Worst-case detection time is 2x WS_HEARTBEAT_INTERVAL_MS below.
  // ws.terminate() synchronously fires the SAME ws.on('close', ...) handler
  // already wired in handleConnection -- full teardown (handleDisconnect ->
  // removePeer) happens there, unchanged; this loop never calls
  // removePeer/handleDisconnect itself.
  const wsAlive = new WeakMap<WebSocket, boolean>();
  const wsHeartbeatIntervalMs = parseInt(process.env['WS_HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
  const wsHeartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      // Inter-relay peers (G3.2b tagged) have their own liveness mechanism
      // (pipe-liveness-observer.ts + reconnect logic) -- exempt them here so
      // this loop never races/conflicts with that path.
      if (state.interRelayPeers.has(ws)) continue;

      if (wsAlive.get(ws) === false) {
        logger.warn('WS heartbeat: peer missed pong, terminating stale connection');
        ws.terminate();
        continue;
      }

      wsAlive.set(ws, false);
      ws.ping();
    }
  }, wsHeartbeatIntervalMs);
  wsHeartbeat.unref();

  // Wraps every dispatched message in its own span (`ws.signal.<type>`) --
  // relay's actual "request" lifecycle (call setup, ICE/mediasoup
  // signaling) runs over this WS dispatcher, and OTel has no official `ws`
  // instrumentation package to cover it automatically (only http/undici are
  // auto-instrumented, see otel-bootstrap.ts). No-ops cleanly when tracing
  // isn't configured (relaySignalingTracer.startActiveSpan still runs, just
  // against the OTel API's no-op default tracer/span).
  const relaySignalingTracer = trace.getTracer('dvconf-relay-signaling');

  async function handleMessage(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    await relaySignalingTracer.startActiveSpan(`ws.signal.${msg.type}`, async (span) => {
      try {
        await dispatchMessage(ws, msg);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  async function dispatchMessage(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    switch (msg.type) {
      case 'join': {
        await handleJoin(state, ws, msg, manager, metrics, config, interRelay, logger);
        break;
      }

      case 'createTransport': {
        await handleCreateTransport(state, ws, msg, turnContext, config, logger);
        break;
      }

      case 'connectTransport': {
        await handleConnectTransport(state, ws, msg, logger);
        break;
      }

      case 'produce': {
        await handleProduce(state, ws, msg, interRelay, spillTrigger, logger);
        break;
      }

      case 'consume': {
        await handleConsume(state, ws, msg, interRelay, logger);
        break;
      }

      case 'leave': {
        await handleDisconnect(state, ws, metrics, interRelay, logger, statsWindow);
        break;
      }

      case 'pipe-producer': {
        await handlePipeProducerAnnounce(state, msg, ws, interRelay, interRelayToken, logger);
        break;
      }

      case 'pipe-connect': {
        handlePipeConnect(state, msg, ws, interRelay, interRelayToken, logger);
        break;
      }

      case 'setConsumerLayers': {
        await handleSetConsumerLayers(state, ws, msg, logger);
        break;
      }

      case 'pauseConsumer': {
        await handlePauseConsumer(state, ws, msg, logger);
        break;
      }

      case 'resumeConsumer': {
        await handleResumeConsumer(state, ws, msg, logger);
        break;
      }

      case 'e2eeKeyBundle': {
        handleE2eeKeyBundle(state, ws, msg, logger);
        break;
      }

      default: {
        logger.warn({ type: (msg as { type: string }).type }, 'Unknown signaling message type');
      }
    }
  }

  wss.on('connection', (ws: WebSocket, req) => {
    wsAlive.set(ws, true);
    handleConnection(state, ws, req, interRelayToken, metrics, interRelay, handleMessage, logger, (s) =>
      wsAlive.set(s, true),
    );
  });

  wss.on('listening', () => {
    logger.info({ port, relayMode }, 'Relay signaling server listening');
  });

  return {
    wss,
    getRoomCount: () => state.rooms.size,
    getRoomParticipantCounts: () => {
      const counts: Array<{ roomId: string; count: number }> = [];
      for (const [roomId, room] of state.rooms) {
        counts.push({ roomId, count: room.peers.size });
      }
      return counts;
    },
    setAccepting: (next: boolean) => setAcceptingImpl(state, next),
    closeRooms: () => closeRoomsImpl(state),
    fanLocalProducer: (roomId, producerPeerId, producer, peerRelayId) =>
      fanLocalProducerImpl(state, roomId, producerPeerId, producer, peerRelayId, logger),
    getRoom: (roomId: string) => getRoomState(state, roomId),
    registerReverseMinted: (roomId, minted, originRelayId, producerPeerId, originProducerId, inboundHopTtl) =>
      registerReverseMintedImpl(
        state, roomId, minted, originRelayId, interRelay, logger, producerPeerId, originProducerId, inboundHopTtl,
      ),
    reannounceLocalProducersUp: (roomId: string) => reannounceLocalProducersUpImpl(state, roomId, interRelay, logger),
    prewarmRoom: async (roomId: string, roomMode: 'sfu' | 'mcu') => {
      await ensureRoomPrewarmed(state, manager, roomId, roomMode, config, interRelay, logger);
    },
    stopWsHeartbeat: () => clearInterval(wsHeartbeat),
  };
}
