/**
 * Validator Daemon -- Entry point.
 *
 * The validator daemon:
 * 1. Auto-registers on-chain if VALIDATOR_CAP_ID is not set
 * 2. Generates a session wallet (Ed25519Keypair) distinct from the main wallet
 * 3. Runs a periodic measurement loop collecting simulated metrics
 * 4. Constructs dual-key signed SessionProofs and submits on-chain
 * 5. Listens for validator_registry events via EventPoller
 * 6. Discovers RoomEscrow objects via EscrowCreated events (IC-3)
 * 7. Discovers rooms via RoomCreated/RoomClosed events for dynamic room lifecycle
 * 8. Triggers reward distribution when rooms close and proofs are collected
 *
 * CRITICAL: Never log session wallet private key. Only log the address.
 *
 * The daemon's core lifecycle (state, bootstrap, event pollers, measurement
 * cycle, shutdown) lives under `./daemon/` -- see `./daemon/index.ts` for the
 * curated barrel. This file keeps only the CLI entrypoint (`main`), plus
 * compatibility re-exports so every name previously importable from this file
 * stays importable without editing call sites/tests.
 */

import '@dvconf/shared/otel-bootstrap';
import 'dotenv/config';
import {
  createSuiClient,
  createGraphQLClient,
  loadNetworkConfig,
  createLogger,
  startHealthzServer,
  createMetricsRegistry,
  startPromMetricsServer,
  createConcurrencyGauge,
  createGauge,
  registerTxMetrics,
  registerEventPollerMetrics,
  registerRoleAssignmentMetrics,
} from '@dvconf/shared';
import type { HealthzHandle, PromMetricsServerHandle } from '@dvconf/shared';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  runGracefulShutdown,
  readGracefulShutdownConfig,
} from '@dvconf/chain-event-listener';
import { closeValidatorProbe } from './latency-probe.js';
import { registerCanaryMetrics } from './canary/canary-metrics.js';
import {
  startDaemon,
  buildValidatorShutdownPlan,
  startValidatorSelfShutdownWatcher,
  type DaemonState,
} from './daemon/index.js';

export {
  startHealthMonitor,
  startDaemon,
  stopDaemon,
  buildValidatorShutdownPlan,
  startValidatorSelfShutdownWatcher,
} from './daemon/index.js';
export type { ValidatorConfig, ActiveRoom, DaemonState, ValidatorShutdownDeps } from './daemon/index.js';

const logger = createLogger('validator-daemon');

// -- Main entry point --

/* istanbul ignore next -- CLI entry point */
async function main(): Promise<void> {
  let state: DaemonState | null = null;
  let healthz: HealthzHandle | undefined;
  let promMetrics: PromMetricsServerHandle | undefined;
  let concurrencyGaugeInterval: ReturnType<typeof setInterval> | undefined;
  let chainListener: ChainEventListener | undefined;
  let selfShutdownWatcher: SelfShutdownWatcher | undefined;
  const gracefulCfg = readGracefulShutdownConfig();

  // ── P17 M2b-P9 (DOH-021/022/023/024): unify the old stopDaemon + main().shutdown
  // into ONE ordered runGracefulShutdown — the SelfShutdownWatcher trigger AND a
  // SIGTERM/SIGINT funnel through it. Replaces the blind exit(0) with the 30s-drain
  // / 60s-force-kill sequence + C-A (HealthMonitor → reactive) + C-B
  // (heartbeat/healthz → LAST). Force-kill is NET-NEW for the validator (had none).
  const runValidatorShutdown = (reason: string): void => {
    if (state === null) {
      // Crashed/triggered before startDaemon resolved — just close healthz + exit.
      void healthz?.close();
      if (concurrencyGaugeInterval) clearInterval(concurrencyGaugeInterval);
      void promMetrics?.close();
      process.exit(0);
    }
    const s = state;
    void runGracefulShutdown(
      buildValidatorShutdownPlan(reason, {
        logger,
        setRunning: (running) => {
          s.running = running;
        },
        // DOH-022: await the in-flight measurement cycle (no cancel); null when idle.
        drainMeasurement: () => s.inFlightMeasurement ?? Promise.resolve(),
        stopHealthMonitor: () => {
          s.healthMonitorStop?.(); // C-A
          s.healthMonitorStop = null;
        },
        stopWatcher: () => selfShutdownWatcher?.stop(),
        stopChainListener: () => chainListener?.stop() ?? Promise.resolve(),
        stopMeasurementTimer: () => {
          if (s.measurementTimer) {
            clearInterval(s.measurementTimer);
            s.measurementTimer = null;
          }
        },
        stopPollers: () => {
          s.eventPoller?.stop();
          s.escrowPoller?.stop();
          s.roomPoller?.stop();
          s.eventPoller = s.escrowPoller = s.roomPoller = null;
          s.livenessSweep?.stop();
          s.livenessSweep = null;
          // REQ-CFA-004 (Task 5.1): the additive canary cell loop is a reactive side-loop
          // → stop it alongside the pollers (not in the liveness-LAST group).
          s.canaryCellLoop?.stop();
          s.canaryCellLoop = null;
        },
        stopProbe: closeValidatorProbe,
        stopHeartbeat: () => {
          s.heartbeatStop?.(); // C-B → LAST
          s.heartbeatStop = null;
        },
        closeHealthz: async () => {
          // M2 chunk 1 (REQ-CFA-015): close the off-chain coverage feed in the LAST group
          // next to /healthz (both are loopback HTTP servers torn down after the drain).
          if (s.coverageServer) {
            s.coverageServer.close();
            s.coverageServer = null;
          }
          // Stage 4.5 (C1 cross-host): tear down the local /canary/claims mTLS server (live mode only),
          // alongside the other loopback HTTP servers in the LAST group.
          if (s.canaryClaimsServer) {
            await s.canaryClaimsServer.stop();
            s.canaryClaimsServer = null;
          }
          // B2 (REQ-MLW-B-01/02): tear down the live pipe-tap consumer (mediasoup worker + standby
          // pipe) in the LAST group next to the other heavy resources. shutdown() is sync. No-op when
          // CANARY_LIVE_CAPTURE != 'pipe' (s.liveConsumer stays null) — byte-identical OFF.
          if (s.liveConsumer) {
            s.liveConsumer.shutdown();
            s.liveConsumer = null;
          }
          if (concurrencyGaugeInterval) clearInterval(concurrencyGaugeInterval);
          await Promise.all([
            healthz?.close() ?? Promise.resolve(),
            promMetrics?.close() ?? Promise.resolve(),
          ]);
        },
        exit: (code) => process.exit(code),
        config: gracefulCfg,
      }),
    );
  };

  process.on('SIGTERM', () => runValidatorShutdown('SIGTERM'));
  process.on('SIGINT', () => runValidatorShutdown('SIGINT'));

  try {
    const config = loadNetworkConfig();
    const client = createSuiClient(config.rpcUrl);
    // Event queries only (ChainEventListener below) -- see createGraphQLClient's docstring.
    const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');

    // P17 M2b-P9 (DOH-019/027): the ChainEventListener backing the F60
    // SelfShutdownWatcher (node_health subscribe) + the /healthz isLive gate.
    const listener = new ChainEventListener({
      client: graphqlClient,
      packageId: config.originalPackageId ?? config.packageId,
      logger: logger.child({ component: 'self-shutdown-listener' }),
    });
    chainListener = listener;

    // F65 (DOH-008/009) — always-on, cheap liveness endpoint. P17 M2b-P9 (DOH-027):
    // isLive 503s while the chain listener is replay-degraded — SAFE because the
    // validator /healthz is NOT peer-polled (unlike the relay's, F1=Option A).
    healthz = await startHealthzServer({
      port: Number(process.env['VALIDATOR_HEALTHZ_PORT'] ?? 8101),
      service: 'validator-daemon',
      isLive: () => !listener.isDegraded(),
    });
    logger.info({ port: healthz.port }, 'healthz listening');

    // Worker-metrics: Prometheus scrape endpoint (CPU/RSS/heap via
    // collectDefaultMetrics + dvconf_active_sessions sourced from the live
    // activeRooms map, once startDaemon has populated `state`).
    const promRegistry = createMetricsRegistry('validator-daemon');
    const concurrencyGauge = createConcurrencyGauge(promRegistry, 'validator-daemon');
    // Academic-eval blockchain-overhead metrics -- see cp-daemon/src/index.ts's
    // identical call for why this is enough to instrument every
    // executeWithRetry() in this process (heartbeat, session-proof, reward
    // sweep, ...).
    registerTxMetrics(promRegistry, 'validator-daemon');
    registerEventPollerMetrics(promRegistry, 'validator-daemon');
    registerRoleAssignmentMetrics(promRegistry, 'validator-daemon');
    // Monitoring-redesign gap #6: cross-host network-path visibility --
    // exports the STUN RTT/jitter/loss measurement-cycle already collects
    // per relay (state.relayPathSamples, written in measureRelay) as
    // labeled gauges, refreshed on the same interval as concurrencyGauge below.
    const relayPathRttGauge = createGauge(
      promRegistry,
      'dvconf_validator_relay_rtt_ms',
      'Validator-observed STUN RTT to a relay, ms',
      ['relay'],
    );
    const relayPathJitterGauge = createGauge(
      promRegistry,
      'dvconf_validator_relay_jitter_ms',
      'Validator-observed STUN jitter to a relay, ms',
      ['relay'],
    );
    const relayPathLossGauge = createGauge(
      promRegistry,
      'dvconf_validator_relay_loss_bps',
      'Validator-observed STUN packet loss to a relay, basis points',
      ['relay'],
    );
    // Monitoring-redesign gap #4: canary coverage/quorum/divergence-promoted metrics
    // (INV-A/C non-secret aggregate counts only), set right where verify-loop.ts
    // already computes those values (see startDaemon's onCoverageSample/onQuorumSample/
    // onDivergencePromoted deps).
    const canaryMetrics = registerCanaryMetrics(promRegistry);

    promMetrics = await startPromMetricsServer({
      port: Number(process.env['VALIDATOR_METRICS_PORT'] ?? 8103),
      service: 'validator-daemon',
      registry: promRegistry,
      token: process.env['METRICS_AUTH_TOKEN'],
      logger,
    });
    logger.info({ port: promMetrics.port }, 'prom metrics listening');

    state = await startDaemon({ client, config, canaryMetrics });

    concurrencyGaugeInterval = setInterval(() => {
      concurrencyGauge.setActiveSessions(state?.activeRooms.size ?? 0);
      // Monitoring-redesign gap #6: re-set from state.relayPathSamples each
      // tick (reset first so a relay that's dropped out of rotation doesn't
      // keep reporting a stale last-known sample forever).
      relayPathRttGauge.reset();
      relayPathJitterGauge.reset();
      relayPathLossGauge.reset();
      for (const [relayMinerId, sample] of state?.relayPathSamples ?? []) {
        const labels = { relay: relayMinerId };
        relayPathRttGauge.set(labels, Number(sample.rttMs));
        relayPathJitterGauge.set(labels, Number(sample.jitterMs));
        relayPathLossGauge.set(labels, Number(sample.lossBps));
      }
    }, 5000);

    // Validator is report-only on slash → arms { degraded, paused } (no slash).
    ({ watcher: selfShutdownWatcher } = await startValidatorSelfShutdownWatcher({
      client,
      config,
      validatorCapId: state.validatorCapId,
      listener,
      onSelfShutdown: (reason) => {
        logger.error({ reason }, 'self-shutdown triggered — initiating graceful shutdown');
        runValidatorShutdown(reason);
      },
      logger,
    }));
  } catch (err) {
    logger.error({ err }, 'Validator daemon failed to start');
    process.exit(1);
  }
}

// Only run main when executed directly (not imported for testing)
const isMainModule = process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js');
if (isMainModule) {
  main().catch((err) => {
    logger.error({ err }, 'Unhandled error');
    process.exit(1);
  });
}
