/**
 * Validator Daemon -- bootstrap.
 *
 * Extracted from the former `index.ts` monolith: `startHealthMonitor` (now in
 * `./health-monitor.js`), `refreshDiscoveredValidators` (now in
 * `./validator-discovery.js`), and `startDaemon` (the full daemon startup
 * sequence -- wallets/registration, canary cell-loop + coverage server, canary
 * verify-loop + live-capture + claims server, measurement-loop kickoff, event
 * pollers, and the liveness sweep). The named setup phases inside `startDaemon`'s
 * body (registration/session-wallet, canary cell-loop+coverage, canary
 * verify-loop+claims) live in `./bootstrap-steps.js`. `startDaemon` itself calls
 * out to those plus `./event-pollers.js` and `./measurement-cycle.js`.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  createSuiClient,
  createGraphQLClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
} from '@dvconf/shared';
import type { NetworkConfig, Logger, RegistrationGauge } from '@dvconf/shared';
import { startHeartbeat } from '../heartbeat.js';
import type { CanaryMetricsSetters } from '../canary/canary-metrics.js';
import { runMeasurementCycle } from './measurement-cycle.js';
import { startEventPollers } from './event-pollers.js';
import type { DaemonState, ActiveRoom } from './state.js';
import { startHealthMonitor } from './health-monitor.js';
import {
  registerAndSetupSessionWallet,
  startCanaryCellLoopAndCoverage,
  startCanaryVerifyLoopAndClaims,
} from './bootstrap-steps.js';

export { startHealthMonitor } from './health-monitor.js';

const logger = createLogger('validator-daemon');

/**
 * Start the validator daemon.
 *
 * Exported for testing -- returns the daemon state for lifecycle control.
 */
export async function startDaemon(overrides?: {
  client?: SuiClient;
  mainKeypair?: Ed25519Keypair;
  config?: NetworkConfig;
  logger?: Logger;
  /** Monitoring-redesign gap #4 (optional; default no-op -> byte-identical without it). */
  canaryMetrics?: CanaryMetricsSetters;
  /** Set once ensureRegistered() resolves (optional; omitted in tests that don't wire metrics). */
  registrationGauge?: RegistrationGauge;
}): Promise<DaemonState> {
  const log = overrides?.logger ?? logger;

  // Load configuration
  const config = overrides?.config ?? loadNetworkConfig();
  const client = overrides?.client ?? createSuiClient(config.rpcUrl);
  // Event queries only (EventPoller below) -- see createGraphQLClient's docstring.
  const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');
  const mainKeypair = overrides?.mainKeypair ?? loadKeypair('SUI_PRIVATE_KEY');

  // Auto-register (if needed) + generate/register/fund the session wallet.
  const { validatorCapId, sessionKeypair, sessionAddress, mainAddress } =
    await registerAndSetupSessionWallet({
      client,
      mainKeypair,
      config,
      log,
      graphqlClient,
      registrationGauge: overrides?.registrationGauge,
    });

  // Escrow map: roomId -> escrowObjectId (discovered via EscrowCreated events, IC-3)
  const escrowMap = new Map<string, string>();

  // Active rooms: roomId -> { escrowId, relayStakeId }
  const activeRooms = new Map<string, ActiveRoom>();

  // Daemon state
  const state: DaemonState = {
    client,
    mainKeypair,
    sessionKeypair,
    sessionAddress,
    config,
    validatorCapId,
    measurementTimer: null,
    eventPoller: null,
    escrowPoller: null,
    roomPoller: null,
    livenessSweep: null,
    roomHealthVoteWatcher: null,
    roomHealthExpirySweep: null,
    escrowMap,
    activeRooms,
    heartbeatStop: null,
    rttSamplesMs: [],
    consecutiveUnreachable: 0,
    relayStunLossBps: new Map(),
    relayMetricsUrls: new Map(),
    relayPathSamples: new Map(),
    healthMonitorStop: null,
    canaryCellLoop: null,
    canaryVerifyLoop: null,
    canaryClaimsServer: null,
    liveConsumer: null,
    discoveredValidatorMinerIds: undefined,
    coverageServer: null,
    running: true,
    inFlightMeasurement: null,
  };

  // F40: Start periodic liveness heartbeat (signed by main wallet -- operator check on-chain).
  // Cadence default 30s; consumed by room_manager.move PVR_HEARTBEAT_STALE=7 epochs eligibility.
  const heartbeatIntervalMs = parseInt(process.env['VALIDATOR_HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
  state.heartbeatStop = startHeartbeat(
    client,
    mainKeypair,
    config,
    validatorCapId,
    heartbeatIntervalMs,
    log,
  );

  // DOH-014/016/017/018: start the F61 self-degradation HealthMonitor. Signed by the
  // MAIN wallet (operator that owns the MinerCap — NOT the session key). Additive loop
  // alongside the heartbeat + measurement cycle; getters read the rolling-RTT window +
  // consecutive-unreachable counter on `state` (updated per measureRelay).
  state.healthMonitorStop = startHealthMonitor({
    client,
    signer: mainKeypair,
    config,
    validatorCapId,
    logger: log,
    deps: {
      getRttMs: () =>
        state.rttSamplesMs.length === 0
          ? 0
          : state.rttSamplesMs.reduce((a, b) => a + b, 0) / state.rttSamplesMs.length,
      getConsecutiveUnreachable: () => state.consecutiveUnreachable,
    },
  }).stop;

  // Read measurement config from env
  const measurementIntervalMs = parseInt(process.env['MEASUREMENT_INTERVAL_MS'] ?? '60000', 10);
  // Miner ID = object::id_from_address(sender) on-chain, which equals the wallet address
  const validatorMinerId = mainAddress;
  const pollIntervalMs = 10_000;

  // Additive canary cell-rotation loop + off-chain coverage feed (crash-safe; daemon
  // continues even if this fails to start). See bootstrap-steps.ts for the full rationale.
  startCanaryCellLoopAndCoverage({ state, log, sessionAddress, validatorMinerId });

  // Additive canary verify loop (+ live-capture bring-up + claims mTLS server in live mode).
  // Crash-safe in its OWN try, independent of the cell loop. See bootstrap-steps.ts.
  await startCanaryVerifyLoopAndClaims({
    state,
    log,
    sessionAddress,
    sessionKeypair,
    validatorMinerId,
    canaryMetrics: overrides?.canaryMetrics,
  });

  // P17 M2b-P9 (DOH-022): track the in-flight cycle so the graceful-shutdown drain
  // can await it (no cancel). The `.finally` clears the handle once the cycle settles.
  const runCycle = (): void => {
    state.inFlightMeasurement = runMeasurementCycle(state, validatorMinerId, log).finally(() => {
      state.inFlightMeasurement = null;
    });
    void state.inFlightMeasurement;
  };

  // Start periodic measurement loop -- cycles through all active rooms
  state.measurementTimer = setInterval(() => {
    if (!state.running) return;
    runCycle();
  }, measurementIntervalMs);

  // Run one cycle immediately
  runCycle();

  // Start the validator_registry / EscrowCreated / RoomCreated+RoomClosed+RoomAssigned
  // event pollers, plus the liveness sweep.
  await startEventPollers(state, graphqlClient, validatorMinerId, pollIntervalMs, log);

  return state;
}
