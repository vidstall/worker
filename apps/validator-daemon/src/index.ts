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
import { readFileSync } from 'node:fs';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
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
import {
  startCanaryCellLoop,
  deriveAssignmentSecret,
  type CanaryValidator,
  type CanaryCellLoopHandle,
  type RelayRoomScope,
} from './canary/cell.js';
import { discoverActiveValidatorMinerIds } from './canary/validator-discovery.js';
import { buildRelayScopedValidatorPool, type ScopedRoom } from './canary/validator-pool.js';
import { startCoverageServer, type CoverageStateProvider } from './canary/coverage-server.js';
import {
  startCanaryVerifyLoop,
  type CanaryVerifyLoopHandle,
  type CanaryForwardCaptureResult,
} from './canary/verify-loop.js';
import { InMemoryClaimBoard } from './canary/claim-board.js';
import { buildLiveSeams, loadCanaryTls, selectCaptureMode } from './canary/live-seams.js';
import {
  bringUpLiveConsumer,
  type LiveConsumerRuntime,
  type PipedProducerDescriptor,
} from './canary/live-consumer-runtime.js';
import { chooseCapture } from './capture-precedence.js';
import {
  startCanaryClaimsServer,
  isCanaryClaimsTlsEnabled,
  type StartCanaryClaimsResult,
} from './canary/claims-server.js';

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
  /**
   * REQ-CFA-023 (M3 chunk 1, D-CFA-24): the co-auditor validator miner_ids for THIS
   * room, sourced from the in-event `RoomAssigned.validator_ids` (already parsed for the
   * self-membership test, then discarded — ZERO new chain cost). M4a chunk 1 (D-CFA-30):
   * per-relay scopes the canary validator pool (`buildRelayScopedValidatorPool`) so coverage
   * is reported/assigned over ONLY the co-auditors of the room(s) a given relay serves, NOT
   * the cross-room union (closes the over-count W-M3-OVERCOUNT; M3 closed the registry-wide
   * over-count W-M2-3). Written ONLY by the RoomAssigned arm; relay promotion leaves it
   * unchanged (promote_relay touches only assigned_relays — W-M3-STALE). Defaults to [].
   */
  validatorIds?: string[];
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
  /**
   * REQ-CFA-029 (M3 chunk 2, D-CFA-26): the latest validator-probed STUN packet-loss
   * (basis points) per relayMinerId. Written in `measureRelay` (next to the rttSamplesMs
   * push) from `measurement.packetLossRate` — a value the per-relay session-proof BCS
   * folds in (~:821) then otherwise DISCARDS. This is the per-relay SEAM that WILL be read by
   * the loss classifier once the verify loop is wired (Task 5.2+, W-M3-SIM): the classifier
   * is pure/test-only today (zero production callers), so this is written-now-read-later — NOT
   * yet a live data path. When wired it folds into the classifier's BUDGET (D-CFA-25,
   * stunPacketLossBps + delta): STUN-UDP != canary-RTP and the probe is a single global host,
   * so it is a COARSE prior, NOT a binding signal (not per-relay-attributed until G3).
   */
  relayStunLossBps: Map<string, bigint>;
  /** Stop function for the F61 HealthMonitor (DOH-018). */
  healthMonitorStop: (() => void) | null;
  /**
   * REQ-CFA-004 (Task 5.1): the additive deterministic canary cell-rotation loop handle
   * (per-relay >=2-distinct-miner_id coverage). Null if the loop failed to start — its
   * start is guarded so a fault cannot crash the daemon. `latest()` feeds the downstream
   * covert-publish / verify loops (Task 5.2+).
   */
  canaryCellLoop: CanaryCellLoopHandle | null;
  /**
   * REQ-CFA-042/043 (M4a chunk 3, D-CFA-33): the additive crash-safe canary VERIFY loop handle
   * (verifyForwardedCanary -> classifyDivergences -> buildDivergenceProof -> submit, behind an
   * injectable capture+submit seam). Null if the loop failed to start (guarded) — its start is
   * wrapped so a fault can NEVER abort the daemon. It is the FIRST real reader of
   * `relayStunLossBps` (closes W-M3-STUN-PATH). The production capture seam yields NO live
   * frames yet (the live producer/SFU-forward/consumer media plane is M4b, port-locked); the
   * loop is WIRED and reads STUN, but promotes nothing until M4b supplies live captures
   * (W-M3-SIM narrowed; this loop AMPLIFIES the off-chain gate W-M3-OFFCHAIN — on record).
   */
  canaryVerifyLoop: CanaryVerifyLoopHandle | null;
  /**
   * Stage 4.5 (multi-cp-quorum, C1 cross-host): the local `/canary/claims` mTLS SERVER, started ONLY
   * when the live seams are active (master flag CANARY_LIVE_SEAMS_ENABLED). It shares the verify-loop's
   * `localBoard` instance so a PEER's POSTed self-attestation accrues onto the SAME board this daemon
   * assembles from -> the >=2-distinct quorum can form cross-host (PLAN-m4b-hermetic §3.2). Null in
   * vanilla mode (flag off) -> no server, byte-identical to the pre-Stage-4 daemon.
   */
  canaryClaimsServer: StartCanaryClaimsResult | null;
  /**
   * M2b-live-WAN B2 (REQ-MLW-B-01/02): the REAL pipe-tap consumer runtime (a mediasoup worker +
   * standby F1 pipe + live consumer), brought up ONLY when CANARY_LIVE_CAPTURE=pipe. Its `.capture`
   * is swapped into the verify-loop seam (via chooseCapture) so the loop verifies REAL forwarded
   * frames. Null in the default/byte-identical-OFF path (flag unset / any other value) — then the
   * verify-loop keeps its EXACT empty no-op capture. Shut down in BOTH teardown sites.
   */
  liveConsumer: LiveConsumerRuntime | null;
  /**
   * M2 chunk 2 (REQ-CFA-019/020): the latest live-discovered active-validator miner_ids
   * (Wallet-A ids from validator_registry::get_active_validators), refreshed each canary
   * round and UNIONed with the self-entry inside the cell loop's getValidators. Undefined
   * until the first discovery refresh resolves (crash-safe: a failed refresh leaves the
   * last good cache, and the union always re-adds the self-entry → never below self-only).
   */
  discoveredValidatorMinerIds?: string[];
  /**
   * M2 chunk 1 (REQ-CFA-013/015): the off-chain coverage feed HTTP server handle (loopback,
   * port VALIDATOR_CANARY_COVERAGE_PORT). Null if it failed to start (guarded). Closed in
   * the LAST shutdown group next to the healthz close.
   */
  coverageServer: import('node:http').Server | null;
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
    relayStunLossBps: new Map(),
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

  // REQ-CFA-004 (Task 5.1) + M2 chunks 1-3: start the additive deterministic canary
  // cell-rotation loop AND the off-chain coverage feed.
  // ADDITIVE + CRASH-SAFE — wrapped so a fault here can NEVER abort the daemon startup
  // (mirrors how startHeartbeat / startHealthMonitor are additive side-loops).
  //
  // M2 chunk 3 (REQ-CFA-022 / D-CFA-19): the loop folds a VALIDATOR-HELD assignmentSecret
  // into the assignCells score so a relay cannot recompute its coverage. It is derived
  // (domain-separated) from the out-of-band covert canary cellSecret (CANARY_CELL_SECRET,
  // hex), the same secret material distributed over the Wallet-B channel (D-CFA-10). If the
  // secret is absent/invalid, deriveAssignmentSecret throws INSIDE this try → the loop does
  // NOT start (logged) rather than running an UNSALTED, relay-recomputable assignment.
  //
  // M2 chunk 2 (REQ-CFA-019/020): the validator pool UNIONs live discovered miner_ids (a
  // read-only devInspect of validator_registry::get_active_validators) with the local
  // self-entry, refreshed each round via the existing CANARY_CELL_INTERVAL_MS rotation (no
  // new timer) — crash-safe to self-only on a devInspect failure. assignCells dedups by
  // miner_id, so a relay reaches the >=2-distinct floor once >=2 distinct validators exist.
  try {
    const cellIntervalMs = parseInt(process.env['CANARY_CELL_INTERVAL_MS'] ?? '300000', 10);
    const cellSecretHex = process.env['CANARY_CELL_SECRET'] ?? '';
    const cellSecret = Buffer.from(cellSecretHex, 'hex');
    if (cellSecret.length === 0) {
      // No secret → no salted assignment is possible. Fail SAFE (loop off) rather than run
      // an unsalted, relay-recomputable assignment. This throw is caught below.
      throw new Error(
        'CANARY_CELL_SECRET unset/empty — canary cell loop requires a salt (REQ-CFA-022); loop not started',
      );
    }
    const assignmentSecret = deriveAssignmentSecret(new Uint8Array(cellSecret));

    const cellLog = log.child({ component: 'canary-cell' });
    state.canaryCellLoop = startCanaryCellLoop({
      intervalMs: cellIntervalMs,
      assignmentSecret,
      logger: cellLog,
      deps: {
        // REQ-CFA-037 (M4a chunk 1, D-CFA-30/31): enumerate ONE (relay,room) scope per relay
        // slot per room. A relay homed in two of this daemon's rooms contributes TWO scopes
        // (same relayId, different roomId) so the loop emits one cell per (relay,room) — NO
        // silent re-union (the over-count root). The map key IS the room object id (public).
        getRelayRoomScopes: (): RelayRoomScope[] => {
          const scopes: RelayRoomScope[] = [];
          for (const [roomId, room] of state.activeRooms.entries()) {
            if (room.primaryRelayId) scopes.push({ relayId: room.primaryRelayId, roomId });
            if (room.standbyRelayId) scopes.push({ relayId: room.standbyRelayId, roomId });
          }
          return scopes;
        },
        // REQ-CFA-036 (M4a chunk 1, D-CFA-30): PER-RELAY room-scope the validator pool. M3
        // unioned the co-auditors across ALL of this daemon's rooms, which OVER-COUNTS — a
        // room-B-only co-auditor could be picked into relay-A's cell, inflating the cross-
        // receiver denominator the loss classifier reasons over (W-M3-OVERCOUNT). M4a scopes
        // the pool to ONLY the rooms THIS relay serves (primary OR standby), via the unit-
        // tested pure buildRelayScopedValidatorPool over state.activeRooms[*] (event-sourced
        // from RoomAssigned, ZERO new chain cost) + the self-entry. The registry-wide
        // discovery cache is read ONLY for liveness/identity refresh — it NEVER widens a
        // relay-scoped pool (not even an arg here). Coverage-ACCURACY fix on the SELF-REPORT
        // half (D-CFA-15 / W-M3-OVERCOUNT), NOT a slashing change. assignCells stays UNTOUCHED.
        getValidators: (scope: RelayRoomScope): CanaryValidator[] => {
          const self: CanaryValidator = { minerId: validatorMinerId, sessionWallet: sessionAddress };
          // The single room this scope audits (keyed by the public room object id).
          const room = state.activeRooms.get(scope.roomId);
          const activeRooms: ScopedRoom[] = room
            ? [
                {
                  validatorIds: room.validatorIds ?? [],
                  primaryRelayId: room.primaryRelayId,
                  standbyRelayId: room.standbyRelayId,
                },
              ]
            : [];
          // Kick off a registry refresh for the NEXT round's liveness/identity view (no new
          // timer — rides this round's tick). Crash-safe; the result never widens the pool.
          void refreshDiscoveredValidators(state, cellLog);
          return buildRelayScopedValidatorPool({ activeRooms, self, relayId: scope.relayId });
        },
      },
    });

    // M2 chunk 1 (REQ-CFA-013/014/015): start the off-chain coverage feed over the EXISTING
    // cell-loop snapshot. Loopback-bound + restricted CORS (D-CFA-18); reporterMinerId is
    // the Wallet-A validatorMinerId (NEVER sessionAddress). Same crash-safe try as the loop.
    const coverageProvider: CoverageStateProvider = () => state.canaryCellLoop?.latest() ?? null;
    const coveragePort = parseInt(process.env['VALIDATOR_CANARY_COVERAGE_PORT'] ?? '8102', 10);
    state.coverageServer = startCoverageServer({
      port: coveragePort,
      provider: coverageProvider,
      reporterMinerId: validatorMinerId, // Wallet-A (mainAddress) — NOT sessionAddress
      logger: log.child({ component: 'canary-coverage' }),
    });
  } catch (err) {
    log.error({ err }, 'canary cell loop / coverage feed failed to start (daemon continues)');
  }

  // REQ-CFA-042/043 (M4a chunk 3, D-CFA-33): start the additive crash-safe canary VERIFY loop —
  // the HERMETIC HALF of the verify/publish gate. It wires the M3 chain (verifyForwardedCanary ->
  // classifyDivergences -> buildDivergenceProof -> submit) behind an INJECTABLE capture+submit
  // seam, and is the FIRST real reader of state.relayStunLossBps (closes W-M3-STUN-PATH). ADDITIVE
  // + CRASH-SAFE in its OWN try (independent of the cell loop) so a fault here can NEVER abort
  // the daemon.
  //
  // HONEST SCOPE (DA-3, on record): the PRODUCTION capture seam yields NO live frames yet — the
  // live producer/SFU-forward/consumer media plane (real publisher.publish() + WebRtcTransport
  // capture) is M4b (port-locked this session, INV-B keeps every tap validator-daemon-side, never
  // apps/relay/). So the loop reads STUN + assembles a real (empty) per-receiver Map + persists
  // the per-relay accumulator, but PROMOTES NOTHING until M4b supplies live captures. W-M3-SIM is
  // NARROWED not closed (the >=2-distinct-Wallet-B co-sign protocol W-M4-COSIGN is unbuilt); this
  // loop AMPLIFIES the off-chain gate W-M3-OFFCHAIN (tied to W-E4) — never "resolved".
  try {
    const verifyIntervalMs = parseInt(
      process.env['CANARY_VERIFY_INTERVAL_MS'] ?? '300000',
      10,
    );
    const verifyK = parseInt(process.env['CANARY_VERIFY_K'] ?? '2', 10);
    const verifyDeltaBps = BigInt(process.env['CANARY_VERIFY_DELTA_BPS'] ?? '500');
    const verifyLog = log.child({ component: 'canary-verify' });
    // Stage 4 (multi-cp-quorum): when the master flag CANARY_LIVE_SEAMS_ENABLED is set, build the
    // LIVE { submit, coObserverBoards, capture, getRelayRoomScopes } from env + the Stage-3 artifacts
    // (manifest bundle, daemon keys, host PEM) and swap them into the deps below. Default UNSET ->
    // `liveSeams` is null and the EXACT no-op seams below are used (byte-identical vanilla). The live
    // seams are an INJECTED/CONTROLLED divergence + W-E9 self-slash (HONESTY on record in live-seams.ts).
    const liveSeams = await buildLiveSeams(process.env);
    // B2 (REQ-MLW-B-01/02): when CANARY_LIVE_CAPTURE=pipe, bring up the REAL pipe-tap consumer
    // (a mediasoup worker + standby F1 pipe). The relay primary {ip,port} + PipedProducerDescriptor
    // arrive OOB via a run-config the single-host walkthrough orchestrator writes (CANARY_PIPE_PARAMS_PATH).
    // Default unset / any other value = 'injected' = the EXACT empty no-op below (byte-identical OFF).
    // Crash-safe: any worker-spawn fault here is caught by the existing catch (daemon continues).
    if (selectCaptureMode(process.env) === 'pipe' && !liveSeams?.capture) {
      const paramsPath = process.env['CANARY_PIPE_PARAMS_PATH'];
      if (paramsPath) {
        const params = JSON.parse(readFileSync(paramsPath, 'utf8')) as {
          relay: { ip: string; port: number };
          piped: PipedProducerDescriptor;
          receiverMinerId: string;
          meta: { canaryKid: number; expectedCtrs: number[]; kRoom: number[]; cellSecret: number[] };
        };
        const runtime = await bringUpLiveConsumer({
          pipePort: 0,
          receiverMinerId: params.receiverMinerId,
          meta: {
            canaryKid: params.meta.canaryKid,
            expectedCtrs: params.meta.expectedCtrs,
            kRoom: Uint8Array.from(params.meta.kRoom),
            cellSecret: Uint8Array.from(params.meta.cellSecret),
          },
        });
        await runtime.connectToRelay(params.relay);
        await runtime.consumePiped(params.piped);
        state.liveConsumer = runtime;
        verifyLog.info(
          { standbyPort: runtime.standbyParams.port, receiverMinerId: params.receiverMinerId },
          'B2 live pipe-capture attached (CANARY_LIVE_CAPTURE=pipe)',
        );
      } else {
        verifyLog.warn('CANARY_LIVE_CAPTURE=pipe but CANARY_PIPE_PARAMS_PATH unset — using empty capture');
      }
    }
    // Stage 4.5 (C1 cross-host): HOIST the verify-loop's OWN board so the local `/canary/claims` mTLS
    // server (started below in live mode) can share the SAME instance — a peer's POSTed self-attestation
    // then accrues onto the board THIS daemon assembles from, so the >=2-distinct quorum forms cross-host.
    const canaryLocalBoard = new InMemoryClaimBoard();
    state.canaryVerifyLoop = startCanaryVerifyLoop({
      intervalMs: verifyIntervalMs,
      logger: verifyLog,
      deps: {
        // Reuse chunk-1's per-(relay,room) scopes so the SECONDARY >=k denominator is truthful.
        getRelayRoomScopes: liveSeams?.getRelayRoomScopes ?? (() => {
          const scopes: RelayRoomScope[] = [];
          for (const [roomId, room] of state.activeRooms.entries()) {
            if (room.primaryRelayId) scopes.push({ relayId: room.primaryRelayId, roomId });
            if (room.standbyRelayId) scopes.push({ relayId: room.standbyRelayId, roomId });
          }
          return scopes;
        }),
        // The room-scoped co-auditor pool (chunk 1) — NOT the cross-room union (W-M3-OVERCOUNT).
        getValidators: (scope: RelayRoomScope): CanaryValidator[] => {
          const self: CanaryValidator = { minerId: validatorMinerId, sessionWallet: sessionAddress };
          const room = state.activeRooms.get(scope.roomId);
          const scopedRooms: ScopedRoom[] = room
            ? [
                {
                  validatorIds: room.validatorIds ?? [],
                  primaryRelayId: room.primaryRelayId,
                  standbyRelayId: room.standbyRelayId,
                },
              ]
            : [];
          return buildRelayScopedValidatorPool({ activeRooms: scopedRooms, self, relayId: scope.relayId });
        },
        // FIRST real reader of relayStunLossBps (closes W-M3-STUN-PATH): the per-relay STUN
        // packet-loss prior (basis points), folded into the classifier benign budget (D-CFA-25,
        // a COARSE prior). Defaults to 0n for a relay not yet measured.
        getStunLossBps: (relayId: string): bigint => state.relayStunLossBps.get(relayId) ?? 0n,
        // B2 (REQ-MLW-B-01): capture-seam PRECEDENCE (chooseCapture, additive). An injected
        // liveSeams capture wins (CANARY_LIVE_SEAMS_ENABLED, unchanged); then the live pipe
        // consumer's capture (CANARY_LIVE_CAPTURE=pipe — `state.liveConsumer` is set ABOVE only
        // AFTER connectToRelay + consumePiped, so its `.capture` getter never throws here); then
        // the EXACT empty no-op below. Byte-identical OFF: with the flag unset both
        // `liveSeams?.capture` and `state.liveConsumer?.capture` are undefined, so the verbatim
        // empty no-op is returned (reads STUN, persists the accumulator, promotes nothing).
        capture: chooseCapture(
          liveSeams?.capture,
          state.liveConsumer?.capture,
          async (scope): Promise<CanaryForwardCaptureResult> => ({
            relayId: scope.relayId,
            roomId: scope.roomId,
            canaryKid: state.canaryCellLoop?.latest()?.round ?? 0,
            // No live frames this session (M4b): an EMPTY perReceiver map means the verifier is
            // never invoked, so kRoom/cellSecret/expectedCtrs are inert placeholders (the loop
            // still reads STUN + folds an empty round into the accumulator). No secret on a wire.
            expectedCtrs: [],
            kRoom: new Uint8Array(0),
            cellSecret: new Uint8Array(0),
            perReceiver: new Map(),
          }),
        ),
        // W-M4-COSIGN pull-corroboration claim board (D-CFA-42/43). In-memory fake this session
        // (the live OFF-MEDIA-PATH cp-daemon `/canary/claims` carrier is M4b, D-CFA-47); the
        // production capture yields no promotions, so nothing is published until the live plane
        // lands. selfSessionKeypair = this daemon's Wallet-B session keypair (signs its OWN leg only).
        // C1 (PLAN-m4b-hermetic §3.2): this daemon's OWN local board. The live co-observer boards
        // (OOB-manifest-discovered cross-validator carriers) are M4b — coObserverBoards defaults to
        // [] here (no fan-out, byte-identical to the pre-C1 single-board path) until the WAN gate.
        localBoard: canaryLocalBoard,
        // Stage 4: live OOB-manifest-discovered co-observer boards (C1 fan-out) when the master flag
        // is set; default [] (no fan-out, byte-identical to the pre-Stage-4 single-board path).
        coObserverBoards: liveSeams?.coObserverBoards ?? [],
        selfSessionKeypair: sessionKeypair,
        // Submit seam. Stage 4: live PTB slash (relay self-slashes its OWN bond, W-E9) when the master
        // flag is set; default = the no-op log below (M4b — the production capture yields no
        // promotions, so this is never invoked until the live plane lands; logged if it ever is).
        submit:
          liveSeams?.submit ??
          (async (proof): Promise<void> => {
            verifyLog.info(
              { roomId: proof.roomId, relayMinerId: proof.relayMinerId, frameSeq: proof.frameSeq },
              'canary divergence proof built (submit deferred to M4b live plane)',
            );
          }),
        config: { k: verifyK, deltaBps: verifyDeltaBps, sendRate: verifyK },
      },
    });

    // Stage 4.5 (C1 cross-host): in LIVE mode start THIS host's local `/canary/claims` mTLS server,
    // sharing `canaryLocalBoard` so a PEER can POST its self-attestation onto the board this daemon
    // assembles from (the >=2-distinct quorum forms cross-host). Gated on the master flag (liveSeams
    // != null) AND the TLS fork; vanilla mode (flag off) starts NO server -> byte-identical.
    if (liveSeams && isCanaryClaimsTlsEnabled(process.env)) {
      const tls = await loadCanaryTls(process.env);
      state.canaryClaimsServer = await startCanaryClaimsServer({
        board: canaryLocalBoard,
        logger: verifyLog,
        env: process.env,
        tls,
      });
      verifyLog.info('canary /canary/claims mTLS server started (shared localBoard, C1 cross-host accrual)');
    }
  } catch (err) {
    log.error({ err }, 'canary verify loop failed to start (daemon continues)');
  }

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
        // REQ-CFA-023 (M3 chunk 1, D-CFA-24): persist the in-event co-auditor set (already
        // parsed above for the self-membership test, previously discarded) so the canary
        // validator pool can per-relay room-scope (buildRelayScopedValidatorPool, M4a chunk 1
        // D-CFA-30). ZERO new chain cost.
        // A re-assignment REPLACES the set (latest assignment is authoritative);
        // promote_relay/swap_relay never reach this arm, so the set is stable under a relay
        // swap (W-M3-STALE — mirrors validator-pool.ts::applyRoomAssigned, the unit-tested seam).
        room.validatorIds = [...validatorIds];

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
 * M2 chunk 2 (REQ-CFA-019/020): refresh the cached live-discovered active-validator
 * miner_ids via a read-only devInspect of validator_registry::get_active_validators.
 *
 * Fire-and-forget per canary round (called from the cell loop's getValidators) — no new
 * timer. CRASH-SAFE: a devInspect failure is swallowed by discoverActiveValidatorMinerIds
 * (returns []), and we only OVERWRITE the cache with a non-empty result, so a transient RPC
 * flake leaves the last good set in place; an empty result (genuinely no peers) is reflected
 * as [] so the union degrades to self-only. The self-entry is always re-added by the union,
 * so the daemon never drops below self-coverage. Re-entrancy is bounded by a single in-flight
 * guard so a slow RPC cannot stack refreshes across rounds.
 */
let discoveryRefreshInFlight = false;
async function refreshDiscoveredValidators(state: DaemonState, log: Logger): Promise<void> {
  if (discoveryRefreshInFlight) return;
  discoveryRefreshInFlight = true;
  try {
    const ids = await discoverActiveValidatorMinerIds(state.client, state.config, log);
    if (ids.length > 0) {
      state.discoveredValidatorMinerIds = ids;
    } else if (state.discoveredValidatorMinerIds === undefined) {
      // First-ever refresh returned empty (no peers yet) — record [] so the union is
      // self-only rather than staying `undefined` forever.
      state.discoveredValidatorMinerIds = [];
    }
  } catch (err) {
    // Defense-in-depth: the discovery reader is already crash-safe, but never let a refresh
    // reject escape into the cell loop.
    log.warn({ err }, 'canary validator discovery refresh failed (keeping last good set)');
  } finally {
    discoveryRefreshInFlight = false;
  }
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
    // REQ-CFA-029 (M3 chunk 2, D-CFA-26): persist this relay's STUN packet-loss (basis
    // points) as the per-relay SEAM the loss classifier WILL read once the verify loop is
    // wired (Task 5.2+, W-M3-SIM — written now, read later; no live reader today). The same
    // value is folded into the session-proof BCS below (~packetLossRate) then otherwise
    // discarded; here it is keyed by relayMinerId so the classifier can fold it into its
    // BUDGET. Coarse prior only (D-CFA-25): STUN-UDP != canary-RTP, single global probe host
    // (per-relay attribution = G3).
    state.relayStunLossBps.set(relayMinerId, measurement.packetLossRate);
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
          await (healthz?.close() ?? Promise.resolve());
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
