/**
 * CP Daemon — Control Plane daemon entry point.
 *
 * Subscribes to relay/room/validator/voting events, runs relay + validator
 * scoring, sends heartbeat to ControlPlaneRegistry, and participates in role voting.
 *
 * Uses @dvconf/shared for all chain interactions (DAEMON-12) with exponential backoff (DAEMON-07).
 */

import '@dvconf/shared/otel-bootstrap';
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
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
  EventPoller,
  queryHistoricalEvents,
  readIsPaused,
  InMemoryGenericClaimBoard,
} from '@dvconf/shared';
import type { Logger, NetworkConfig } from '@dvconf/shared';
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
import { buildHealthSignals, type CpHealthDeps } from './health-signals.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createEventHandler, extractEventName } from './event-handler.js';
import { startAttestedLoadPoller, type AttestedLoadPoller } from './attested-load-poller.js';
import { startRoleVoting, registerRoleVoterMetrics } from './role-voter.js';
import { startRevoteWatcher, makeMarkSubmitter, resolveScanIntervalEpochs } from './revote-watcher.js';
import { SuiChainStateReader } from './sui-chain-state-reader.js';
import {
  startRoomHealthSweep,
  makePromoteAfterEjectionSubmitter,
  makeSpillRelaySubmitter,
  resolveMaxHeartbeatEpochs as resolveRoomHealthMaxHeartbeatEpochs,
} from './room-health-sweep.js';
import { LiveRoomHealthChainStateReader } from './room-health-chain-state-reader.js';
import {
  startRoomExpirySweep,
  makeCloseExpiredRoomSubmitter,
  recordRoomLifecycleTimestamp,
  resolvePendingExpiryMs,
  resolveReadyExpiryMs,
  type RoomLifecycleTimestamps,
} from './room-expiry-sweep.js';
import { LiveRoomExpiryChainStateReader } from './room-expiry-chain-state-reader.js';
import {
  startRelayHeartbeatWatcher,
  makePromoteSubmitter,
  makeReplacementSubmitter,
  makeLiveReplacementCandidateSelector,
  resolveMaxHeartbeatEpochs,
} from './relay-heartbeat-watcher.js';
import { LiveRelayChainStateReader } from './relay-chain-state-reader.js';
import { startWorkerConfirmedDeadListener } from './worker-confirmed-dead-listener.js';
import { startTurnIssuer } from './turn-issuer.js';
import { startTurnRpc } from './turn-rpc.js';
import {
  buildCapTokenIssueBoardConfig,
  InfraPeerPubkeyCache,
  shouldWireInfraPeerRecovery,
  loadQuorumClaimsCrossHostTls,
  selectQuorumClaimsBoard,
  startCapTokenIssuer,
} from './cap-token/index.js';
import { startQuorumClaimsServer } from './quorum-claims-server.js';

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

const logger = createLogger('cp-daemon');

// F62 Stage 4 Item #1 bootstrap factory moved to ./cap-token/bootstrap.ts — see the dispatch lane ownership boundary comment there.

/**
 * P17 M2a-P11 — assemble + start the cp-daemon's F61 HealthMonitor
 * (DOH-014/016/017/018). Binds the HARD GATE `operator := signer.toSuiAddress()`
 * (the same signer makeChainReporter signs with → operator == ctx.sender(), so
 * report_cp_degradation does not abort, E_NOT_OPERATOR node_health.move:118).
 * variant 'cp' → report_cp_degradation over the ControlPlaneCap (node_type=3
 * hardcoded on-chain). Exported (not inline) so the wiring is unit-testable.
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  deps: CpHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, cpCapId, deps, logger: log, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: cpCapId,
    operator,
    variant: 'cp',
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

// ── P17 M2b-P10 (DOH-021/023/024): F60 graceful shutdown ──────────────────────

/**
 * The cp-daemon's teardown closures, injected into {@link buildCpShutdownPlan}.
 * The cp-daemon is poller-only (no WS accept, nothing to drain) → `setAccepting`
 * and `drain` are NO-OPs; the substance is the ordered reactive → liveness-LAST
 * groups over the heartbeat + role-voting + the two watchers + the TURN/cap-token
 * issuers + the 8 EventPollers.
 */
export interface CpShutdownDeps {
  logger: Logger;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener (pause-arm only). */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the VOTE-06 role-voting loop. */
  stopRoleVoting: () => void;
  /** (3) reactive — the F47 re-vote watcher. */
  stopRevoteWatcher: () => void;
  /** (3) reactive — the RO-009 relay-heartbeat (Layer C) watcher. */
  stopRelayHeartbeatWatcher: () => void;
  /** (3) reactive — the WorkerConfirmedDead listener (room_health_alerts fast-failover path). */
  stopWorkerConfirmedDeadListener: () => void;
  /** (3) reactive — the room-health sweep (post-ejection relay reassignment). */
  stopRoomHealthSweep: () => void;
  /** (3) reactive — the room-expiry sweep (auto-close stale PENDING/READY rooms). */
  stopRoomExpirySweep: () => void;
  /** (3) reactive — the TURN issuer rotation loop. */
  stopTurnIssuer: () => void;
  /** (3) reactive — the F62 cap-token issuer epoch refresher. */
  stopCapTokenIssuer: () => void;
  /** (3) reactive — the optional TURN RPC HTTP server (null when TURN_RPC_TOKEN unset). */
  stopTurnRpc?: () => void;
  /** (3) reactive — the 8 control-plane EventPollers. */
  stopPollers: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the daemon live). */
  stopHeartbeat: () => void;
  /** (4) LAST — the /healthz liveness server. */
  closeHealthz: () => Promise<void>;
  /**
   * (4) LAST — the optional Leg-7d /quorum/claims live carrier (null when QUORUM_CLAIMS_ENABLED
   * unset). Registered in the LAST group (mirror the healthz/turn-rpc liveness teardown) so the
   * loopback transport stays up through reactive teardown. Optional → the hermetic default never
   * provides it (no server was started).
   */
  closeQuorumClaimsServer?: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * Assemble the cp-daemon's ordered graceful-shutdown plan, encoding the two
 * cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops
 *         FIRST in `stopReactive` (with the watcher + ChainEventListener + the
 *         role-voting / re-vote / relay-heartbeat watchers + the TURN/cap-token
 *         issuers + the 9 pollers), NOT before the drain.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz) so the chain sees
 *         the cp LIVE through teardown (D-DOH-M2-F60-3 split-brain fix).
 * `setAccepting` + `drain` are NO-OPs (cp is poller-only). Exported (not inline) so
 * the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildCpShutdownPlan(
  reason: string,
  deps: CpShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: () => {}, // NO-OP — cp has no connection accept
    drain: async () => {}, // NO-OP — poller-only, nothing in-flight
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      deps.stopRoleVoting();
      deps.stopRevoteWatcher();
      deps.stopRelayHeartbeatWatcher();
      deps.stopWorkerConfirmedDeadListener();
      deps.stopRoomHealthSweep();
      deps.stopRoomExpirySweep();
      deps.stopTurnIssuer();
      deps.stopCapTokenIssuer();
      deps.stopTurnRpc?.();
      deps.stopPollers();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      await deps.closeHealthz();
      // Leg 7d — the live /quorum/claims carrier tears down in the LAST group (loopback transport
      // stays up through reactive teardown). Optional: absent in the hermetic default (no server).
      await deps.closeQuorumClaimsServer?.();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * Assemble + start the cp-daemon's F60 SelfShutdownWatcher.
 *
 * The cp-daemon is NOT slashable (D-F60-4) and CP self-degradation is out of scope
 * (CP failover deferred to advisor gate 5) → arms = { paused } ONLY: it subscribes
 * NEITHER economic_layer NOR node_health, so only the `is_paused()` poll is armed.
 * Because both id-filtered arms are off, `ownMinerId` is unused → we pass `''` and
 * SKIP the {@link readCapMinerId} RPC (unlike validator-daemon, which arms
 * `degraded` and needs the self-filter id). The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * The existing cp event-handler `RelaySlashed` arm (the TURN kill-switch for OTHER
 * relays) is UNTOUCHED — distinct from this self-targeted terminal trigger.
 * Exported so the arms + skipped-RPC wiring is unit-testable.
 */
export async function startCpSelfShutdownWatcher(args: {
  client: SuiClient;
  config: NetworkConfig;
  cpCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, listener, onSelfShutdown, logger: log } = args;
  const watcher = new SelfShutdownWatcher({
    listener,
    ownMinerId: '', // unused — both id-filtered arms (slash/degraded) are off
    arms: { slash: false, degraded: false, paused: true },
    onSelfShutdown,
    logger: log,
    isPaused: () => readIsPaused(client, config.packageId, config.networkRegistryId, log),
  });
  await watcher.start();
  return { watcher, stop: () => watcher.stop() };
}

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

  // Start role voting loop (VOTE-06)
  const roleVotingIntervalMs = parseInt(process.env['ROLE_VOTING_INTERVAL_MS'] ?? '30000', 10);
  const stopRoleVoting = startRoleVoting(
    client,
    signer,
    config,
    cpCapId,
    logger,
    roleVotingIntervalMs,
  );

  // F47 RV-013 (Phase 4.0) — re-vote watcher, now wired with the live
  // SuiChainStateReader. The watcher scans on-chain state every `scanEpochs`
  // epochs and submits permissionless `mark_revote_eligible_*` TXs (idle +
  // composition-shift); every mark re-validates on-chain, so the daemon is
  // advisory. Cadence resolves from REVOTE_SCAN_INTERVAL_EPOCHS via
  // resolveScanIntervalEpochs(); the epoch→ms conversion happens here where the
  // live epoch duration is known.
  const reader = new SuiChainStateReader(client, config, logger);
  const scanEpochs = resolveScanIntervalEpochs();
  // epoch→ms: prefer an explicit ms override (demo/localnet set a small value),
  // else derive from the live epoch duration. No hardcode.
  const sysState = await client.getLatestSuiSystemState();
  const revoteIntervalMs = parseInt(
    process.env['REVOTE_SCAN_INTERVAL_MS'] ?? String(scanEpochs * Number(sysState.epochDurationMs)),
    10,
  );
  const stopRevoteWatcher = startRevoteWatcher(
    reader,
    makeMarkSubmitter(client, signer, config, logger),
    logger,
    revoteIntervalMs,
  );
  logger.info({ module: 'cp-daemon', scanEpochs, revoteIntervalMs }, 'revote watcher started');

  // M1 Phase 3.1 (REQ-RO-009) — RelayHeartbeatWatcher (Layer C, chain-authoritative).
  // Mirrors the revote-watcher wiring above: a LiveRelayChainStateReader over the
  // devInspect seam feeds the watcher, which submits permissionless `promote_relay`
  // PTBs (via makePromoteSubmitter) when a primary's heartbeat is stale > 3 epochs
  // and the standby is fresh. The chain re-asserts staleness (E_RELAY_NOT_STALE) so
  // the daemon is advisory. Cadence: RELAY_HEARTBEAT_SCAN_INTERVAL_MS (default = the
  // live epoch duration, so detection lands within the ~3-epoch threshold window;
  // C2: this poll cadence is now honored, NOT hardcoded). Phase 5.3 bench tunes it.
  const relayReader = new LiveRelayChainStateReader(client, config, logger);
  const relayHeartbeatScanMs = parseInt(
    process.env['RELAY_HEARTBEAT_SCAN_INTERVAL_MS'] ?? String(Number(sysState.epochDurationMs)),
    10,
  );
  const relayHeartbeatWatcher = startRelayHeartbeatWatcher(
    relayReader,
    makePromoteSubmitter(client, signer, config, logger),
    logger,
    {
      pollIntervalMs: relayHeartbeatScanMs,
      // REQ-RMS-024 (D2) — env-tunable threshold, clamped to the Move MAX_HEARTBEAT_EPOCHS
      // floor: a value below it would fire promote_relay PTBs the chain aborts (E_RELAY_NOT_STALE).
      maxHeartbeatEpochs: resolveMaxHeartbeatEpochs(process.env['RELAY_MAX_HEARTBEAT_EPOCHS'], logger),
    },
    // Standby-death vote-in (relay_replacement.move) — same watcher, same cadence, a
    // separate dedup namespace from the primary-promotion path above.
    makeReplacementSubmitter(client, signer, config, cpCapId, logger),
    makeLiveReplacementCandidateSelector(relayReader),
  );
  const stopRelayHeartbeatWatcher = (): void => relayHeartbeatWatcher.stop();
  logger.info(
    { module: 'cp-daemon', relayHeartbeatScanMs },
    'relay heartbeat watcher started (Layer C)',
  );

  // Fast, room-scoped alternative failover path (see room_health_alerts.move):
  // reacts to WorkerConfirmedDead (client-alert + room-health-validator quorum,
  // enforced off the chain's epoch clock) rather than relay-heartbeat-watcher's
  // epoch-gated staleness check above. No-ops if roomHealthAlertBoxId is unset.
  const workerConfirmedDeadListener = startWorkerConfirmedDeadListener({
    client: graphqlClient,
    suiClient: client,
    config,
    signer,
    cpCapId,
    logger,
  });
  const stopWorkerConfirmedDeadListener = (): void => workerConfirmedDeadListener.stop();
  logger.info({ module: 'cp-daemon' }, 'WorkerConfirmedDead listener started');

  // Room health sweep — closes the gap where a validator-quorum liveness
  // ejection (registration::execute_ejection) removes a relay node from its
  // registry without ever touching RoomManager, leaving a room's assignment
  // dangling forever. Complements relay-heartbeat-watcher (which owns the
  // "primary stale, live standby already assigned" case): this sweep handles
  // the "primary fully ejected" and "no live standby at all" relay gaps.
  const roomHealthReader = new LiveRoomHealthChainStateReader(client, config, logger);
  const roomHealthScanMs = parseInt(
    process.env['ROOM_HEALTH_SCAN_INTERVAL_MS'] ?? String(Number(sysState.epochDurationMs)),
    10,
  );
  const roomHealthSweep = startRoomHealthSweep(
    roomHealthReader,
    {
      promoteAfterEjection: makePromoteAfterEjectionSubmitter(client, signer, config, logger),
      spillRelay: makeSpillRelaySubmitter(client, signer, config, cpCapId, logger),
    },
    logger,
    {
      pollIntervalMs: roomHealthScanMs,
      maxHeartbeatEpochs: resolveRoomHealthMaxHeartbeatEpochs(process.env['ROOM_HEALTH_MAX_HEARTBEAT_EPOCHS'], logger),
    },
  );
  const stopRoomHealthSweep = (): void => roomHealthSweep.stop();
  logger.info({ module: 'cp-daemon', roomHealthScanMs }, 'room health sweep started');

  // Room expiry sweep — auto-closes rooms stuck PENDING (never assigned a
  // relay/CP) past 15 minutes, or READY/ACTIVE (assigned but never manually
  // closed by their creator) past 1 hour. The chain has no Clock; elapsed
  // wall-clock time is judged entirely here from RoomCreated/RoomAssigned
  // event timestamps (see room-expiry-sweep.ts's module doc). `roomTimestamps`
  // is fed passively by `trackedHandler` below, off the same event stream the
  // pollers already consume — declared here (ahead of its first read) so both
  // the reader and the handler close over the same map instance.
  const roomTimestamps = new Map<string, RoomLifecycleTimestamps>();
  const roomExpiryReader = new LiveRoomExpiryChainStateReader(client, config, roomTimestamps, logger);
  const roomExpiryScanMs = parseInt(process.env['ROOM_EXPIRY_SCAN_INTERVAL_MS'] ?? '60000', 10);
  const roomExpirySweep = startRoomExpirySweep(
    roomExpiryReader,
    makeCloseExpiredRoomSubmitter(client, signer, config, cpCapId, logger),
    logger,
    {
      pollIntervalMs: roomExpiryScanMs,
      pendingExpiryMs: resolvePendingExpiryMs(process.env['ROOM_EXPIRY_PENDING_MS'], logger),
      readyExpiryMs: resolveReadyExpiryMs(process.env['ROOM_EXPIRY_READY_MS'], logger),
    },
    roomLifecycleMetricsSink,
  );
  const stopRoomExpirySweep = (): void => roomExpirySweep.stop();
  logger.info({ module: 'cp-daemon', roomExpiryScanMs }, 'room expiry sweep started');

  // Bootstrap TURN issuer (S30.B Option A — ADR-0005 hybrid 24h+on-slash rotation)
  const turnRotationIntervalMs = parseInt(
    process.env['TURN_ROTATION_INTERVAL_MS'] ?? '86400000',
    10,
  );
  const { issuer: turnIssuer, stop: stopTurnIssuer } = await startTurnIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpCapId,
    logger,
    rotateIntervalMs: turnRotationIntervalMs,
  });

  // S30.C: Optional TURN RPC HTTP server. Enabled iff TURN_RPC_TOKEN is set.
  // Relay daemon fetches credentials via POST /turn/issue during client room-join.
  const turnRpcToken = process.env['TURN_RPC_TOKEN'];
  const stopTurnRpc = turnRpcToken
    ? (
        await startTurnRpc({
          issuer: turnIssuer,
          port: parseInt(process.env['TURN_RPC_PORT'] ?? '8090', 10),
          token: turnRpcToken,
          logger,
        })
      ).stop
    : null;

  // F62 Stage 4 Item #1 — bootstrap CapTokenIssuer.
  // Leg 7c — the DEAD-ON-PROD discovery reads + peer-pubkey recovery are now promoted onto the
  // prod path: a multi-CP (threshold>=2) issue sources `min_quorum` (per-round, no cache) +
  // the active-CP operator set from chain via the SAME `reader` the revote-watcher uses, and
  // FAILS CLOSED if QUORUM_STATE_OBJECT_ID is unset (no silent minQuorum=2). The
  // InfraPeerPubkeyCache is fed off the event-handler CapabilityIssued observer (G3) so a
  // multi-CP infra-peer mint recovers the real 32-byte key (no 916 abort). Single-CP startup
  // is unaffected (threshold<=1 never reads the quorum-state object).
  const capTokenIssuerThreshold = parseInt(
    process.env['CAP_TOKEN_QUORUM_THRESHOLD'] ?? '2',
    10,
  );

  // ── Multi-CP quorum Leg 7d — LIVE-mode /quorum/claims carrier + board selection ──────────────
  //
  // ROADMAP Leg 7d: when QUORUM_CLAIMS_ENABLED is set, start the Leg-7a carrier (over a shared
  // server-side InMemoryGenericClaimBoard with the captoken-issue config) and select a
  // HttpQuorumClaimBoard CLIENT pointed at it — injected into the keystore's quorumCollector.board
  // as a PURE transport substitution. When unset (the HERMETIC default), `selectQuorumClaimsBoard`
  // returns undefined → the keystore keeps its in-memory board BYTE-IDENTICAL (nothing starts, no
  // server, no port). The server's stop() registers in the LAST shutdown group (mirror turn-rpc).
  //
  // OQ-7 cross-host boot-wiring (gap #1): when QUORUM_CLAIMS_TLS_ENABLED is on, `loadQuorumClaimsCrossHostTls`
  // loads this CP's cert/key + the signed operator-manifest bundle and derives the trusted-SPKI set;
  // the same material threads into BOTH the server fork (opts.tls) and the client (opts.tls). When the
  // flag is OFF it returns undefined → no file read, no tls → byte-identical loopback. C4 rendezvous =
  // leader-hosts-board: this CP HOSTS the board only when QUORUM_CLAIMS_PEER_URL is unset (single-host
  // default: peer URL unset → hosts, exactly as before); a FOLLOWER sets QUORUM_CLAIMS_PEER_URL to the
  // leader and consumes the leader's board WITHOUT starting a local server.
  const quorumClaimsCrossHostTls = await loadQuorumClaimsCrossHostTls({ logger });
  const quorumCollectorBoard = selectQuorumClaimsBoard({
    logger,
    ...(quorumClaimsCrossHostTls !== undefined && { tls: quorumClaimsCrossHostTls.clientTls }),
  });
  let stopQuorumClaimsServer: (() => Promise<void>) | null = null;
  const quorumClaimsPeerUrl = process.env['QUORUM_CLAIMS_PEER_URL'];
  const hostsQuorumClaimsBoard =
    quorumCollectorBoard !== undefined &&
    (quorumClaimsPeerUrl === undefined || quorumClaimsPeerUrl === '');
  if (hostsQuorumClaimsBoard) {
    const serverBoard = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({
        minDistinct: capTokenIssuerThreshold,
        // Fail-LOUD escalation is the CLIENT-side collector closure (never serialized); the
        // server-side board only runs state-GC, so this hook is a benign no-op here.
        onUnquorumedExpiry: () => {},
      }),
    ]);
    const quorumClaimsServer = await startQuorumClaimsServer({
      board: serverBoard,
      logger,
      ...(quorumClaimsCrossHostTls !== undefined && { tls: quorumClaimsCrossHostTls.serverTls }),
    });
    stopQuorumClaimsServer = quorumClaimsServer.stop;
    logger.info({ module: 'cp-daemon' }, 'quorum/claims live carrier started');
  }

  // Leg 7c (G3) recovery is a MULTI-CP mechanism (threshold>=2): it recovers the real 32-byte
  // peer_pubkey from a PRIOR CapabilityIssued event. A single-CP issuer (threshold<=1) has no seed
  // path, so wiring the cache fail-closed-SKIPs the first infra mint forever (no CapabilityIssued
  // ever emitted) — single-CP must fall back to the legacy resolvePeerPubkey mint (F62-proven).
  const infraPeerCache = shouldWireInfraPeerRecovery(capTokenIssuerThreshold)
    ? new InfraPeerPubkeyCache()
    : undefined;
  const { issuer: capTokenIssuer, stop: stopCapTokenIssuer } = await startCapTokenIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpRegistryObjectId: process.env['CP_REGISTRY_OBJECT_ID'] ?? '',
    quorumStateObjectId: process.env['QUORUM_STATE_OBJECT_ID'] ?? '',
    quorumThreshold: capTokenIssuerThreshold,
    logger,
    // Leg 7c — promote G5 (discovery) + G3 (recovery) onto the prod path.
    chainReader: reader, // reuse the revote-watcher's SuiChainStateReader (one instance)
    networkConfig: config,
    infraPeerCache,
    // Leg 7d — inject the selected live board (or undefined → hermetic in-memory default).
    ...(quorumCollectorBoard !== undefined && { quorumCollectorBoard }),
  });
  // Set up event handler with TX context for room assignment + TURN kill-switch
  // + cap-token issuance (F62 M2 W-P2 — capTokenIssuer threaded into txContext so
  // RoomAssigned/RoleAssigned/RoleChanged/RelaySlashed arms drive the issuer).
  // M1 Phase 3.1 (REQ-RO-009 / C8) — RelayPromoted observer. The chain-authoritative
  // promotion event is the split-brain resolver: when room_manager::promote_relay
  // emits RelayPromoted, the cp-daemon records it (the canonical Stay decision). The
  // client drives its own re-discovery off the same on-chain event via
  // useRelayDiscovery; the daemon-side observer is the audit + future hook point.
  const relayPromotedObserver = {
    onRelayPromoted: async (
      evt: { room_id: string; old_primary: string; new_primary: string; epoch: number },
      traceId: string,
    ): Promise<void> => {
      logger.info(
        {
          trace_id: traceId,
          module: 'cp-daemon',
          action: 'relay-promoted-observed',
          context: {
            roomId: evt.room_id,
            oldPrimary: evt.old_primary,
            newPrimary: evt.new_primary,
            epoch: evt.epoch,
          },
        },
        'RelayPromoted observed — chain-authoritative promotion recorded (Layer C)',
      );
    },
  };

  // REQ-RMS-022 (static-mesh-hardening D1) -- flag-gated attested-placement feed. Default OFF =
  // byte-stable legacy self-report placement (REQUIRED while attested rows are canary-M4b-gated:
  // a wired-but-empty feed strictly DEFERS ALL admissions, spec §2-D1). Mirrors the RMS_TREE_ACTIVE
  // flag pattern. The poller maintains ONE long-lived Map fed by reference into capacityCtx below.
  // Feed URL default = the co-located validator's VALIDATOR_CANARY_COVERAGE_PORT (8102, loopback).
  const attestedPlacementActive = process.env['RMS_ATTESTED_PLACEMENT'] === '1';
  let attestedLoadPoller: AttestedLoadPoller | undefined;
  if (attestedPlacementActive) {
    const feedUrl = process.env['RMS_LOAD_FEED_URL'] ?? 'http://127.0.0.1:8102/canary/load';
    const feedPollMs = parseInt(process.env['RMS_LOAD_FEED_POLL_MS'] ?? '5000', 10);
    attestedLoadPoller = startAttestedLoadPoller({ feedUrl, pollMs: feedPollMs, logger });
    logger.info({ module: 'cp-daemon', feedUrl, feedPollMs }, 'REQ-RMS-022: attested-load poller started (RMS_ATTESTED_PLACEMENT=1)');
  }

  const { handler, relayState, validatorState, retryPendingAssignments } = createEventHandler(logger, undefined, {
    client,
    signer,
    config,
    cpCapId,
    turnIssuer,
    capTokenIssuer,
    relayPromotedObserver,
  }, attestedPlacementActive && attestedLoadPoller
    ? { attestedLoad: attestedLoadPoller.attestedLoad } // currentEpoch/byzantineFlag stay M4b scope (both optional; spec §7 resolution)
    : undefined);

  // Retry rooms whose pairing proposal failed after executeWithRetry's own
  // retries were exhausted (a transient chain-state race, not a permanent
  // failure -- see room_manager E_INVALID_BALLOT history). Without this,
  // such a room stays stuck until the whole daemon restarts and replays
  // events from genesis (a side effect of the .cursors persistence gap, not
  // something to rely on).
  const roomRetryIntervalMs = parseInt(process.env['ROOM_RETRY_INTERVAL_MS'] ?? '30000', 10);
  const roomRetryTimer = setInterval(() => retryPendingAssignments(), roomRetryIntervalMs);
  roomRetryTimer.unref?.();

  // ── F61 health signals (DOH-014) ──────────────────────────────────────────
  // rpc_error_rate: queryEvents failures / attempts, sampled at the bootstrap loop
  // (the verified in-daemon queryEvents catch — the EventPoller's internal poll is
  // private to @dvconf/shared, untouched). HONEST CARRY-FORWARD: the bootstrap loop
  // runs once at startup, so this is a startup-RPC-health gauge; a continuously
  // refreshed rate would need a net-new periodic probe (deferred, OQ-DOH-3).
  let rpcErrors = 0;
  let rpcTotal = 0;
  const getRpcErrorRate = (): number => (rpcTotal === 0 ? 0 : rpcErrors / rpcTotal);
  // event_lag: now - newest handled event timestamp (continuously updated by the
  // tracked handler below). Primes 0 (= healthy) until the first event is seen.
  let newestEventTsMs = 0;
  const getEventLagMs = (): number =>
    newestEventTsMs === 0 ? 0 : Math.max(0, Date.now() - newestEventTsMs);
  // Additive wrapper: stamp the newest event ts then delegate to the real handler
  // (event-handler.ts + its RelaySlashed arm untouched). Used by the bootstrap
  // replay + all pollers below.
  const trackedHandler = async (ev: SuiEvent): Promise<void> => {
    const ts = ev.timestampMs ? Number(ev.timestampMs) : 0;
    if (ts > newestEventTsMs) newestEventTsMs = ts;
    recordRoomLifecycleTimestamp(ev, roomTimestamps, extractEventName);
    await handler(ev);
  };

  // Bootstrap: replay historical relay/validator events so state maps are populated
  // before real-time polling starts (prevents race where relay registers before CP poller runs)
  for (const mod of ['relay_registry', 'validator_registry', 'registration'] as const) {
    try {
      const events = await queryHistoricalEvents(graphqlClient, config.originalPackageId ?? config.packageId, mod, 100);
      rpcTotal++; // F61 rpc_error_rate: a successful queryEvents attempt (DOH-014)
      for (const ev of events) {
        await trackedHandler(ev);
      }
      logger.info({ module: mod, count: events.length }, 'Bootstrap: replayed historical events');
    } catch (err) {
      rpcErrors++; // F61 rpc_error_rate: a failed queryEvents attempt (DOH-014)
      rpcTotal++;
      logger.warn({ module: mod, err }, 'Bootstrap: failed to query historical events');
    }
  }
  logger.info(
    { relays: relayState.size, validators: validatorState.size },
    'Bootstrap complete — state maps populated',
  );

  // Poll relay_registry events
  const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);
  // DATA_DIR (mirrors ChainEventListener's own default), NOT process.cwd(),
  // so a container recreate (redeploy) doesn't force a full event-history
  // replay from genesis.
  //
  // Namespaced by originalPackageId: a GraphQL events cursor is an OPAQUE
  // pagination token scoped to the exact `filter: { type }` query it was
  // issued for (see events.ts's EVENTS_QUERY / originalPackageId doc). A
  // fresh `sui client publish` (not `upgrade` -- a brand-new package, not an
  // in-place upgrade of the same one) changes originalPackageId, so any
  // cursor persisted under the OLD package is meaningless for the NEW
  // package's event stream -- confirmed live: after a republish, cp-daemon
  // kept the stale cursor (DATA_DIR is a host-mounted volume that survives
  // container recreation), the room_manager_events/economic_layer_events
  // pollers silently never advanced past it, and RoomCreated/EscrowCreated
  // were never observed even though get_active_room_ids (a direct devInspect,
  // not event-sourced) correctly saw the room -- rooms stayed pending
  // forever with zero pairing proposals from any CP. Scoping the cursor
  // path by package keeps the intended "redeploy doesn't replay everything"
  // behavior for ordinary redeploys of the SAME package, while a republish
  // naturally starts every poller from a fresh (missing) cursor file --
  // EventPoller.loadCursor() then defaults to null, i.e. a correct replay
  // from genesis for the new package.
  const cursorPkg = config.originalPackageId ?? config.packageId;
  const cursorDir = (name: string): string =>
    join(process.env['DATA_DIR'] ?? '.', '.cursors', cursorPkg, name);

  const relayPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'relay_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('relay_registry.json'),
    logger: logger.child({ poller: 'relay_registry' }),
  });

  const cpPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'control_plane_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('control_plane_registry.json'),
    logger: logger.child({ poller: 'control_plane_registry' }),
  });

  const roomPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    // room_manager.move's RoomCreated/RoomAssigned etc. structs are actually
    // DEFINED in the companion room_manager_events module (LOC-budget split
    // -- see room_manager/events.move) -- events are pinned to whichever
    // module FIRST DEFINED the struct, not the module that called the emit
    // wrapper, so this filter must name room_manager_events or it silently
    // matches zero events forever. Confirmed via live GraphQL introspection
    // against a real create_room tx (module 'room_manager' returned no
    // events at all; 'room_manager_events' returned the RoomCreated node).
    module: 'room_manager_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('room_manager.json'),
    logger: logger.child({ poller: 'room_manager' }),
  });

  const economicPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    // Same LOC-budget split as room_manager above -- EscrowCreated etc. are
    // defined in economic_layer_events (economic_layer/events.move), not
    // economic_layer itself.
    module: 'economic_layer_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('economic_layer.json'),
    logger: logger.child({ poller: 'economic_layer' }),
  });

  const validatorPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('validator_registry.json'),
    logger: logger.child({ poller: 'validator_registry' }),
  });

  const roleVotingPoller = new EventPoller({
    client: graphqlClient,
    // Package split (see services/contract/role-voting): role_voting_events
    // is now defined in the SEPARATE dvconf_role_voting package -- NOT an
    // "original package" of dvconf_contracts (that's for a module added in a
    // later upgrade of the SAME package; this is a different package
    // entirely, with its own address and no packageId fallback that would
    // ever be correct).
    packageId: config.roleVotingPackageId,
    module: 'role_voting_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('role_voting.json'),
    logger: logger.child({ poller: 'role_voting' }),
  });

  const registrationPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    // Same LOC-budget split -- registration.move's events are defined in the
    // companion registration_events module (`use dvconf::registration_events`).
    module: 'registration_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('registration.json'),
    logger: logger.child({ poller: 'registration' }),
  });

  // F8 (REQ-CRR-005) — poll turn_credential events so the cp-daemon observes
  // emergency relay-secret rotations (SecretRotated) and arms the TURN issuer
  // kill-switch via handleEvent → turnIssuer.emergencyEvictSecret. Live-only
  // (no historical replay): SecretRotated is an emergency kill-switch; replaying
  // past rotations on restart would only re-evict already-evicted secrets (no-op).
  const turnCredentialPoller = new EventPoller({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    module: 'turn_credential',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('turn_credential.json'),
    logger: logger.child({ poller: 'turn_credential' }),
  });

  // Start all pollers (trackedHandler stamps the event-lag gauge then delegates)
  await Promise.all([
    relayPoller.start(trackedHandler),
    cpPoller.start(trackedHandler),
    roomPoller.start(trackedHandler),
    economicPoller.start(trackedHandler),
    validatorPoller.start(trackedHandler),
    roleVotingPoller.start(trackedHandler),
    registrationPoller.start(trackedHandler),
    turnCredentialPoller.start(trackedHandler),
  ]);

  // DOH-014/016/017/018: start the F61 self-degradation HealthMonitor (variant 'cp').
  // Additive loop alongside the heartbeat + 9 pollers; getters close over the rpc
  // + event-lag counters declared above. RO-020 healthz + event-handler untouched.
  const { stop: stopHealthMonitor } = startHealthMonitor({
    client,
    signer,
    config,
    cpCapId,
    logger,
    deps: { getRpcErrorRate, getEventLagMs },
  });

  logger.info(
    { heartbeatIntervalMs, pollIntervalMs, roleVotingIntervalMs, turnRotationIntervalMs },
    `CP daemon started — heartbeat every ${heartbeatIntervalMs}ms, polling events every ${pollIntervalMs}ms, role voting every ${roleVotingIntervalMs}ms, TURN secret rotating every ${turnRotationIntervalMs}ms`,
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
        stopRoleVoting,
        stopRevoteWatcher,
        stopRelayHeartbeatWatcher,
        stopWorkerConfirmedDeadListener,
        stopRoomHealthSweep,
        stopRoomExpirySweep,
        stopTurnIssuer,
        stopCapTokenIssuer,
        stopTurnRpc: stopTurnRpc ? () => void stopTurnRpc() : undefined,
        stopPollers: () => {
          relayPoller.stop();
          cpPoller.stop();
          roomPoller.stop();
          economicPoller.stop();
          validatorPoller.stop();
          roleVotingPoller.stop();
          registrationPoller.stop();
          turnCredentialPoller.stop();
          attestedLoadPoller?.stop(); // REQ-RMS-022 (D1) — undefined when RMS_ATTESTED_PLACEMENT unset
        },
        stopHeartbeat, // C-B → LAST
        closeHealthz: () => Promise.all([healthz.close(), promMetrics.close()]).then(() => {}),
        // Leg 7d — the live /quorum/claims carrier (null when QUORUM_CLAIMS_ENABLED unset) tears
        // down in the LAST group, after healthz (mirror the turn-rpc/healthz liveness teardown).
        ...(stopQuorumClaimsServer && { closeQuorumClaimsServer: stopQuorumClaimsServer }),
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
