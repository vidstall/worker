/**
 * cp-daemon event-handler case arm — EscrowCreated (god-file split out of the
 * former monolithic `event-handler.ts`). This is the single largest arm: relay
 * scoring/ranking, MCU-aware weighting, capacity-aware placement, signaling-node
 * pairing, and pairing-proposal submission.
 */
import type { SuiEvent } from '@mysten/sui/client';
import type { EscrowCreated } from '@dvconf/shared';
import {
  computeNodeScore,
  computePairingScore,
  PVR_HEARTBEAT_STALE,
} from '../scoring.js';
import {
  estimateRoomLoad,
  selectPlacementRelay,
  selectActiveRelays,
  poolHealthGate,
  excludeFlaggedRelays, // selectTopRelays is NOT imported here — unused in event-handler (BLOCKER-2); it lives only in the 5a.2 unit test
  MIN_RELAY,
  type RoomClass,
  type RelayCapacity,
} from '../admission-capacity.js';
import { timedCanonicalSort } from '../latency-probe.js';
import { submitProposal, pickSignalingNode, votedRooms } from '../room-assignment.js';
import { probeCandidates } from '../relay-liveness-probe.js';
import type { EventHandlerCtx } from '../event-handler.js';

export function handleEscrowCreated(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const { relayState, signalingState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState, attestedLoad, byzantineFlag } = ctx;

  const e = data as unknown as EscrowCreated;
  const roomData = pendingRooms.get(e.room_id);
  if (!roomData) {
    // Room event hasn't arrived yet — stash escrow for when it does
    if (pendingEscrows) {
      pendingEscrows.set(e.room_id, e);
      logger.info({ roomId: e.room_id, escrowId: e.escrow_id }, 'EscrowCreated arrived before RoomCreated — stashed for later');
    } else {
      logger.warn({ roomId: e.room_id }, 'EscrowCreated for unknown room, ignoring');
    }
    return;
  }
  pendingRooms.delete(e.room_id);
  logger.info({ roomId: e.room_id, escrowId: e.escrow_id, amount: e.amount }, 'Escrow created — assigning infrastructure');

  // PAIR-03: Skip rooms already voted on
  if (votedRooms.has(e.room_id)) {
    logger.debug({ roomId: e.room_id }, 'Already submitted proposal for this room, skipping');
    return;
  }

  // Score all known relays for this room using PVR scoring
  const allRelays = Array.from(relayState.values());
  // REQ-RMS-015 — Byzantine exclusion BEFORE ranking: drop relays the canary
  // lane flagged as sustained divergers so i*=argmin never selects them. The
  // consensus PVR score (computeNodeScore == pairing_score.move) is untouched;
  // this only narrows the candidate set. `byzantineFlag` is undefined in the
  // single-relay/test path => no exclusion (M1 behavior preserved).
  const relays = byzantineFlag
    ? excludeFlaggedRelays(allRelays, byzantineFlag)
    : allRelays;
  if (relays.length === 0) {
    // Message text preserved (M1 test asserts it); `excludedByzantine` (0 in the
    // genuine-empty case, >0 when every relay was canary-flagged) disambiguates.
    logger.info(
      { roomId: e.room_id, excludedByzantine: allRelays.length - relays.length },
      'No relays available — deferring assignment',
    );
    pendingRooms.set(e.room_id, roomData);
    pendingEscrows?.set(e.room_id, e);
    return;
  }

  // MCU-06: Determine room mode from RoomCreated event
  const roomMode: 'sfu' | 'mcu' = roomData.relay_mode === 1 ? 'mcu' : 'sfu';

  // Use empty string as target region (room does not specify region)
  const targetRegion = '';

  // Canonical sort relays by PVR score (timed when BENCH_LATENCY=1)
  const rankedRelays = timedCanonicalSort(relays, targetRegion, weights);
  const topRelay = rankedRelays[0];
  if (!topRelay) {
    logger.warn({ roomId: e.room_id }, 'Scoring returned no results');
    pendingRooms.set(e.room_id, roomData);
    pendingEscrows?.set(e.room_id, e);
    return;
  }

  // Pick a signaling node
  const signalingMinerId = pickSignalingNode(signalingState);
  if (!signalingMinerId) {
    logger.warn({ roomId: e.room_id }, 'No signaling nodes available — deferring assignment');
    pendingRooms.set(e.room_id, roomData);
    pendingEscrows?.set(e.room_id, e);
    return;
  }

  // PAIR-02: Score and select validators via PVR canonicalSort (timed when BENCH_LATENCY=1)
  const validators = validatorState ? Array.from(validatorState.values()) : [];
  const rankedValidators = timedCanonicalSort(validators, targetRegion, weights);

  // The on-chain ballot floor is required_validators(expected) =
  // min(max(DEFAULT_MIN_VALIDATORS_PER_ROOM, floor(expected/PVR_VALIDATOR_RATIO)), PVR_MAX_VALIDATORS_PER_ROOM)
  // (pairing_score.move) -- i.e. it's ALWAYS clamped into [4, 5], never higher, regardless of room
  // size. `RoomCreated` carries no `expected_participants` field, so this daemon has no cheap way to
  // compute the real per-room value off-chain -- but since the on-chain requirement can never exceed
  // the hard cap (5), submitting the cap unconditionally is always >= whatever the room actually
  // needs. A prior floor of 4 undercounted for any room with expected_participants > 12 (25 in this
  // scenario needs 5), so submit_pairing_proposal deterministically aborted E_INVALID_BALLOT (509)
  // for every CP, on every room of that size, forever (confirmed live: zero of 18 CPs ever got a
  // proposal to land). Capped at availability -- a pool with < PVR_MAX_VALIDATORS_PER_ROOM active
  // validators submits fewer and may still abort if the room's real requirement also exceeds
  // availability, but that's a genuine capacity shortfall, not this bug.
  const PVR_MAX_VALIDATORS_PER_ROOM = 5; // mirrors contracts constants.move PVR_MAX_VALIDATORS_PER_ROOM
  const topValidatorIds = rankedValidators
    .slice(0, Math.max(1, Math.min(rankedValidators.length, PVR_MAX_VALIDATORS_PER_ROOM)))
    .map(v => v.minerId);

  // Room health-monitor validators (see room_health_alerts.move): exactly 3, a designated
  // subset of this proposal's own validator_ids ballot -- the same rankedValidators list
  // already computed above, reused rather than re-scored. submit_pairing_proposal aborts
  // E_INVALID_BALLOT if this isn't length 3 and a subset of topValidatorIds, so this room
  // needs at least 3 candidate validators to be assignable at all.
  const healthValidatorMinerIds = rankedValidators.slice(0, 3).map(v => v.minerId);
  if (healthValidatorMinerIds.length < 3) {
    logger.warn(
      { roomId: e.room_id, validatorCount: healthValidatorMinerIds.length },
      'Fewer than 3 validators available — deferring assignment (cannot satisfy room_health_validators floor)',
    );
    pendingRooms.set(e.room_id, roomData);
    pendingEscrows?.set(e.room_id, e);
    return;
  }

  // ── REQ-RMS-002/005/016/018/019 — capacity-aware placement ──────────────
  // Applied AFTER canonicalSort (consensus order preserved) and BEFORE the ballot
  // slice. Narrows the consensus-sorted set by CANARY-ATTESTED capacity; the PVR
  // consensus score (computeNodeScore/canonicalSort) is NOT touched.

  // REQ-RMS-016 — seed L_r from the creator room-class hint on RoomCreated (off-chain consumed).
  const classHint: RoomClass =
    roomData.room_class_hint === 2 ? 'large' : roomData.room_class_hint === 1 ? 'webinar' : 'small';
  // NOTE: the `RoomCreated` shared type has NO `expected_participants` field (only room_id,
  // creator, relay_mode, room_class_hint). The room-class PRESET drives the video term of L_r;
  // the audio_term seed is a documented conservative 0 floor (Task 8.4 NOTE). A future task that
  // threads expected_participants onto BOTH the Move event and the shared type would replace this.
  const expectedParticipants = 0;
  const roomLoad = estimateRoomLoad(classHint, expectedParticipants, roomMode);

  // C_worker is the calibrated per-room ceiling (REQ-RMS-001) — read from env (no hardcode), default to the bench floor.
  const cWorker = parseInt(process.env['RMS_C_WORKER_PATHS'] ?? '300', 10);

  // REQ-RMS-005/019 — build capacity rows from the CANARY-ATTESTED l_i, NOT candidate.load self-report.
  // When NO canary feed map is wired (attestedLoad === undefined), the canary layer is inactive: fall
  // back to relay self-report for load AND treat the pool as health-eligible (legacy pre-canary path).
  const feedActive = attestedLoad !== undefined;
  const capacities: RelayCapacity[] = rankedRelays.map((r) => {
    const attested = attestedLoad?.get(r.minerId);
    const node = relayState.get(r.minerId)!;
    // Heartbeat freshness fallback (no feed): clamp self-reported age to the stale ceiling.
    const selfFreshEpochs = Math.min(Number(node.heartbeatAge), Number(PVR_HEARTBEAT_STALE));
    return {
      minerId: r.minerId,
      attestedLoadPaths: attested?.attestedLoadPaths ?? Number(node.load), // fall back to self-report ONLY if no canary feed
      cWorker,
      rtt: node.rtt,
      heartbeatFreshEpochs: attested ? attested.heartbeatFreshEpochs : selfFreshEpochs,
      // present in the feed => audited/healthy this round. With NO feed wired, the canary gate is
      // inactive and the pool is treated as self-report-healthy (preserves pre-canary behavior).
      canaryHealthy: feedActive ? attested !== undefined : true,
    };
  });

  // REQ-RMS-022 (static-mesh-hardening D1) — tri-state placement-capacity basis, asserted by
  // the live run: legacy-self-report = no feed wired (flag OFF) | attested = wired + at least
  // one candidate has a row | defer = wired but NO candidate has an attested row (strict
  // no-attestation -> the pool-health gate below then defers the admission). Emitted BEFORE the
  // gate so the basis is recorded even on the defer path. Structured-logging standard shape.
  const basis = !feedActive
    ? 'legacy-self-report'
    : capacities.some((c) => c.canaryHealthy)
      ? 'attested'
      : 'defer';
  logger.info(
    { module: 'event-handler', action: 'placement_basis', context: { basis, feedRows: attestedLoad?.size ?? 0, candidates: capacities.length } },
    'REQ-RMS-022: placement capacity basis',
  );

  // REQ-RMS-018/021 — pool-health gate + K_r placement. STRICT env-gate: with RMS_KR_MIN unset (or <=1),
  // kR = 1 EXACTLY, so the M1 single-relay path + MIN_RELAY-padded ballot below is byte-identical to M1
  // (including M1's defer when roomLoad > cWorker). The LOCAL >=3-active demo sets RMS_KR_MIN=3 to force a
  // room to span >=3 ACTIVE relays; when forced, kR also rises with capacity demand (ceil(L_r/C_worker)).
  // Capacity-driven auto-spill WITHOUT the floor = deferred REQ-RMS-023 (runtime growth), out of scope here.
  // The recorded vector floor stays >= MIN_RELAY (2) per submit_pairing_proposal's on-chain assert.
  const krMin = parseInt(process.env['RMS_KR_MIN'] ?? '1', 10);
  const kR = krMin > 1 ? Math.max(krMin, Math.ceil(roomLoad / cWorker)) : 1;
  if (!poolHealthGate(capacities, kR)) {
    logger.warn({ roomId: e.room_id, healthyNeeded: kR }, 'Pool health below K_r — deferring admission (graceful degrade, no migration)');
    pendingRooms.set(e.room_id, roomData);
    pendingEscrows?.set(e.room_id, e);
    return;
  }

  // The RECORDED ballot must be >= MIN_RELAY (on-chain floor), even though only `chosen` serves the
  // room. Order: chosen first, then capacity-eligible peers, then back-fill from the rest of the
  // consensus-sorted relays to reach MIN_RELAY (a ballot, not a live assignment). rankedRelays is
  // already consensus-sorted (canonicalSort), chosen-first below. Factored out (not just inlined)
  // so the liveness-probe retry path below can rebuild a ballot around a REPLACEMENT `chosen`
  // without duplicating this logic -- padding entries never actually serve traffic, so they don't
  // need to be re-derived from a liveness-filtered pool, only `chosen` (index 0) does.
  const buildBallotForChosen = (chosen: RelayCapacity): string[] | null => {
    const chosenFirst: string[] = [chosen.minerId];
    const eligiblePeers = capacities
      .filter((c) => c.minerId !== chosen.minerId && c.attestedLoadPaths + roomLoad <= c.cWorker)
      .map((c) => c.minerId);
    const restByConsensus = rankedRelays
      .map((r) => r.minerId)
      .filter((id) => id !== chosen.minerId && !eligiblePeers.includes(id)); // not chosen, not already an eligible peer
    const ballot = [...chosenFirst, ...eligiblePeers, ...restByConsensus]; // de-dup guaranteed by the filters
    if (ballot.length < MIN_RELAY) return null;
    return ballot.slice(0, MIN_RELAY); // exactly MIN_RELAY for K_r=1 M1; chosen is index 0
  };

  let topRelayIds: string[];
  if (kR <= 1) {
    // ── M1 PATH (preserved verbatim): single active relay + ballot padded to MIN_RELAY. ──
    // REQ-RMS-002 — i* = argmin (l_i + L_r)/C_worker s.t. <= C_worker, RTT tie-break.
    const chosen = selectPlacementRelay(capacities, roomLoad);
    if (!chosen) {
      logger.warn({ roomId: e.room_id, roomLoad, cWorker }, 'No relay can absorb L_r under capacity ceiling — deferring');
      pendingRooms.set(e.room_id, roomData);
      pendingEscrows?.set(e.room_id, e);
      return;
    }
    const ballot = buildBallotForChosen(chosen);
    if (!ballot) {
      // The ENTIRE pool has < MIN_RELAY relays — cannot record a valid ballot; defer (graceful).
      logger.warn({ roomId: e.room_id, poolSize: capacities.length, minRelay: MIN_RELAY }, 'Fewer than MIN_RELAY relays exist — deferring (cannot satisfy on-chain ballot floor)');
      pendingRooms.set(e.room_id, roomData);
      pendingEscrows?.set(e.room_id, e);
      return;
    }
    topRelayIds = ballot;
  } else {
    // ── REQ-RMS-021: kR>1 ACTIVE relays (>=3 for the LOCAL demo). All emitted ids ACTIVELY serve. ──
    const activeRelays = selectActiveRelays(capacities, roomLoad, kR);
    if (activeRelays.length < kR) {
      logger.warn({ roomId: e.room_id, need: kR, got: activeRelays.length }, 'Fewer than K_r relays can absorb a share — deferring');
      pendingRooms.set(e.room_id, roomData);
      pendingEscrows?.set(e.room_id, e);
      return;
    }
    topRelayIds = activeRelays.map((r) => r.minerId); // length kR (>= MIN_RELAY since kR>=3 here)
  }

  // Compute individual node scores for submittedScore
  const nodeScores: bigint[] = [];
  for (const id of topRelayIds) {
    const node = relayState.get(id);
    if (node) nodeScores.push(computeNodeScore(node, targetRegion, weights));
  }
  for (const id of topValidatorIds) {
    const node = validatorState?.get(id);
    if (node) nodeScores.push(computeNodeScore(node, targetRegion, weights));
  }
  const submittedScore = computePairingScore(nodeScores);

  logger.info(
    {
      roomId: e.room_id,
      roomMode,
      relayCount: relays.length,
      topRelays: topRelayIds,
      topRelayScore: computeNodeScore(topRelay, targetRegion, weights).toString(),
      validatorCount: validators.length,
      topValidators: topValidatorIds,
      signalingMinerId,
      submittedScore: submittedScore.toString(),
    },
    'Room proposal: submitting TX',
  );

  // Submit proposal TX (fire-and-forget with retry) — PAIR-01
  if (txContext) {
    const doSubmit = (relayIds: string[]) => {
      submitProposal(
        txContext.client,
        txContext.signer,
        txContext.config,
        txContext.cpCapId,
        e.room_id,
        relayIds,
        topValidatorIds,
        signalingMinerId,
        submittedScore,
        logger,
        healthValidatorMinerIds,
      ).then((success) => {
        if (success) {
          logger.info(
            { roomId: e.room_id, relays: relayIds, validators: topValidatorIds, signalingId: signalingMinerId },
            'Pairing proposal submitted successfully',
          );
          return;
        }
        // executeWithRetry exhausted its own retries (a transient chain-state
        // race, not a permanent failure -- see room_manager E_INVALID_BALLOT
        // history). Re-queue so the periodic retryPendingAssignments sweep
        // (see createEventHandler) tries again later instead of dropping
        // this room silently.
        logger.warn({ roomId: e.room_id }, 'Pairing proposal failed after retries — re-queued for periodic retry');
        pendingRooms.set(e.room_id, roomData);
        pendingEscrows?.set(e.room_id, e);
      }).catch((err) => {
        logger.error({ err, roomId: e.room_id }, 'Pairing proposal TX failed — re-queued for periodic retry');
        pendingRooms.set(e.room_id, roomData);
        pendingEscrows?.set(e.room_id, e);
      });
    };

    // Opt-in liveness gate (default OFF -- byte-identical to the path above
    // when unset, same "STRICT env-gate" convention as RMS_KR_MIN above).
    // Only `activeServingIds` (index 0 for kR<=1, all of topRelayIds for
    // kR>1) actually serve traffic -- ballot padding beyond that never
    // reaches a bot, so it's never probed.
    if (process.env['RMS_RELAY_HEALTH_PROBE'] === '1') {
      const activeServingIds = kR <= 1 ? [topRelayIds[0]!] : topRelayIds;
      void (async () => {
        const alive = await probeCandidates(txContext.client, txContext.config, activeServingIds, logger);
        if (activeServingIds.every((id) => alive.has(id))) {
          doSubmit(topRelayIds);
          return;
        }
        // At least one actively-serving candidate failed its liveness probe
        // (e.g. a heartbeating-but-stale-endpoint relay, see
        // relay_registry.move's update_endpoint_url doc comment) -- retry
        // ONCE against the pool with dead candidates excluded, instead of
        // handing back a relay we just confirmed is unreachable.
        const livePool = capacities.filter((c) => alive.has(c.minerId) || !activeServingIds.includes(c.minerId));
        const retryBallot =
          kR <= 1
            ? (() => {
                const chosen = selectPlacementRelay(livePool, roomLoad);
                return chosen ? buildBallotForChosen(chosen) : null;
              })()
            : (() => {
                const activeRelays = selectActiveRelays(livePool, roomLoad, kR);
                return activeRelays.length >= kR ? activeRelays.map((r) => r.minerId) : null;
              })();
        if (!retryBallot) {
          logger.error(
            { roomId: e.room_id, deadCandidates: activeServingIds.filter((id) => !alive.has(id)) },
            'No live relay candidate survived liveness probing after retry — deferring assignment',
          );
          pendingRooms.set(e.room_id, roomData);
          pendingEscrows?.set(e.room_id, e);
          return;
        }
        doSubmit(retryBallot);
      })();
    } else {
      doSubmit(topRelayIds);
    }
  } else {
    logger.warn({ roomId: e.room_id }, 'No TX context — pairing proposal skipped (test mode)');
  }
}
