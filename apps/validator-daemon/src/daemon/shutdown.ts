/**
 * Validator Daemon -- shutdown.
 *
 * Extracted from the former `index.ts` monolith: the legacy synchronous
 * `stopDaemon`, and the F60 graceful-shutdown plan/watcher wiring
 * (`ValidatorShutdownDeps`, `buildValidatorShutdownPlan`,
 * `startValidatorSelfShutdownWatcher`).
 */

import type { SuiClient } from '@mysten/sui/client';
import {
  type Logger,
  type NetworkConfig,
  createLogger,
  readIsPaused,
  readCapMinerId,
} from '@dvconf/shared';
import {
  SelfShutdownWatcher,
  type ChainEventListener,
  type GracefulShutdownPlan,
  type GracefulShutdownConfig,
  type ShutdownReason,
} from '@dvconf/chain-event-listener';
import { closeValidatorProbe } from '../latency-probe.js';
import type { DaemonState } from './state.js';

const logger = createLogger('validator-daemon');

/**
 * Stop the daemon gracefully.
 */
export function stopDaemon(state: DaemonState, log?: Logger): void {
  const l = log ?? logger;
  state.running = false;

  // Close latency-probe writer (S23.1.A3, no-op when BENCH_LATENCY unset)
  closeValidatorProbe();

  // DOH-018: stop the F61 self-degradation monitor first so no degraded report
  // fires mid-shutdown.
  if (state.healthMonitorStop) {
    state.healthMonitorStop();
    state.healthMonitorStop = null;
    l.info('Health monitor stopped');
  }

  // REQ-CFA-004 (Task 5.1): stop the additive canary cell-rotation loop.
  if (state.canaryCellLoop) {
    state.canaryCellLoop.stop();
    state.canaryCellLoop = null;
    l.info('Canary cell loop stopped');
  }

  // REQ-CFA-042/043 (M4a chunk 3): stop the additive canary verify loop.
  if (state.canaryVerifyLoop) {
    state.canaryVerifyLoop.stop();
    state.canaryVerifyLoop = null;
    l.info('Canary verify loop stopped');
  }

  // B2 (REQ-MLW-B-01/02): tear down the live pipe-tap consumer (mediasoup worker + standby pipe).
  // No-op when CANARY_LIVE_CAPTURE != 'pipe' (state.liveConsumer stays null) — byte-identical OFF.
  if (state.liveConsumer) {
    state.liveConsumer.shutdown();
    state.liveConsumer = null;
    l.info('Canary live consumer stopped');
  }

  // Stage 4.5 (C1 cross-host): stop the local /canary/claims mTLS server (live mode only). stopDaemon
  // is sync -> fire-and-forget the graceful close (the process is exiting); errors are swallowed.
  if (state.canaryClaimsServer) {
    void state.canaryClaimsServer.stop().catch(() => {});
    state.canaryClaimsServer = null;
    l.info('Canary claims mTLS server stopped');
  }

  // M2 chunk 1 (REQ-CFA-015): close the off-chain coverage feed server.
  if (state.coverageServer) {
    state.coverageServer.close();
    state.coverageServer = null;
    l.info('Canary coverage server stopped');
  }

  if (state.heartbeatStop) {
    state.heartbeatStop();
    state.heartbeatStop = null;
    l.info('Heartbeat loop stopped');
  }

  if (state.measurementTimer) {
    clearInterval(state.measurementTimer);
    state.measurementTimer = null;
    l.info('Measurement loop stopped');
  }

  if (state.eventPoller) {
    state.eventPoller.stop();
    state.eventPoller = null;
    l.info('Event poller stopped');
  }

  if (state.escrowPoller) {
    state.escrowPoller.stop();
    state.escrowPoller = null;
    l.info('Escrow poller stopped');
  }

  if (state.roomPoller) {
    state.roomPoller.stop();
    state.roomPoller = null;
    l.info('Room poller stopped');
  }

  l.info('Validator daemon shut down');
}

// ── P17 M2b-P9 (DOH-021/022/023/024): F60 graceful shutdown ──────────

/**
 * The validator daemon's teardown closures, injected into
 * {@link buildValidatorShutdownPlan}. Unifies the old `stopDaemon` + `main().shutdown`
 * into the ordered drain → reactive → liveness-LAST groups.
 */
export interface ValidatorShutdownDeps {
  logger: Logger;
  /** (1) Flip `state.running=false` so no NEW measurement cycle starts. */
  setRunning: (running: boolean) => void;
  /** (2) drain — await the in-flight measurement cycle (no cancel, DOH-022). */
  drainMeasurement: () => Promise<void>;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener pollers. */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the periodic measurement interval. */
  stopMeasurementTimer: () => void;
  /** (3) reactive — the validator_registry / economic_layer / room_manager pollers. */
  stopPollers: () => void;
  /** (3) reactive — the optional bench latency probe. */
  stopProbe: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the daemon live). */
  stopHeartbeat: () => void;
  /** (4) LAST — the /healthz liveness server. */
  closeHealthz: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * Assemble the validator daemon's ordered graceful-shutdown plan, encoding the
 * two cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops in
 *         `stopReactive` (with the watcher + ChainEventListener + the measurement
 *         timer + the 3 event pollers), NOT first.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz) so the chain sees
 *         the validator LIVE through the whole drain (D-DOH-M2-F60-3 split-brain fix).
 * The drain awaits the in-flight measurement cycle (no cancel), bounded by 30s.
 * Exported (not inline) so the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildValidatorShutdownPlan(
  reason: string,
  deps: ValidatorShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: deps.setRunning,
    drain: async () => {
      await deps.drainMeasurement();
    },
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      deps.stopMeasurementTimer();
      deps.stopPollers();
      deps.stopProbe();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      await deps.closeHealthz();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * Assemble + start the validator daemon's F60 SelfShutdownWatcher.
 *
 * The validator is REPORT-ONLY on slash (not slashable) → arms = { degraded, paused }
 * (NO `slash` ⇒ it never subscribes economic_layer). `ownMinerId` = the cap's
 * `miner_id` FIELD (the ID carried by `NodeDegraded.miner_id`), read off-chain via
 * {@link readCapMinerId} — NOT the cap OBJECT id. The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * Exported so the arms + self-filter id + isPaused wiring is unit-testable.
 */
export async function startValidatorSelfShutdownWatcher(args: {
  client: SuiClient;
  config: NetworkConfig;
  validatorCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, validatorCapId, listener, onSelfShutdown, logger: log } = args;
  const ownMinerId = await readCapMinerId(client, validatorCapId, log);
  if (ownMinerId === null) {
    log.warn(
      { validatorCapId },
      'startValidatorSelfShutdownWatcher: could not resolve own miner_id — degraded self-filter will not match (paused arm stays active)',
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
