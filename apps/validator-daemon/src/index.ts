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
 */

import 'dotenv/config';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  generateSessionKeypair,
  EventPoller,
  createLogger,
  startHealthzServer,
  genTraceId,
  traceChild,
  economicLayerModuleName,
  MIN_PROOFS_FOR_DISTRIBUTION,
  readIsPaused,
  readCapMinerId,
} from '@dvconf/shared';
import type { NetworkConfig, Logger, HealthzHandle } from '@dvconf/shared';
import type { EscrowCreated, RoomCreated, RoomClosed, RoomAssigned } from '@dvconf/shared';
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
import { buildHealthSignals, type ValidatorHealthDeps } from './health-signals.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { collectMeasurements } from './measurements.js';
import { createRelayProbe, type RelayProbeEndpoint } from './probe.js';
import {
  buildSessionProof,
  dualKeySign,
  serializeProofBcs,
  logProofSummary,
  submitSessionProof,
} from './session-proof.js';
import { waitForProofs, triggerDistribution } from './reward-trigger.js';
import { timedMeasureRoom, closeValidatorProbe } from './latency-probe.js';

const logger = createLogger('validator-daemon');

/** F61 rolling-RTT window size (DOH-014): average of the latest N reachable RTTs. */
const RTT_WINDOW = 10;

/** Configuration for the measurement loop. */
export interface ValidatorConfig {
  /** Interval between measurement cycles in ms (default: 60000). */
  measurementIntervalMs: number;
  /** Validator miner ID (from registration). */
  validatorMinerId: string;
}

/** Tracked state per active room. */
export interface ActiveRoom {
  /** Escrow object ID for this room (discovered via EscrowCreated). */
  escrowId?: string;
  /**
   * Primary relay miner ID (RoomAssigned.relay_ids[0], relay_role==0).
   * Always present once the room is assigned.
   */
  primaryRelayId?: string;
  /**
   * Standby relay miner ID (RoomAssigned.relay_ids[1], relay_role==1).
   * Undefined when the room was assigned with a single relay (length guard).
   * RO-019a: the validator probes + submits a per-relay proof for BOTH slots.
   */
  standbyRelayId?: string;
}

/** Internal state for the running daemon. */
export interface DaemonState {
  client: SuiClient;
  mainKeypair: Ed25519Keypair;
  sessionKeypair: Ed25519Keypair;
  sessionAddress: string;
  config: NetworkConfig;
  validatorCapId: string;
  measurementTimer: ReturnType<typeof setInterval> | null;
  eventPoller: EventPoller | null;
  escrowPoller: EventPoller | null;
  roomPoller: EventPoller | null;
  escrowMap: Map<string, string>;
  activeRooms: Map<string, ActiveRoom>;
  /** Stop function returned by startHeartbeat (F40). */
  heartbeatStop: (() => void) | null;
  /**
   * F61 health signals (DOH-014). `rttSamplesMs` = a bounded rolling window of the
   * latest reachable-cycle RTTs (probe avgLatencyMs); `consecutiveUnreachable` =
   * count of back-to-back unreachable measureRelay results (reset on any reachable).
   * Both prime to 0 / [] (= healthy) until the first measurement cycle.
   */
  rttSamplesMs: number[];
  consecutiveUnreachable: number;
  /** Stop function for the F61 HealthMonitor (DOH-018). */
  healthMonitorStop: (() => void) | null;
  running: boolean;
  /**
   * P17 M2b-P9 (DOH-022): the currently-running measurement cycle promise (or null
   * when idle). The graceful-shutdown drain awaits it so an in-flight per-relay
   * proof submit completes before teardown (no cancel) — bounded by the 30s drain.
   */
  inFlightMeasurement: Promise<void> | null;
}

/**
 * P17 M2a-P11 — assemble + start the validator daemon's F61 HealthMonitor
 * (DOH-014/016/017/018). Binds the HARD GATE `operator := signer.toSuiAddress()`
 * using the MAIN wallet (`signer` here MUST be `mainKeypair` — the operator that
 * owns the MinerCap; the session key signs proofs, not operator-gated calls). The
 * same signer makeChainReporter signs with → operator == ctx.sender(), so
 * report_node_degradation does not abort (E_NOT_OPERATOR, node_health.move:81).
 * variant 'miner' (node_type=1 validator, derived on-chain). Exported so the wiring
 * is unit-testable.
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  validatorCapId: string;
  deps: ValidatorHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, validatorCapId, deps, logger: log, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: validatorCapId,
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
}): Promise<DaemonState> {
  const log = overrides?.logger ?? logger;

  // Load configuration
  const config = overrides?.config ?? loadNetworkConfig();
  const client = overrides?.client ?? createSuiClient(config.rpcUrl);
  const mainKeypair = overrides?.mainKeypair ?? loadKeypair('SUI_PRIVATE_KEY');

  const mainAddress = mainKeypair.getPublicKey().toSuiAddress();

  // Auto-register if needed
  const { validatorCapId } = await ensureRegistered(client, mainKeypair, config, log);

  // Generate session wallet -- fresh Ed25519Keypair, NOT derived from main wallet
  const { keypair: sessionKeypair, address: sessionAddress } = generateSessionKeypair();

  // Register session wallet on-chain so submit_session_proof can look it up
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(validatorCapId),
        tx.pure.address(sessionAddress),
      ],
    });
    const res = await client.signAndExecuteTransaction({ signer: mainKeypair, transaction: tx });
    await client.waitForTransaction({ digest: res.digest });
    log.info({ digest: res.digest, sessionAddress }, 'Session wallet registered on-chain');

    // Fund session wallet with gas so it can send proof TXs
    const fundTx = new Transaction();
    const [coin] = fundTx.splitCoins(fundTx.gas, [500_000_000]); // 0.5 SUI
    fundTx.transferObjects([coin], sessionAddress);
    const fundRes = await client.signAndExecuteTransaction({ signer: mainKeypair, transaction: fundTx });
    await client.waitForTransaction({ digest: fundRes.digest });
    log.info({ digest: fundRes.digest, sessionAddress, amount: '0.5 SUI' }, 'Session wallet funded');
  }

  log.info(
    { mainAddress, sessionAddress },
    `Validator daemon started -- main wallet: ${mainAddress}, session wallet: ${sessionAddress}`,
  );

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
    escrowMap,
    activeRooms,
    heartbeatStop: null,
    rttSamplesMs: [],
    consecutiveUnreachable: 0,
    healthMonitorStop: null,
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

  // Start event poller for validator_registry events
  const eventPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/validator-events.json',
    logger: log,
  });

  state.eventPoller = eventPoller;

  await eventPoller.start(async (event) => {
    log.info(
      { type: event.type, parsedJson: event.parsedJson },
      `Validator event received: ${event.type}`,
    );
  });

  // Start event poller for economic_layer EscrowCreated events (IC-3)
  const escrowPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: economicLayerModuleName,
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/economic-events.json',
    logger: log,
  });

  state.escrowPoller = escrowPoller;

  await escrowPoller.start(async (event) => {
    // IC-3: EscrowCreated Event Contract
    if (event.type.endsWith('::EscrowCreated')) {
      const parsed = event.parsedJson as unknown as EscrowCreated;
      if (parsed.room_id && parsed.escrow_id) {
        escrowMap.set(parsed.room_id, parsed.escrow_id);

        // Update active room record with escrow ID
        const room = activeRooms.get(parsed.room_id);
        if (room) {
          room.escrowId = parsed.escrow_id;
        } else {
          activeRooms.set(parsed.room_id, { escrowId: parsed.escrow_id });
        }

        log.info(
          { roomId: parsed.room_id, escrowId: parsed.escrow_id },
          `EscrowCreated discovered -- room=${parsed.room_id}, escrow=${parsed.escrow_id}`,
        );
      }
    }

    // Log other economic layer events
    if (event.type.endsWith('::SessionProofSubmitted')) {
      log.info(
        { parsedJson: event.parsedJson },
        `SessionProofSubmitted event: ${event.type}`,
      );
    }
  });

  // Start event poller for room_manager RoomCreated/RoomClosed events
  const roomPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'room_manager',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/room_manager.json',
    logger: log.child({ poller: 'room_manager' }),
  });

  state.roomPoller = roomPoller;

  await roomPoller.start(async (event) => {
    if (event.type.endsWith('::RoomCreated')) {
      const parsed = event.parsedJson as unknown as RoomCreated;
      if (parsed.room_id) {
        // Phase 18: Don't auto-add. Wait for RoomAssigned with our validator ID.
        log.info(
          { roomId: parsed.room_id, creator: (parsed as any).creator },
          `RoomCreated -- room=${parsed.room_id} (waiting for assignment)`,
        );
      }
    }

    if (event.type.endsWith('::RoomClosed')) {
      const parsed = event.parsedJson as unknown as RoomClosed;
      if (parsed.room_id) {
        log.info(
          { roomId: parsed.room_id },
          `RoomClosed -- room=${parsed.room_id}, checking for reward distribution`,
        );

        // Handle room close -> reward distribution
        void handleRoomClosed(state, parsed.room_id, log);
      }
    }

    // BUG-INT-001: Handle RoomAssigned to populate relay slots dynamically.
    // RO-019a: read BOTH relay slots (primary + standby) from relay_ids; the
    // standby id is already in-event (relay_ids[1]) -- guard the length so a
    // single-relay assignment leaves standbyRelayId undefined.
    if (event.type.endsWith('::RoomAssigned')) {
      const parsed = event.parsedJson as unknown as RoomAssigned;
      const relayIds: string[] = parsed.relay_ids ?? [];
      const primaryRelayId = relayIds[0];
      const standbyRelayId = relayIds.length > 1 ? relayIds[1] : undefined;
      const validatorIds: string[] = parsed.validator_ids ?? [];

      // Phase 18: Only track rooms where we are an assigned validator
      if (parsed.room_id && primaryRelayId && validatorIds.includes(validatorMinerId)) {
        const room = activeRooms.get(parsed.room_id) ?? {};
        room.primaryRelayId = primaryRelayId;
        room.standbyRelayId = standbyRelayId;

        if (!activeRooms.has(parsed.room_id)) {
          activeRooms.set(parsed.room_id, room);
        }

        log.info(
          { roomId: parsed.room_id, primaryRelayId, standbyRelayId },
          `RoomAssigned -- assigned to room=${parsed.room_id}, primary=${primaryRelayId}, standby=${standbyRelayId ?? 'none'}`,
        );
      } else if (parsed.room_id) {
        log.debug(
          { roomId: parsed.room_id, validatorIds, ownId: validatorMinerId },
          `RoomAssigned -- not assigned to room=${parsed.room_id}, ignoring`,
        );
      }
    }
  });

  return state;
}

/**
 * Handle a RoomClosed event: wait for proofs then trigger distribution.
 */
async function handleRoomClosed(
  state: DaemonState,
  roomId: string,
  log: Logger,
): Promise<void> {
  const escrowId = state.escrowMap.get(roomId);
  if (!escrowId) {
    log.info(
      { roomId },
      `No escrow found for closed room=${roomId} -- skipping reward distribution`,
    );
    // Remove from active rooms
    state.activeRooms.delete(roomId);
    return;
  }

  try {
    // Wait for sufficient session proofs to be submitted
    const hasProofs = await waitForProofs(
      state.client,
      escrowId,
      MIN_PROOFS_FOR_DISTRIBUTION,
      60_000,
      log,
    );

    if (hasProofs) {
      await triggerDistribution(
        state.client,
        state.mainKeypair,
        state.config,
        escrowId,
        roomId,
        log,
      );
    } else {
      log.warn(
        { roomId, escrowId },
        `Insufficient proofs for room=${roomId} -- skipping reward distribution`,
      );
    }
  } catch (err) {
    log.error({ err, roomId, escrowId }, `Reward distribution failed for room=${roomId}`);
  }

  // Remove from active rooms after processing
  state.activeRooms.delete(roomId);
  state.escrowMap.delete(roomId);
}

/**
 * Run a single measurement cycle:
 * 1. Cycle through all active rooms (or fallback to env ROOM_ID)
 * 2. Collect measurements for relay
 * 3. Fetch relay metrics for real unique_peers count
 * 4. Build SessionProof
 * 5. BCS serialize + dual-key sign (IC-2, IC-4)
 * 6. Submit on-chain if escrow is known, otherwise log only
 */
async function runMeasurementCycle(
  state: DaemonState,
  validatorMinerId: string,
  log: Logger,
): Promise<void> {
  // Determine which rooms to measure
  const roomIds: string[] = [];
  if (state.activeRooms.size > 0) {
    for (const roomId of state.activeRooms.keys()) {
      roomIds.push(roomId);
    }
  } else {
    // Fallback to single ROOM_ID from env
    roomIds.push(process.env['ROOM_ID'] ?? 'unassigned');
  }

  // F63 (DOH-003): birth one trace id per measurement cycle and bind it to the
  // cycle logger, so every line — including the on-chain proof-submit log — is
  // correlated, and thread the id to the relay probe legs (x-trace-id edges 1+2).
  const traceId = genTraceId();
  const cycleLog = traceChild(log, traceId);

  for (const roomId of roomIds) {
    try {
      // S23.1.A3: wrap measureRoom with `L_validator_check` timer.
      // Pass-through when BENCH_LATENCY is unset (no allocation in hot path).
      await timedMeasureRoom(
        roomId,
        () => state.activeRooms.get(roomId)?.primaryRelayId ?? null,
        () => measureRoom(state, roomId, validatorMinerId, cycleLog, traceId),
      );
    } catch (err) {
      cycleLog.error({ err, roomId }, `Measurement cycle failed for room=${roomId}`);
    }
  }
}

/**
 * Resolve the per-relay probe endpoint from env config.
 *
 * Today a single `RELAY_METRICS_URL` (+ optional `RELAY_STUN_HOST`/`_PORT`)
 * applies to every relay; per-relay multi-host resolution (each standby's own
 * routable URL) couples to G3 (G3.0/G3.2). Externalized with sane defaults
 * (no production hardcodes).
 *
 * RO-020: for the STANDBY relay, the standby `/api/probe` liveness channel is
 * wired (`livenessUrl`) so a FAILED/unanswered probe gates the standby proof's
 * `duration_seconds` to 0. The standby's probe base defaults to the same
 * `RELAY_METRICS_URL` (single-host bench); `STANDBY_PROBE_URL` overrides it for
 * a distinct standby host (multi-host = G3). The PRIMARY is never gated.
 */
function resolveProbeEndpoint(isStandby: boolean): RelayProbeEndpoint {
  const stunPortRaw = process.env['RELAY_STUN_PORT'];
  const metricsBaseUrl = process.env['RELAY_METRICS_URL'] ?? '';
  const endpoint: RelayProbeEndpoint = {
    metricsBaseUrl,
    stunHost: process.env['RELAY_STUN_HOST'] ?? '',
    stunPort: stunPortRaw ? parseInt(stunPortRaw, 10) : undefined,
  };
  if (isStandby) {
    // Treat an explicitly-empty STANDBY_PROBE_URL like unset, so a standby never
    // skips the liveness leg — an empty livenessUrl would let it report
    // duration_seconds>0 from the metrics leg WITHOUT a successful /api/probe,
    // bending the frozen standby-liveness contract (paid IFF probe-answered).
    const standbyProbeUrl = process.env['STANDBY_PROBE_URL'];
    endpoint.livenessUrl =
      standbyProbeUrl && standbyProbeUrl.length > 0 ? standbyProbeUrl : metricsBaseUrl;
  }
  return endpoint;
}

/**
 * Measure a single room: per-relay probe + proof submit for EACH assigned relay.
 *
 * RO-019a: a room is assigned a primary + (optional) standby relay. The
 * validator probes both and submits a per-relay SessionProof for each (2
 * submits/cycle at K=2). The compound dedup key (on-chain RO-023a) lets one
 * validator attest both relays without aborting E_ALREADY_SUBMITTED=656.
 */
async function measureRoom(
  state: DaemonState,
  roomId: string,
  validatorMinerId: string,
  log: Logger,
  traceId: string,
): Promise<void> {
  // Resolve relay slots from the room's on-chain assignment (via RoomAssigned).
  const room = state.activeRooms.get(roomId);
  // RO-020: track which slot is the standby (relay_role==1) — only the standby
  // is liveness-gated via /api/probe.
  const relays: Array<{ relayMinerId: string; isStandby: boolean }> = [];
  if (room?.primaryRelayId) relays.push({ relayMinerId: room.primaryRelayId, isStandby: false });
  if (room?.standbyRelayId) relays.push({ relayMinerId: room.standbyRelayId, isStandby: true });

  if (relays.length === 0) {
    log.debug(
      { roomId },
      `No relay assigned to room=${roomId} yet -- skipping measurement`,
    );
    return;
  }

  for (const { relayMinerId, isStandby } of relays) {
    await measureRelay(state, roomId, relayMinerId, isStandby, validatorMinerId, log, traceId);
  }
}

/**
 * Measure a single relay within a room: collect metrics, build proof, sign,
 * submit. One SessionProof per relay (RO-019a per-relay dual-probe).
 *
 * RO-020: when `isStandby`, the probe is liveness-gated via the standby's
 * `/api/probe` channel — a failed/unanswered probe forces `duration_seconds=0`.
 */
async function measureRelay(
  state: DaemonState,
  roomId: string,
  relayMinerId: string,
  isStandby: boolean,
  validatorMinerId: string,
  log: Logger,
  traceId: string,
): Promise<void> {
  // RO-019b: derive the measurement from a REAL probe (STUN RTT + relay
  // metrics HTTP) instead of the removed random simulation. Per-relay endpoint
  // is resolved via env (single RELAY_METRICS_URL today; multi-host = G3).
  // RO-020: the standby additionally carries the /api/probe liveness gate.
  const probe = createRelayProbe(roomId, () => resolveProbeEndpoint(isStandby), undefined, traceId);
  const measurement = await collectMeasurements(relayMinerId, probe);

  // F61 health signals (DOH-014): a reachable cycle (unreachableSample =>
  // measurementDurationMs 0n) resets the consecutive-unreachable counter and folds
  // its RTT into the bounded rolling window; an unreachable cycle bumps the counter
  // (RTT NOT recorded — avgLatencyMs is 0n on an unreachable sample and would poison
  // the rolling mean toward healthy while the unreachable signal rises).
  if (measurement.measurementDurationMs > 0n) {
    state.consecutiveUnreachable = 0;
    state.rttSamplesMs.push(Number(measurement.avgLatencyMs));
    if (state.rttSamplesMs.length > RTT_WINDOW) state.rttSamplesMs.shift();
  } else {
    state.consecutiveUnreachable += 1;
  }

  const epoch = BigInt(Math.floor(Date.now() / 1000));

  const proof = buildSessionProof(
    roomId,
    relayMinerId,
    validatorMinerId,
    state.sessionAddress,
    measurement,
    epoch,
  );

  // IC-2: BCS serialize for signing (replaces legacy JSON serialization).
  // OFF-3 reconciled: the SAME real uniquePeers signs and submits (no 0n drift).
  const durationSeconds = measurement.measurementDurationMs / 1000n;
  const bcsMessage = serializeProofBcs(
    proof.roomId,
    proof.relayMinerId,
    measurement.packetsSent,
    measurement.bytesForwarded,
    measurement.uniquePeers,
    durationSeconds,
    measurement.avgLatencyMs,
    measurement.packetLossRate,
    measurement.jitterMs,
  );

  await dualKeySign(bcsMessage, state.mainKeypair, state.sessionKeypair);

  logProofSummary(proof);

  // Attempt on-chain submission if escrow is discovered for this room
  const escrowId = state.escrowMap.get(roomId);
  if (escrowId) {
    await submitSessionProof(
      state.client,
      state.sessionKeypair,
      state.mainKeypair,
      state.config,
      escrowId,
      proof,
      log,
    );
  } else {
    log.info(
      { roomId },
      `No escrow found for room=${roomId} -- proof signed but not submitted. Waiting for EscrowCreated event.`,
    );
  }
}

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

// -- Main entry point --

/* istanbul ignore next -- CLI entry point */
async function main(): Promise<void> {
  let state: DaemonState | null = null;
  let healthz: HealthzHandle | undefined;
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
        },
        stopProbe: closeValidatorProbe,
        stopHeartbeat: () => {
          s.heartbeatStop?.(); // C-B → LAST
          s.heartbeatStop = null;
        },
        closeHealthz: () => healthz?.close() ?? Promise.resolve(),
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

    // P17 M2b-P9 (DOH-019/027): the ChainEventListener backing the F60
    // SelfShutdownWatcher (node_health subscribe) + the /healthz isLive gate.
    const listener = new ChainEventListener({
      client,
      packageId: config.packageId,
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

    state = await startDaemon({ client, config });

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
