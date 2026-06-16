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
  readIsPaused,
  readCapMinerId,
  type Logger,
  type NetworkConfig,
} from '@dvconf/shared';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  runGracefulShutdown,
  readGracefulShutdownConfig,
  type GracefulShutdownPlan,
  type GracefulShutdownConfig,
  type ShutdownReason,
} from '@dvconf/chain-event-listener';
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

// ── P17 M2b-P9 (DOH-021): F60 stop-accept gate + connection drain ────
/**
 * When `false`, the connection handler refuses NEW sockets (close 1001) at the
 * TOP of `wss.on('connection')` — ABOVE the F62 `authHook.verifyJoin` path — so a
 * refused socket never allocates peer state or reaches auth. Flipped by the
 * graceful-shutdown plan's `setAccepting(false)` (step 1). Module-level (mirrors
 * `peerSockets`/`roomManager`/the F61 counters) so `createServer`'s return type
 * stays a bare `WebSocketServer` (its callers destructure nothing).
 */
let accepting = true;

/** P17 M2b-P9 — graceful-shutdown step (1): stop/resume accepting new sockets. */
export function setAccepting(value: boolean): void {
  accepting = value;
}

/**
 * P17 M2b-P9 — graceful-shutdown drain: close every live peer socket (1001). Each
 * close fires the existing `ws.on('close')` → `roomManager.leave` + peer cleanup,
 * so the in-flight client connections drain before the LAST group tears down wss.
 */
export function drainConnections(): void {
  for (const ws of [...peerSockets.values()]) {
    ws.close(1001, 'server draining');
  }
}

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
    // P17 M2b-P9 (DOH-021): stop-accept gate — refuse new sockets during a
    // graceful shutdown BEFORE any peer-state allocation or the F62 auth path.
    if (!accepting) {
      ws.close(1001, 'server draining');
      return;
    }

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

// ── P17 M2b-P9 (DOH-021/022/023/024): F60 graceful shutdown ──────────

/**
 * The signaling daemon's teardown closures, injected into
 * {@link buildSignalingShutdownPlan}. Each maps a daemon resource onto one of
 * runGracefulShutdown's ordered groups (drain → reactive → liveness LAST).
 */
export interface SignalingShutdownDeps {
  logger: Logger;
  /** (1) Stop accepting new client sockets ({@link setAccepting}). */
  setAccepting: (accepting: boolean) => void;
  /** (2) drain — close live peer sockets ({@link drainConnections}). */
  drainConnections: () => void;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener pollers. */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the F62 cap-token admission poller + epoch refresher. */
  stopAdmission: () => Promise<void>;
  /** (3) reactive — the dual-relay endpoint cache poller. */
  stopRelayEndpoints: () => Promise<void>;
  /** (3) reactive — the periodic reward-eligibility log interval. */
  stopRewardLog: () => void;
  /** (3) reactive — the optional bench latency probe. */
  stopProbe: () => void;
  /** (3) reactive — the optional bench HTTP receiver. */
  stopBench: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the daemon live). */
  stopHeartbeat: () => void;
  /** (4) LAST — the /healthz liveness server. */
  closeHealthz: () => Promise<void>;
  /** (4) LAST — the client WebSocket server (resolves when fully closed). */
  closeWss: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * Assemble the signaling daemon's ordered graceful-shutdown plan, encoding the
 * two cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops in
 *         `stopReactive` (with the watcher + ChainEventListener + the cap-token
 *         admission poller + the relay-endpoint poller + the reward log), NOT first.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz + wss) so the chain
 *         sees the signaling node LIVE through the whole drain (D-DOH-M2-F60-3).
 * Exported (not inline) so the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildSignalingShutdownPlan(
  reason: string,
  deps: SignalingShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: deps.setAccepting,
    drain: async () => {
      deps.drainConnections();
    },
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      await deps.stopAdmission();
      await deps.stopRelayEndpoints();
      deps.stopRewardLog();
      deps.stopProbe();
      deps.stopBench();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      await deps.closeHealthz();
      await deps.closeWss();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * Assemble + start the signaling daemon's F60 SelfShutdownWatcher.
 *
 * Signaling is REPORT-ONLY on slash (not slashable) → arms = { degraded, paused }
 * (NO `slash` ⇒ it never subscribes economic_layer). `ownMinerId` = the cap's
 * `miner_id` FIELD (the ID carried by `NodeDegraded.miner_id`), read off-chain via
 * {@link readCapMinerId} — NOT the cap OBJECT id. The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * Exported so the arms + self-filter id + isPaused wiring is unit-testable.
 */
export async function startSignalingSelfShutdownWatcher(args: {
  client: ReturnType<typeof createSuiClient>;
  config: NetworkConfig;
  minerCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, minerCapId, listener, onSelfShutdown, logger: log } = args;
  const ownMinerId = await readCapMinerId(client, minerCapId, log);
  if (ownMinerId === null) {
    log.warn(
      { minerCapId },
      'startSignalingSelfShutdownWatcher: could not resolve own miner_id — degraded self-filter will not match (paused arm stays active)',
    );
  }
  const watcher = new SelfShutdownWatcher({
    listener,
    ownMinerId: ownMinerId ?? '',
    arms: { slash: false, degraded: true, paused: true },
    onSelfShutdown,
    logger: log,
    isPaused: () => readIsPaused(client, config.packageId, config.networkRegistryId, log),
  });
  await watcher.start();
  return { watcher, stop: () => watcher.stop() };
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

    // P17 M2b-P9 (DOH-019/027): the ChainEventListener backing the F60
    // SelfShutdownWatcher (node_health subscribe) + the /healthz isLive gate. Built
    // BEFORE healthz so the isLive closure can read its replay-degraded latch.
    const gracefulCfg = readGracefulShutdownConfig();
    const chainListener = new ChainEventListener({
      client,
      packageId: config.packageId,
      logger: logger.child({ component: 'self-shutdown-listener' }),
    });

    // F65 (DOH-008/009) — always-on, cheap liveness endpoint. P17 M2b-P9 (DOH-027):
    // isLive 503s while the chain listener is replay-degraded — SAFE here because the
    // signaling /healthz is NOT peer-polled (unlike the relay's, F1=Option A).
    const healthz = await startHealthzServer({
      port: Number(process.env['SIGNALING_HEALTHZ_PORT'] ?? 8082),
      service: 'signaling',
      isLive: () => !chainListener.isDegraded(),
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

    // ── P17 M2b-P9 (DOH-021/022/023/024): F60 reactive lifecycle ─────────────
    // The SelfShutdownWatcher self-terminates the signaling node on a self-targeted
    // NodeDegraded(level 2) or a network pause (report-only on slash → NO slash arm);
    // both it and a SIGTERM/SIGINT funnel through the SAME ordered runGracefulShutdown
    // (P5) — the blind setTimeout(exit,5000) is replaced by the 30s-drain /
    // 60s-force-kill sequence with C-A (HealthMonitor → reactive) + C-B
    // (heartbeat/healthz → LAST). The cap-token admission + relay-endpoint pollers
    // tear down in the reactive group (awaited unsubscribe — no dangling RPC poll).
    let selfShutdownWatcher: SelfShutdownWatcher | undefined;

    const runSignalingShutdown = (reason: string): void => {
      void runGracefulShutdown(
        buildSignalingShutdownPlan(reason, {
          logger,
          setAccepting,
          drainConnections,
          stopHealthMonitor, // C-A: relocated from FIRST into stopReactive
          stopWatcher: () => selfShutdownWatcher?.stop(),
          stopChainListener: () => chainListener.stop(),
          stopAdmission: () => admission.shutdown(),
          stopRelayEndpoints: () => stopRelayEndpoints(),
          stopRewardLog: () => clearInterval(rewardLogHandle),
          stopProbe: closeSignalingProbe,
          stopBench: closeBenchHttpServer,
          stopHeartbeat, // C-B: relocated from EARLY into the LAST group
          closeHealthz: () => healthz.close(),
          closeWss: () =>
            new Promise<void>((resolve) =>
              wss.close(() => {
                logger.info('Signaling server closed');
                resolve();
              }),
            ),
          exit: (code) => process.exit(code),
          config: gracefulCfg,
        }),
      );
    };

    // Signaling is report-only on slash → arms { degraded, paused } (no slash).
    ({ watcher: selfShutdownWatcher } = await startSignalingSelfShutdownWatcher({
      client,
      config,
      minerCapId,
      listener: chainListener,
      onSelfShutdown: (reason) => {
        logger.error({ reason }, 'self-shutdown triggered — initiating graceful shutdown');
        runSignalingShutdown(reason);
      },
      logger,
    }));

    process.on('SIGTERM', () => runSignalingShutdown('SIGTERM'));
    process.on('SIGINT', () => runSignalingShutdown('SIGINT'));
  })().catch((err) => {
    logger.fatal({ err }, 'Signaling daemon crashed during startup');
    process.exit(1);
  });
}
