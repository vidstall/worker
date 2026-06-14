/**
 * DVConf Signaling Server
 *
 * Minimal WebSocket server for WebRTC ICE candidate and SDP exchange.
 * Routes messages between peers in the same room.
 *
 * Chain-aware: registers in SignalingRegistry, sends heartbeat + load updates.
 * Requirements: SIG-01, SIG-02
 */

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  startHealthzServer,
  genTraceId,
  traceChild,
  SIGNALING_SESSION_REWARD,
  InMemoryRelayEndpointCache,
  subscribeRelayEndpoints,
  type Logger,
  type NetworkConfig,
} from '@dvconf/shared';
import {
  HealthMonitor,
  makeChainReporter,
  readCooldownMs,
  type ThresholdEnv,
} from '@dvconf/health-monitor';
import { buildHealthSignals, type SignalingHealthDeps } from './health-signals.js';
import { RoomManager, getSessionsRouted } from './rooms.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import {
  createSignalingLatencyProbe,
  type SignalingLatencyProbe,
} from './latency-probe.js';
import {
  ensureBenchHttpServer,
  closeBenchHttpServer,
} from './bench-endpoint.js';
import type { AuthHook, JoinAuthMessage } from './auth.js';
import { startCapTokenAdmission } from './cap-token-admission.js';
import { DualRelayRouter } from './relay-dual-router.js';

const logger = createLogger('signaling');
const roomManager = new RoomManager();

let cachedProbe: SignalingLatencyProbe | null = null;
let probeInitialized = false;

/**
 * Module-singleton accessor for the signaling latency probe (S23.1.A2).
 * Off-by-default: returns null unless `BENCH_LATENCY=1`. Mirrors cp-daemon +
 * relay `latency-probe.ts` singleton pattern.
 */
function ensureSignalingProbe(log: Logger): SignalingLatencyProbe | null {
  if (probeInitialized) return cachedProbe;
  probeInitialized = true;
  cachedProbe = createSignalingLatencyProbe(
    process.env['SIGNALING_INSTANCE'] ?? 'signaling-default',
    log,
  );
  return cachedProbe;
}

function closeSignalingProbe(): void {
  if (cachedProbe !== null) {
    cachedProbe.close();
    cachedProbe = null;
    probeInitialized = false;
  }
}

const PORT = parseInt(process.env['SIGNALING_PORT'] ?? '8080', 10);

/**
 * Inbound message types from clients.
 *
 * Phase 3.2 (REQ-ADM-004): the `token`, `signature`, and `nonce` fields are
 * optional on the wire schema so this extension stays backwards-compatible
 * with the Stage 1-2 unauthenticated test harness. Stage 4 will gate the
 * mainline `join` switch case behind `auth.ts::AuthHook.verifyJoin` which
 * REQUIRES the three new fields per CONTRACTS.md § 4.5.
 *
 * `token` is the Sui object ID STRING of the RoomCapability (NOT a BCS blob,
 * per D-010-C). `signature` is base64-encoded raw ed25519 over the canonical
 * BCS payload `{ roomId, peerPubkey, nonce }`. `nonce` is a monotonic
 * per-peer counter; Phase 3.4 will enforce strict-greater.
 */
interface JoinMessage {
  type: 'join';
  roomId: string;
  /** Sui object ID of the RoomCapability (Phase 3.2 — D-010-C). Optional during transition. */
  token?: string;
  /** Base64 ed25519 signature over BCS({roomId, peerPubkey, nonce}). */
  signature?: string;
  /** Monotonic per-peer counter (u64 fits in JS Number for thesis scale). */
  nonce?: number;
}

interface OfferMessage {
  type: 'offer';
  sdp: unknown;
  targetPeerId: string;
}

interface AnswerMessage {
  type: 'answer';
  sdp: unknown;
  targetPeerId: string;
}

interface IceCandidateMessage {
  type: 'ice-candidate';
  candidate: unknown;
  targetPeerId: string;
}

interface LeaveMessage {
  type: 'leave';
}

type SignalingMessage =
  | JoinMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | LeaveMessage;

/** Map peerId -> WebSocket for targeted message delivery. */
const peerSockets = new Map<string, WebSocket>();

// ── F61 health signals (DOH-014) ────────────────────────────────────
/** Cumulative WS error events (ws.on('error')). */
let wsErrorCount = 0;
/** Cumulative accepted connections — the error-rate denominator. */
let totalConnections = 0;
/** WS error rate = errors / total connections; 0 before the first connection. */
function getWsErrorRate(): number {
  return totalConnections === 0 ? 0 : wsErrorCount / totalConnections;
}
/** MAX `ws.bufferedAmount` across live peer sockets (queue-depth gauge), in bytes. */
function getMaxBufferedAmount(): number {
  let max = 0;
  for (const sock of peerSockets.values()) {
    if (sock.bufferedAmount > max) max = sock.bufferedAmount;
  }
  return max;
}

// ── Rate limiting ───────────────────────────────────────────────────

const MAX_CONNECTIONS_PER_IP = 10;
const ipConnectionCount = new Map<string, number>();

const MAX_MESSAGES_PER_SECOND = 100;

/**
 * Optional server-level injection point for Stage 4 capability-token auth
 * (REQ-ADM-010-partial). When `authHook` is provided, every inbound `join`
 * message is gated through `AuthHook.verifyJoin`; rejects close the WS with
 * the close code returned by the hook (4401 / 4403 / 4409). When omitted,
 * the server preserves Stage 1-2 baseline behavior (no auth, peers join
 * directly). Injection (not internal construction) is required because
 * `index.ts` is outside the DAEMON-02 chain-aware carve-out — the daemon
 * `main()` block constructs the AuthHook and passes it in.
 *
 * M1 Phase 3.2 (REQ-RO-008): when `dualRelayRouter` is provided, every
 * successful join (admission accepted) sends a `relay-assigned` message with
 * both primary + standby relay URLs. The router is injected (not constructed
 * here) so tests can substitute a fake cache. When omitted, no relay-assigned
 * message is sent (backward-compatible — Stage 1-2 baseline).
 */
export interface CreateServerOpts {
  authHook?: AuthHook;
  /** M1 Phase 3.2 (REQ-RO-008) dual-relay router. Additive — does not bypass auth. */
  dualRelayRouter?: DualRelayRouter;
  /** F63 (DOH-003) — injectable logger (test seam). Defaults to the module logger. */
  logger?: Logger;
}

export function createServer(
  port: number = PORT,
  opts: CreateServerOpts = {},
): WebSocketServer {
  const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 });
  const authHook = opts.authHook;
  const dualRelayRouter = opts.dualRelayRouter;
  const baseLog = opts.logger ?? logger;

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';

    // Per-IP connection rate limiting
    const currentCount = ipConnectionCount.get(ip) ?? 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      logger.warn({ ip }, 'Connection rejected: too many connections from IP');
      ws.close(4029, 'Too many connections');
      return;
    }
    ipConnectionCount.set(ip, currentCount + 1);

    // Per-connection message rate limiting state
    const messageTimestamps: number[] = [];

    const peerId = randomUUID();
    peerSockets.set(peerId, ws);
    totalConnections++; // F61 ws_error_rate denominator (DOH-014)

    // F63 (DOH-003): one trace id per connection, bound to a connection logger so
    // every line for this peer — both the auth and no-auth join paths — correlates
    // under a single id (unifies the previously per-join throwaway ids).
    const traceId = genTraceId();
    const connLog = traceChild(baseLog, traceId);

    // Send the assigned peer ID to the client
    ws.send(JSON.stringify({ type: 'welcome', peerId }));

    // S23.1.A2: attach bench-ping/bench-pong latency probe when BENCH_LATENCY=1.
    // The probe is null otherwise — zero-cost branch.
    const probe = ensureSignalingProbe(logger);
    const detachProbe = probe !== null ? probe.attach(ws, peerId) : null;

    connLog.info({ peerId, ip }, 'Peer connected');

    ws.on('message', (data) => {
      // Message rate limit: max MAX_MESSAGES_PER_SECOND per second per connection
      const now = Date.now();
      const windowStart = now - 1000;
      // Remove timestamps older than 1 second
      while (messageTimestamps.length > 0 && messageTimestamps[0]! < windowStart) {
        messageTimestamps.shift();
      }
      if (messageTimestamps.length >= MAX_MESSAGES_PER_SECOND) {
        logger.warn({ peerId, ip }, 'Connection closed: message rate limit exceeded');
        ws.close(4029, 'Rate limit exceeded');
        return;
      }
      messageTimestamps.push(now);
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(data.toString()) as SignalingMessage;
      } catch {
        logger.warn({ peerId }, 'Invalid JSON received');
        return;
      }

      switch (msg.type) {
        case 'join': {
          // Stage 4 (REQ-ADM-010-partial): when an AuthHook is injected, every
          // join must pass capability-token verification before joining the
          // room. Failure closes the WS with the hook-returned close code.
          if (authHook !== undefined) {
            const joinMsg: JoinAuthMessage = {
              type: 'join',
              roomId: msg.roomId,
              token: msg.token ?? '',
              signature: msg.signature ?? '',
              nonce: msg.nonce ?? 0,
            };
            // We do not block message processing on auth completion — the
            // verifyJoin promise resolves shortly and we close-or-register
            // before subsequent messages can race in (rate-limit pins to
            // 100 msg/s, this awaits inside the handler).
            // eslint-disable-next-line @typescript-eslint/no-floating-promises
            authHook.verifyJoin(joinMsg, ws, traceId).then((verifyResult) => {
              if (!verifyResult.accepted) {
                const code = verifyResult.closeCode ?? 4401;
                ws.close(code, verifyResult.reason ?? 'auth-rejected');
                return;
              }
              roomManager.join(msg.roomId, ws, peerId);
              // M1 Phase 3.2 (REQ-RO-008): after admission gate passes, send
              // relay-assigned message with primary + standby URLs.
              // ADDITIVE: never bypasses cap-token control (H5 / T4).
              if (dualRelayRouter !== undefined) {
                dualRelayRouter.sendRelayAssigned(ws, msg.roomId, traceId);
              }
              logger.info(
                {
                  peerId,
                  roomId: msg.roomId,
                  roomSize: roomManager.getRoomSize(msg.roomId),
                  trace_id: traceId,
                  module: 'signaling',
                },
                'Peer joined room (auth-verified)',
              );
            });
            break;
          }
          roomManager.join(msg.roomId, ws, peerId);
          // M1 Phase 3.2: no-auth path also advertises relay URLs if router is wired.
          // This preserves the Stage 1-2 dual-relay test coverage path without
          // requiring a live AuthHook. Uses the connection trace id (DOH-003).
          if (dualRelayRouter !== undefined) {
            dualRelayRouter.sendRelayAssigned(ws, msg.roomId, traceId);
          }
          connLog.info(
            { peerId, roomId: msg.roomId, roomSize: roomManager.getRoomSize(msg.roomId) },
            'Peer joined room',
          );
          break;
        }

        case 'offer':
        case 'answer': {
          const target = peerSockets.get(msg.targetPeerId);
          if (target && target.readyState === WebSocket.OPEN) {
            target.send(
              JSON.stringify({
                type: msg.type,
                sdp: msg.sdp,
                fromPeerId: peerId,
              }),
            );
          }
          break;
        }

        case 'ice-candidate': {
          const target = peerSockets.get(msg.targetPeerId);
          if (target && target.readyState === WebSocket.OPEN) {
            // Do NOT log ICE candidate contents (may contain private IPs)
            target.send(
              JSON.stringify({
                type: 'ice-candidate',
                candidate: msg.candidate,
                fromPeerId: peerId,
              }),
            );
          }
          break;
        }

        case 'leave': {
          roomManager.leave(ws);
          logger.info({ peerId }, 'Peer left room');
          break;
        }

        default: {
          logger.warn({ peerId, type: (msg as { type: string }).type }, 'Unknown message type');
        }
      }
    });

    ws.on('close', () => {
      // Stop bench-ping probe before clearing peer state (S23.1.A2)
      if (detachProbe !== null) detachProbe();
      roomManager.leave(ws);
      peerSockets.delete(peerId);
      // Decrement IP connection count
      const count = ipConnectionCount.get(ip) ?? 1;
      if (count <= 1) {
        ipConnectionCount.delete(ip);
      } else {
        ipConnectionCount.set(ip, count - 1);
      }
      logger.info({ peerId }, 'Peer disconnected');
    });

    ws.on('error', (err) => {
      wsErrorCount++; // F61 ws_error_rate numerator (DOH-014)
      logger.error({ peerId, err }, 'WebSocket error');
    });
  });

  wss.on('listening', () => {
    logger.info({ port }, 'Signaling server listening');
  });

  return wss;
}

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(wss: WebSocketServer) {
  logger.info('Shutting down signaling server');
  wss.close(() => {
    logger.info('Signaling server closed');
    process.exit(0);
  });
  // Force exit after 5s if graceful close hangs
  setTimeout(() => process.exit(1), 5000);
}

/**
 * P17 M2a-P11 — assemble + start the signaling daemon's F61 HealthMonitor
 * (DOH-014/016/017/018). Binds the HARD GATE `operator := signer.toSuiAddress()`
 * (the same signer makeChainReporter signs with → operator == ctx.sender(), so
 * report_node_degradation does not abort, E_NOT_OPERATOR node_health.move:81).
 * variant 'miner' (signaling holds a MinerCap, role=Signaling → node_type 4 derived
 * on-chain). Exported (not inline) so the wiring is unit-testable.
 */
export function startHealthMonitor(args: {
  // DAEMON-02: derive the chain types from the @dvconf/shared helpers (no direct
  // `@mysten/sui` import in this core file — see signaling.test.ts compliance gate).
  client: ReturnType<typeof createSuiClient>;
  signer: ReturnType<typeof loadKeypair>;
  config: NetworkConfig;
  minerCapId: string;
  deps: SignalingHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, minerCapId, deps, logger: log, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: minerCapId,
    operator,
    variant: 'miner',
    logger: log,
  });
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(deps, env),
    reporter,
    logger: log,
    cooldownMs: readCooldownMs(env),
  });
  monitor.start();
  return { monitor, stop: () => monitor.stop() };
}

// Only start the server when run directly (not imported in tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  (async () => {
    // Load chain configuration
    const config = loadNetworkConfig();
    const client = createSuiClient(config.rpcUrl);
    const signer = loadKeypair('SIGNALING_KEYPAIR');

    const endpointUrl = process.env['ENDPOINT_URL'] ?? `ws://127.0.0.1:${PORT}`;
    const region = process.env['REGION'] ?? 'local';

    const address = signer.toSuiAddress();
    logger.info(
      { address, rpcUrl: config.rpcUrl, packageId: config.packageId, endpointUrl, region },
      'Signaling daemon starting',
    );

    // F65 (DOH-008/009) — always-on, cheap liveness endpoint.
    const healthz = await startHealthzServer({
      port: Number(process.env['SIGNALING_HEALTHZ_PORT'] ?? 8082),
      service: 'signaling',
    });
    logger.info({ port: healthz.port }, 'healthz listening');

    // Step 1: Auto-register on-chain
    const { minerCapId } = await ensureRegistered(client, signer, config, endpointUrl, region, logger);

    // Step 1.5: Wire LIVE cap-token admission (W-P3, REQ-ADW-002) — real
    // capability_events poller + cached-epoch refresher feeding an AuthHook that
    // GATES room joins against on-chain cap-tokens.
    const admission = await startCapTokenAdmission(client, config.packageId, logger);

    // Step 1.6: Wire dual-relay endpoint cache (M1 Phase 3.2, REQ-RO-008, D-RO-3).
    // The cache is populated by subscribeRelayEndpoints, which polls
    // relay_registry::RelayRegistered (→ id→ws-URL) + room_manager::RoomAssigned
    // (→ room→[primary,standby]) via the signaling daemon's existing chain-poll
    // infra (N2 fix — no cross-daemon IPC). Primed once at startup so a relay that
    // registered before this daemon booted is still resolvable.
    const relayEndpointCache = new InMemoryRelayEndpointCache();
    const dualRelayRouterInstance = new DualRelayRouter(relayEndpointCache, logger);
    const relayEndpointPollMs = parseInt(
      process.env['RELAY_ENDPOINT_POLL_INTERVAL_MS'] ?? '5000',
      10,
    );
    const stopRelayEndpoints = await subscribeRelayEndpoints(
      client,
      config.packageId,
      relayEndpointCache,
      logger,
      { pollIntervalMs: relayEndpointPollMs },
    );

    // Step 2: Start WebSocket server (gated by the live cap-token AuthHook + dual-relay router)
    const wss = createServer(PORT, {
      authHook: admission.authHook,
      dualRelayRouter: dualRelayRouterInstance,
    });

    // Step 3: Start heartbeat loop (30s default)
    const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
    const stopHeartbeat = startHeartbeat(
      client,
      signer,
      config,
      minerCapId,
      roomManager,
      heartbeatIntervalMs,
      logger,
    );

    logger.info(
      { heartbeatIntervalMs, minerCapId, port: PORT },
      'Signaling daemon started — chain-aware mode',
    );

    // Step 3.5 (DOH-014/016/017/018): start the F61 self-degradation HealthMonitor.
    // Additive second chain-submitting loop (heartbeat, healthz, F62 authHook untouched).
    // Signals read the module-scoped WS error counters + the live peerSockets bufferedAmount.
    const { stop: stopHealthMonitor } = startHealthMonitor({
      client,
      signer,
      config,
      minerCapId,
      logger,
      deps: { getWsErrorRate, getMaxBufferedAmount },
    });

    // S23.2.C2: optional /bench/event HTTP receiver for external clients
    // (Node mediasoup-client harness + future browser RTCStats collector).
    // Off-by-default — only listens when BENCH_LATENCY=1.
    const benchHandle = ensureBenchHttpServer(logger);
    if (benchHandle !== null) {
      const benchPort = parseInt(process.env['BENCH_PORT'] ?? '8081', 10);
      benchHandle.server.listen(benchPort, () => {
        logger.info(
          { benchPort, path: '/bench/event' },
          'Bench HTTP endpoint listening',
        );
      });
    }

    // Step 4: Periodic reward eligibility logging (economic tracking)
    // Reports sessions routed for off-chain reward eligibility tracking.
    // On-chain reward claims are deferred to Phase 14+.
    //
    // Signaling slashing criteria (enforcement deferred to Phase 14+):
    //   - Dropping connections mid-session
    //   - Offline during assigned sessions
    //   - Failing to relay ICE/SDP messages between peers
    const rewardLogHandle = setInterval(() => {
      const routed = getSessionsRouted();
      if (routed > 0) {
        logger.info(
          {
            sessionsRouted: routed,
            rewardEligibility: routed * SIGNALING_SESSION_REWARD,
            rewardPerSession: SIGNALING_SESSION_REWARD,
          },
          `Sessions routed: ${routed} (reward eligibility: ${routed * SIGNALING_SESSION_REWARD})`,
        );
      }
    }, heartbeatIntervalMs);

    // Graceful shutdown with heartbeat cleanup
    const chainShutdown = async () => {
      logger.info('Shutting down signaling daemon...');
      stopHealthMonitor(); // DOH-018: stop self-degradation submits before teardown
      clearInterval(rewardLogHandle);
      stopHeartbeat();
      closeSignalingProbe();
      closeBenchHttpServer();
      void healthz.close();
      // Stop the cap-token poller + epoch timer FIRST and AWAIT the unsubscribe,
      // so the in-flight capability_events RPC poll is torn down cleanly before
      // shutdown(wss) calls process.exit(0) on wss.close (the fast path, which
      // would otherwise abort a mid-flight unsubscribe).
      await admission.shutdown();
      // Tear down the relay-endpoint poller too (M1 Phase 3.2, N2) — awaits the
      // in-flight tick so no dangling queryEvents poll survives shutdown.
      await stopRelayEndpoints();
      shutdown(wss);
    };

    process.on('SIGTERM', () => void chainShutdown());
    process.on('SIGINT', () => void chainShutdown());
  })().catch((err) => {
    logger.fatal({ err }, 'Signaling daemon crashed during startup');
    process.exit(1);
  });
}
