/**
 * CP Daemon — Control Plane daemon entry point.
 *
 * Subscribes to relay/room/validator/voting events, runs relay + validator
 * scoring, sends heartbeat to ControlPlaneRegistry, and participates in role voting.
 *
 * Uses @dvconf/shared for all chain interactions (DAEMON-12) with exponential backoff (DAEMON-07).
 *
 * The F61 HealthMonitor factory lives in cp-health-monitor-wiring.ts; the F60
 * graceful-shutdown plan + SelfShutdownWatcher assembly lives in
 * cp-shutdown.ts; the role-voting/revote/relay-heartbeat/worker-confirmed-dead/
 * room-health/room-expiry watchers live in cp-watchers-wiring.ts; the TURN +
 * cap-token + quorum-claims bootstrap lives in cp-issuers-wiring.ts; the event
 * handler + bootstrap replay + EventPollers live in cp-pollers-wiring.ts.
 * `main()` below calls these factories in sequence.
 */

import '@dvconf/shared/otel-bootstrap';
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  createSuiClient,
  createGraphQLClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  startHealthzServer,
  createMetricsRegistry,
  startPromMetricsServer,
  registerTxMetrics,
  registerEventPollerMetrics,
  registerRoleAssignmentMetrics,
  createRegistrationGauge,
  createGauge,
  createDurationHistogram,
} from '@dvconf/shared';
import { ChainEventListener, runGracefulShutdown, readGracefulShutdownConfig } from '@dvconf/chain-event-listener';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { registerRoleVoterMetrics } from './role-voter.js';
import { buildCpWatchers } from './cp-watchers-wiring.js';
import { buildCpIssuers } from './cp-issuers-wiring.js';
import { buildCpPollers } from './cp-pollers-wiring.js';
import { startHealthMonitor } from './cp-health-monitor-wiring.js';
import { buildCpShutdownPlan, startCpSelfShutdownWatcher } from './cp-shutdown.js';

export { CapTokenIssuer } from './cap-token/index.js';
export type {
  CapTokenIssuerOpts,
  CpKeystore,
  SubmitFn as CapTokenSubmitFn,
  RoomAssignedEvent,
  RoleChangedEvent,
  RoleAssignedEvent,
  RelaySlashedEvent,
} from './cap-token/index.js';
// Bootstrap factory surface (moved to ./cap-token/bootstrap.ts — see the pointer
// comment below) re-exported here for backward-compatible `../index.js` imports
// (unit tests exercise these factories directly against this entrypoint module).
export {
  buildLocalCpKeystore,
  selectQuorumClaimsBoard,
  loadQuorumClaimsCrossHostTls,
  startCapTokenIssuer,
  selectProductionSubmitFnForTest,
} from './cap-token/index.js';
export type {
  ChainQuorumReader,
  StartCapTokenIssuerOptions,
  StartCapTokenIssuerResult,
  QuorumCollectorConfig,
  QuorumClaimsCrossHostTls,
} from './cap-token/index.js';

// F62 Stage 4 Item #1 bootstrap factory moved to ./cap-token/bootstrap.ts — see the dispatch lane ownership boundary comment there.

// P17 M2a-P11 — the F61 HealthMonitor factory (startHealthMonitor) moved to
// ./cp-health-monitor-wiring.ts; re-exported for backward-compatible
// `../index.js` imports (unit tests exercise it directly).
export { startHealthMonitor } from './cp-health-monitor-wiring.js';

// ── P17 M2b-P10 (DOH-021/023/024): F60 graceful shutdown ──────────────────────
// buildCpShutdownPlan / startCpSelfShutdownWatcher / CpShutdownDeps moved to
// ./cp-shutdown.js; re-exported for backward-compatible `../index.js` imports
// (unit tests exercise them directly against this entrypoint module).
export { buildCpShutdownPlan, startCpSelfShutdownWatcher } from './cp-shutdown.js';
export type { CpShutdownDeps } from './cp-shutdown.js';

const logger = createLogger('cp-daemon');

async function main(): Promise<void> {
  // Load configuration
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  // Event queries only (EventPoller, bootstrap replay below) -- devnet's
  // JSON-RPC queryEvents is gone (see createGraphQLClient's docstring), so
  // this narrowly-scoped second client covers just that gap.
  const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');
  const signer = loadKeypair('CP_KEYPAIR');

  const address = signer.toSuiAddress();
  logger.info(
    { address, rpcUrl: config.rpcUrl, packageId: config.packageId },
    'CP daemon starting',
  );

  // P17 M2b-P10 (DOH-019/027): the ChainEventListener backing the F60
  // SelfShutdownWatcher (pause arm only — NO subscribes) + the /healthz isLive
  // gate. HONEST CARRY-FORWARD: cp's 8 EventPollers are NOT routed through this
  // listener and the watcher's degraded arm is OFF → this listener has ZERO
  // subscribers → isDegraded() is always false → cp /healthz stays 200 in
  // practice (the isLive capability is wired but currently VACUOUS for cp). cp
  // /healthz is NOT peer-polled, so a 503 would be safe anyway (F1=Option A).
  const listener = new ChainEventListener({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    logger: logger.child({ component: 'self-shutdown-listener' }),
  });
  const gracefulCfg = readGracefulShutdownConfig();

  // F65 (DOH-008/009) — always-on, cheap liveness endpoint.
  const healthz = await startHealthzServer({
    port: Number(process.env['CP_HEALTHZ_PORT'] ?? 8091),
    service: 'cp-daemon',
    isLive: () => !listener.isDegraded(),
  });
  logger.info({ port: healthz.port }, 'healthz listening');

  // Worker-metrics: Prometheus scrape endpoint (CPU/RSS/heap via
  // collectDefaultMetrics — cp-daemon has no meaningful "active session" count
  // to wire into a concurrency gauge, so none is registered here).
  const cpPromRegistry = createMetricsRegistry('cp-daemon');
  // Academic-eval blockchain-overhead metrics: every executeWithRetry() call
  // in THIS process (role-voter's cast_role_vote, heartbeat, cap-token
  // issuance, ...) gets dvconf_chain_tx_duration_seconds/retries_total for
  // free once this is called -- see packages/shared/src/chain/tx.ts.
  registerTxMetrics(cpPromRegistry, 'cp-daemon');
  registerEventPollerMetrics(cpPromRegistry, 'cp-daemon');
  registerRoleVoterMetrics(cpPromRegistry);
  registerRoleAssignmentMetrics(cpPromRegistry, 'cp-daemon');
  // Rooms-dashboard metrics migration (formerly `apps/signaling/src/rooms.ts`'s
  // `registerRoomMetrics`, deleted with the standalone signaling app) --
  // cp-daemon owns `dvconf_rooms_active`/`dvconf_room_duration_seconds` since
  // it already watches room lifecycle chain-side (room-expiry-sweep.ts) --
  // single source of truth, not fragmented across relays in a multi-relay
  // room. See room-expiry-sweep.ts's RoomLifecycleMetricsSink doc.
  const roomsActiveGauge = createGauge(
    cpPromRegistry,
    'dvconf_rooms_active',
    'Currently open rooms (non-empty peer sets) for this service',
    ['service'],
  );
  const roomDurationHistogram = createDurationHistogram(
    cpPromRegistry,
    'dvconf_room_duration_seconds',
    'Duration a room stayed open, from first join to the last peer leaving',
    [],
  );
  const roomLifecycleMetricsSink = {
    setRoomsActive: (count: number) => roomsActiveGauge.set({ service: 'cp-daemon' }, count),
    observeRoomDurationSeconds: (seconds: number) => roomDurationHistogram.observe(seconds),
  };
  // Replaces the old SSH-grepped `docker logs | grep 'operator address|
  // node_id=|bootstrap failed'` status check (cli/infra/inventory.py's
  // registry_status()) with a real Prometheus series -- see
  // packages/shared/src/metrics-prom.ts's createRegistrationGauge doc.
  const registrationGauge = createRegistrationGauge(cpPromRegistry);
  const promMetrics = await startPromMetricsServer({
    port: Number(process.env['CP_METRICS_PORT'] ?? 8092),
    service: 'cp-daemon',
    registry: cpPromRegistry,
    token: process.env['METRICS_AUTH_TOKEN'],
    logger,
  });
  logger.info({ port: promMetrics.port }, 'prom metrics listening');

  // Auto-register if CP_CAP_ID not in env
  const { cpCapId } = await ensureRegistered(client, signer, config, logger, graphqlClient);
  // ensureRegistered() throws/exits on failure, so reaching this line always
  // means registered=true.
  registrationGauge.setRegistered(true);

  // Start heartbeat loop
  const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
  const stopHeartbeat = startHeartbeat(
    client,
    signer,
    config,
    cpCapId,
    heartbeatIntervalMs,
    logger,
  );

  // Role-voting + re-vote + relay-heartbeat (Layer C) + WorkerConfirmedDead +
  // room-health + room-expiry watchers (cp-watchers-wiring.ts).
  const watchers = await buildCpWatchers({
    client,
    graphqlClient,
    signer,
    config,
    cpCapId,
    logger,
    roomLifecycleMetricsSink,
  });

  // TURN issuer (+ optional TURN RPC) + F62 cap-token issuer + Leg 7d
  // quorum-claims bootstrap (cp-issuers-wiring.ts). Reuses watchers.reader
  // (the revote-watcher's SuiChainStateReader) for Leg 7c discovery reads.
  const issuers = await buildCpIssuers({
    client,
    signer,
    config,
    cpCapId,
    logger,
    reader: watchers.reader,
  });

  // Event handler + bootstrap replay + the 8 control-plane EventPollers
  // (cp-pollers-wiring.ts). Shares watchers.roomTimestamps so the room-expiry
  // sweep's reader sees the same event-fed lifecycle timestamps.
  const pollers = await buildCpPollers({
    client,
    graphqlClient,
    signer,
    config,
    cpCapId,
    logger,
    turnIssuer: issuers.turnIssuer,
    capTokenIssuer: issuers.capTokenIssuer,
    roomTimestamps: watchers.roomTimestamps,
  });

  // DOH-014/016/017/018: start the F61 self-degradation HealthMonitor (variant 'cp').
  // Additive loop alongside the heartbeat + 8 pollers; getters close over the rpc
  // + event-lag counters built by cp-pollers-wiring.ts. RO-020 healthz + event-handler untouched.
  const { stop: stopHealthMonitor } = startHealthMonitor({
    client,
    signer,
    config,
    cpCapId,
    logger,
    deps: { getRpcErrorRate: pollers.getRpcErrorRate, getEventLagMs: pollers.getEventLagMs },
  });

  logger.info(
    {
      heartbeatIntervalMs,
      pollIntervalMs: pollers.pollIntervalMs,
      roleVotingIntervalMs: watchers.roleVotingIntervalMs,
      turnRotationIntervalMs: issuers.turnRotationIntervalMs,
    },
    `CP daemon started — heartbeat every ${heartbeatIntervalMs}ms, polling events every ${pollers.pollIntervalMs}ms, role voting every ${watchers.roleVotingIntervalMs}ms, TURN secret rotating every ${issuers.turnRotationIntervalMs}ms`,
  );

  // ── P17 M2b-P10 (DOH-021/023/024): F60 graceful shutdown ──────────────────
  // Funnel SIGTERM/SIGINT AND the SelfShutdownWatcher trigger through ONE ordered
  // runGracefulShutdown — replaces the blind exit(0) with the 30s-drain (a NO-OP
  // for cp: poller-only, nothing in-flight) / 60s-force-kill (NET-NEW; cp had
  // none) sequence + C-A (HealthMonitor → reactive, stops FIRST there) + C-B
  // (heartbeat/healthz → LAST, the D-DOH-M2-F60-3 split-brain fix).
  let stopSelfShutdownWatcher: () => void = () => {};

  const runCpShutdown = (reason: string): void => {
    void runGracefulShutdown(
      buildCpShutdownPlan(reason, {
        logger,
        stopHealthMonitor, // C-A: DOH-018 — stop self-degradation submits in reactive
        stopWatcher: () => stopSelfShutdownWatcher(),
        stopChainListener: () => listener.stop(),
        stopRoleVoting: watchers.stopRoleVoting,
        stopRevoteWatcher: watchers.stopRevoteWatcher,
        stopRelayHeartbeatWatcher: watchers.stopRelayHeartbeatWatcher,
        stopWorkerConfirmedDeadListener: watchers.stopWorkerConfirmedDeadListener,
        stopRoomHealthSweep: watchers.stopRoomHealthSweep,
        stopRoomExpirySweep: watchers.stopRoomExpirySweep,
        stopTurnIssuer: issuers.stopTurnIssuer,
        stopCapTokenIssuer: issuers.stopCapTokenIssuer,
        stopTurnRpc: issuers.stopTurnRpc ? () => void issuers.stopTurnRpc!() : undefined,
        stopPollers: pollers.stopPollers,
        stopHeartbeat, // C-B → LAST
        closeHealthz: () => Promise.all([healthz.close(), promMetrics.close()]).then(() => {}),
        // Leg 7d — the live /quorum/claims carrier (null when QUORUM_CLAIMS_ENABLED unset) tears
        // down in the LAST group, after healthz (mirror the turn-rpc/healthz liveness teardown).
        ...(issuers.stopQuorumClaimsServer && { closeQuorumClaimsServer: issuers.stopQuorumClaimsServer }),
        exit: (code) => process.exit(code),
        config: gracefulCfg,
      }),
    );
  };

  // cp is NOT slashable (D-F60-4) + CP self-degradation is out of scope → arms
  // { paused } ONLY (subscribes NEITHER economic_layer NOR node_health).
  ({ stop: stopSelfShutdownWatcher } = await startCpSelfShutdownWatcher({
    client,
    config,
    cpCapId,
    listener,
    onSelfShutdown: (reason) => {
      logger.error({ reason }, 'self-shutdown triggered — initiating graceful shutdown');
      runCpShutdown(reason);
    },
    logger,
  }));

  process.on('SIGTERM', () => runCpShutdown('SIGTERM'));
  process.on('SIGINT', () => runCpShutdown('SIGINT'));
}

// Only run the daemon when executed as the entrypoint (`node index.js` / `tsx
// src/index.ts`). Stays inert on import so unit tests can exercise the exported
// factories (startCapTokenIssuer, buildLocalCpKeystore) without auto-starting main().
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    logger.fatal({ err }, 'CP daemon crashed');
    process.exit(1);
  });
}
