/**
 * Validator Daemon -- bootstrap.
 *
 * Extracted from the former `index.ts` monolith: `startHealthMonitor` (the F61
 * self-degradation monitor wiring) and `startDaemon` (the full daemon startup
 * sequence -- wallets/registration, canary cell-loop + coverage server, canary
 * verify-loop + live-capture + claims server, measurement-loop kickoff, event
 * pollers, and the liveness sweep). `startDaemon` calls out to
 * `./event-pollers.js` and `./measurement-cycle.js` for those sub-pieces.
 */

import { readFileSync } from 'node:fs';
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createGraphQLClient,
  loadNetworkConfig,
  loadKeypair,
  generateSessionKeypair,
  createLogger,
  readCapMinerId,
} from '@dvconf/shared';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { HealthMonitor, makeChainReporter, readCooldownMs, type ThresholdEnv } from '@dvconf/health-monitor';
import { buildHealthSignals, type ValidatorHealthDeps } from '../health-signals.js';
import { ensureRegistered } from '../auto-register.js';
import { startHeartbeat } from '../heartbeat.js';
import {
  startCanaryCellLoop,
  deriveAssignmentSecret,
  type CanaryValidator,
  type RelayRoomScope,
} from '../canary/cell.js';
import { discoverActiveValidatorMinerIds } from '../canary/validator-discovery.js';
import { buildRelayScopedValidatorPool, type ScopedRoom } from '../canary/validator-pool.js';
import {
  startCoverageServer,
  type CoverageStateProvider,
  type LoadStateProvider,
} from '../canary/coverage-server.js';
import {
  startCanaryVerifyLoop,
  type CanaryForwardCaptureResult,
} from '../canary/verify-loop.js';
import { InMemoryClaimBoard } from '../canary/claim-board.js';
import {
  buildLiveSeams,
  loadCanaryTls,
  selectCaptureMode,
  resolveRelayPipeFromManifest,
} from '../canary/live-seams.js';
import { bringUpLiveConsumer } from '../canary/live-consumer-runtime.js';
import { coHomeCapture } from '../canary/cohome-capture.js';
import { chooseCapture, type CanaryPipeParams } from '../capture-precedence.js';
import {
  CANARY_CAPTURE_LIVE_TOKEN,
  CANARY_CAPTURE_EMPTY_TOKEN,
} from '../canary/capture-empty-error.js';
import {
  startCanaryClaimsServer,
  isCanaryClaimsTlsEnabled,
} from '../canary/claims-server.js';
import { runMeasurementCycle } from './measurement-cycle.js';
import { startEventPollers } from './event-pollers.js';
import type { DaemonState, ActiveRoom } from './state.js';

const logger = createLogger('validator-daemon');

/**
 * B-WAN HARD-FAIL liveness (REQ-MLW-B-12): how long to let the relay forward before the
 * post-bring-up empty-capture probe asserts >=1 receiver / >=1 frame (ms; env-overridable).
 */
const LIVENESS_PROBE_MS = parseInt(process.env['CANARY_LIVENESS_PROBE_MS'] ?? '3000', 10);

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
  // Event queries only (EventPoller below) -- see createGraphQLClient's docstring.
  const graphqlClient = createGraphQLClient(process.env['SUI_NETWORK'] ?? 'localnet');
  const mainKeypair = overrides?.mainKeypair ?? loadKeypair('SUI_PRIVATE_KEY');

  const mainAddress = mainKeypair.getPublicKey().toSuiAddress();

  // Auto-register if needed
  const { validatorCapId } = await ensureRegistered(client, mainKeypair, config, log, graphqlClient);

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
    livenessSweep: null,
    escrowMap,
    activeRooms,
    heartbeatStop: null,
    rttSamplesMs: [],
    consecutiveUnreachable: 0,
    relayStunLossBps: new Map(),
    relayMetricsUrls: new Map(),
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
          const scopedRooms: ScopedRoom[] = room
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
          return buildRelayScopedValidatorPool({ activeRooms: scopedRooms, self, relayId: scope.relayId });
        },
      },
    });

    // M2 chunk 1 (REQ-CFA-013/014/015): start the off-chain coverage feed over the EXISTING
    // cell-loop snapshot. Loopback-bound + restricted CORS (D-CFA-18); reporterMinerId is
    // the Wallet-A validatorMinerId (NEVER sessionAddress). Same crash-safe try as the loop.
    const coverageProvider: CoverageStateProvider = () => state.canaryCellLoop?.latest() ?? null;
    const coveragePort = parseInt(process.env['VALIDATOR_CANARY_COVERAGE_PORT'] ?? '8102', 10);
    // REQ-RMS-022 (static-mesh-hardening D1): attested-load feed provider over the verify-loop
    // accumulator. The coverage server starts BEFORE the verify loop (below), so this closure
    // reads `state.canaryVerifyLoop` lazily via `?.` — it is only INVOKED per /canary/load
    // request, by which point the handle is set; the empty-accumulator fallback keeps it total.
    // heartbeatFresh: the per-relay on-chain freshness source is canary-M4b scope; the empty map
    // makes buildLoadPayload default rows to MAX_SAFE_INTEGER (conservative).
    const loadProvider: LoadStateProvider = () => ({
      acc: state.canaryVerifyLoop?.getAccumulator() ?? { byRelay: new Map() },
      heartbeatFresh: new Map<string, number>(),
    });
    state.coverageServer = startCoverageServer({
      port: coveragePort,
      provider: coverageProvider,
      reporterMinerId: validatorMinerId, // Wallet-A (mainAddress) — NOT sessionAddress
      logger: log.child({ component: 'canary-coverage' }),
      loadProvider,
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
        // Narrow guard around ONLY the read+parse: an unreadable/malformed run-config is an
        // operability issue (skip bring-up with a TARGETED warn), NOT the misleading generic
        // "verify loop failed to start" the outer catch would otherwise report. Byte-identical
        // OFF is unchanged — this whole block is gated by the flag above.
        let params: CanaryPipeParams | undefined;
        try {
          params = JSON.parse(readFileSync(paramsPath, 'utf8')) as CanaryPipeParams;
        } catch (e) {
          // B-WAN HARD-FAIL (REQ-MLW-B-12): a REQUESTED pipe capture with an unreadable/malformed
          // run-config must NOT degrade to a silent empty no-op (that masquerades as a passing
          // audit). The bring-up sits inside the crash-safe try/catch, so a `throw` would be
          // SWALLOWED -> use fatal + process.exit(1) so the process dies BEFORE the catch.
          verifyLog.fatal(
            { token: CANARY_CAPTURE_EMPTY_TOKEN, paramsPath, err: e },
            'CANARY_PIPE_PARAMS_PATH unreadable/malformed — refusing a silent no-op audit',
          );
          process.exit(1);
        }
        if (params) {
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
          // B3 (REQ-MLW-B-13): the AUTHENTICATED relay pipe endpoint from the ed25519-signed OOB
          // manifest takes precedence over the UNSIGNED CANARY_PIPE_PARAMS_PATH `params.relay`. The
          // resolver returns null with no CANARY_RELAY_OPERATOR_PUBKEY env / no matching-verified
          // manifest / no relayPipe -> we fall back to `params.relay` (byte-identical to Task 2). The
          // piped descriptor + meta still come from the file; the manifest carries ONLY the relay
          // {ip,port} (per-pipe SRTP is exchanged dynamically over pipe-connect, INV-C).
          const authedRelay = await resolveRelayPipeFromManifest(process.env);
          await runtime.connectToRelay(authedRelay ?? params.relay);
          if (authedRelay) {
            verifyLog.info(
              { relayIp: authedRelay.ip, relayPort: authedRelay.port },
              'B3 using AUTHENTICATED relay pipe endpoint from signed OOB manifest (precedence over unsigned file)',
            );
          }
          await runtime.consumePiped(params.piped);
          state.liveConsumer = runtime;
          verifyLog.info(
            { standbyPort: runtime.standbyParams.port, receiverMinerId: params.receiverMinerId },
            'B2 live pipe-capture attached (CANARY_LIVE_CAPTURE=pipe)',
          );
          // B-WAN HARD-FAIL liveness (REQ-MLW-B-12): give the relay a moment to forward, then assert
          // >=1 receiver with >=1 captured frame. A silent no-op must not pass as an audit. fatal +
          // process.exit(1) (NOT throw) so the crash-safe catch can't swallow the failure.
          await new Promise((res) => setTimeout(res, LIVENESS_PROBE_MS));
          const probe = await runtime.capture({ relayId: params.relay.ip, roomId: params.receiverMinerId });
          const frames = [...probe.perReceiver.values()].reduce((n, b) => n + b.length, 0);
          if (probe.perReceiver.size === 0 || frames === 0) {
            verifyLog.fatal(
              { token: CANARY_CAPTURE_EMPTY_TOKEN, receivers: probe.perReceiver.size, frames },
              'CANARY_LIVE_CAPTURE=pipe but capture is empty (0 receivers / 0 frames) — refusing a silent no-op audit',
            );
            runtime.shutdown();
            process.exit(1);
          }
          verifyLog.info(
            { token: CANARY_CAPTURE_LIVE_TOKEN, receivers: probe.perReceiver.size, frames },
            'B2 live capture verified (>=1 receiver, >=1 frame)',
          );
        }
      } else {
        // B-WAN HARD-FAIL (REQ-MLW-B-12): CANARY_LIVE_CAPTURE=pipe was REQUESTED but no run-config
        // path was supplied — refuse the silent empty no-op. fatal + process.exit(1) (NOT throw) so
        // the crash-safe catch can't swallow it.
        verifyLog.fatal(
          { token: CANARY_CAPTURE_EMPTY_TOKEN },
          'CANARY_LIVE_CAPTURE=pipe but CANARY_PIPE_PARAMS_PATH unset — refusing a silent no-op audit',
        );
        process.exit(1);
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
          // B-18 (W-M3-SIM): when CANARY_COHOME_RECEIVER_2 is set, wrap the live capture so a single
          // real drop-stream is presented under TWO distinct receiver ids => the classifier's SECONDARY
          // >=k cross-receiver signal can fire. Default-OFF (unset) => the bare live capture, byte-identical.
          state.liveConsumer
            ? (process.env['CANARY_COHOME_RECEIVER_2']
                ? coHomeCapture(state.liveConsumer.capture, process.env['CANARY_COHOME_RECEIVER_2'])
                : state.liveConsumer.capture)
            : undefined,
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

  // Start the validator_registry / EscrowCreated / RoomCreated+RoomClosed+RoomAssigned
  // event pollers, plus the liveness sweep.
  await startEventPollers(state, graphqlClient, validatorMinerId, pollIntervalMs, log);

  return state;
}
