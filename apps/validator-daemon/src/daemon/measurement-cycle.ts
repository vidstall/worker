/**
 * Validator Daemon -- measurement cycle.
 *
 * Extracted from the former `index.ts` monolith: `handleRoomClosed` (reward
 * distribution on RoomClosed), and the per-cycle `runMeasurementCycle` /
 * `measureRoom` / `measureRelay` chain (probe -> proof -> sign -> submit).
 */

import { normalizeSuiAddress } from '@mysten/sui/utils';
import { genTraceId, traceChild, MIN_PROOFS_FOR_DISTRIBUTION } from '@dvconf/shared';
import type { Logger } from '@dvconf/shared';
import { collectMeasurements } from '../measurements.js';
import { createRelayProbe, type RelayProbeEndpoint, type RelayMetricsResult } from '../probe.js';
import { readRelayMetricsUrls } from '../relay-metrics-resolver.js';
import {
  buildSessionProof,
  dualKeySign,
  serializeProofBcs,
  logProofSummary,
  submitSessionProof,
} from '../session-proof.js';
import { waitForProofs, triggerDistribution } from '../reward-trigger.js';
import { timedMeasureRoom } from '../latency-probe.js';
import type { DaemonState } from './state.js';

/** F61 rolling-RTT window size (DOH-014): average of the latest N reachable RTTs. */
const RTT_WINDOW = 10;

/**
 * Handle a RoomClosed event: wait for proofs then trigger distribution.
 */
export async function handleRoomClosed(
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
export async function runMeasurementCycle(
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

  // G3 (partial): refresh per-relay metrics URLs from chain so measureRelay probes the relay
  // it ATTESTS (the cp's dynamic primary), not one static RELAY_METRICS_URL. Best-effort: a read
  // failure keeps the prior map (and an empty map falls back to RELAY_METRICS_URL downstream).
  try {
    const urls = await readRelayMetricsUrls(
      state.client,
      state.config.packageId,
      state.config.relayRegistryId,
      state.sessionAddress,
    );
    if (urls.size > 0) state.relayMetricsUrls = urls;
  } catch {
    /* keep prior map */
  }

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
function resolveProbeEndpoint(isStandby: boolean, metricsOverride?: string): RelayProbeEndpoint {
  const stunPortRaw = process.env['RELAY_STUN_PORT'];
  // G3 (partial): prefer the per-relay metrics URL resolved from chain (the relay this proof
  // ATTESTS); fall back to the static single-host RELAY_METRICS_URL when unresolved.
  const metricsBaseUrl =
    metricsOverride && metricsOverride.length > 0
      ? metricsOverride
      : process.env['RELAY_METRICS_URL'] ?? '';
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

  // Client-reported relay-down hint (accelerant only, see probe.ts's
  // clientReportedDeadRelayHint): observed on the STANDBY's leg, since a
  // client can only report through a relay it can still reach. Captured via
  // onMetrics so it costs no extra HTTP fetch.
  let standbyReportedPrimaryDown = false;

  for (const { relayMinerId, isStandby } of relays) {
    const onMetrics = isStandby
      ? (metrics: RelayMetricsResult | null): void => {
          if (metrics?.clientReportedDeadRelayHint === true) standbyReportedPrimaryDown = true;
        }
      : undefined;
    await measureRelay(state, roomId, relayMinerId, isStandby, validatorMinerId, log, traceId, onMetrics);
  }

  if (standbyReportedPrimaryDown && room?.primaryRelayId) {
    log.warn(
      { roomId, primaryRelayId: room.primaryRelayId },
      'client-reported relay-down hint: immediate extra primary re-probe (advisory-only, not liveness-vote-triggering)',
    );
    await measureRelay(state, roomId, room.primaryRelayId, false, validatorMinerId, log, traceId);
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
  onMetrics?: (metrics: RelayMetricsResult | null) => void,
): Promise<void> {
  // RO-019b: derive the measurement from a REAL probe (STUN RTT + relay
  // metrics HTTP) instead of the removed random simulation. Per-relay endpoint
  // is resolved via env (single RELAY_METRICS_URL today; multi-host = G3).
  // RO-020: the standby additionally carries the /api/probe liveness gate.
  // G3 (partial): probe THIS relay's own metrics endpoint (resolved from chain), not one static
  // URL — so the cp's dynamically-chosen primary relay is reached (404 -> bytes=0 otherwise).
  const perRelayMetrics = state.relayMetricsUrls.get(normalizeSuiAddress(relayMinerId));
  const probe = createRelayProbe(
    roomId,
    () => resolveProbeEndpoint(isStandby, perRelayMetrics),
    {
      ...(onMetrics ? { onMetrics } : {}),
      // Monitoring-redesign gap #6: stash the raw STUN sample for index.ts's
      // periodic gauge refresh to read (same seam as relayStunLossBps below).
      onStunSample: (id, stun) => {
        state.relayPathSamples.set(id, {
          rttMs: stun.avgLatencyMs,
          jitterMs: stun.jitterMs,
          lossBps: stun.packetLossBps,
        });
      },
    },
    traceId,
  );
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
    // points) as the per-relay SEAM the loss classifier IS read by via the wired canary verify
    // loop (getStunLossBps, folded into the classifier budget; W-M3-SIM). The same value is
    // folded into the session-proof BCS below (~packetLossRate) then otherwise discarded; here
    // it is keyed by relayMinerId so the classifier can fold it into its BUDGET. Coarse prior
    // only (D-CFA-25): STUN-UDP != canary-RTP, single global probe host (per-relay attribution = G3).
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
