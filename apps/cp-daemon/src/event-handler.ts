/**
 * Event handler for CP daemon — processes relay/room/CP/signaling/voting events from Sui chain.
 *
 * Maintains in-memory relay, validator, and signaling state maps populated from events.
 * On RoomCreated + EscrowCreated, runs scoring and submits pairing proposal via
 * submit_pairing_proposal (PAIR-01).
 *
 * Tracks votedRooms to prevent duplicate proposals (PAIR-03).
 * Handles RoomAssigned events to clear voted rooms (PAIR-03).
 * MCU-aware scoring: 2x load weight for MCU rooms (MCU-05, MCU-06).
 */

import { randomUUID } from 'node:crypto';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiEvent } from '@mysten/sui/client';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type {
  MinerRegistered,
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  RelaySlashed,
  RoomCreated,
  RoomAssigned,
  EscrowCreated,
  SignalingRegistered,
  SignalingLoadUpdated,
  ValidatorRegistered,
  RoleAssigned as RoleAssignedEvent,
  RoleChanged,
  RevoteEligibleMarked,
  RoleTransitioned,
  SecretRotated,
} from '@dvconf/shared';
import { MinerRole } from '@dvconf/shared';
import {
  computeNodeScore,
  computePairingScore,
  PVR_WEIGHTS,
  PVR_DEFAULT_HISTORY,
  type NodeCandidate,
  type ScoringWeights,
} from './scoring.js';
import {
  estimateRoomLoad,
  selectPlacementRelay,
  selectActiveRelays,
  poolHealthGate,
  excludeFlaggedRelays, // selectTopRelays is NOT imported here — unused in event-handler (BLOCKER-2); it lives only in the 5a.2 unit test
  MIN_RELAY,
  type RoomClass,
  type RelayCapacity,
} from './admission-capacity.js';
import { type AttestedLoad } from './coverage-load-reader.js';
import { PVR_HEARTBEAT_STALE } from './scoring.js';
import { timedCanonicalSort } from './latency-probe.js';
import {
  submitProposal,
  pickSignalingNode,
  clearVotedRoom,
  votedRooms,
  type SignalingCandidate,
} from './room-assignment.js';
import { clearVotedMiner, trackUnassignedMiner, trackRevoteCandidate, clearRevoteCandidate } from './role-voter.js';
import type { TurnIssuer } from './turn-issuer.js';
import type {
  CapTokenIssuer,
  RoomAssignedEvent as IssuerRoomAssigned,
  RoleChangedEvent as IssuerRoleChanged,
  RoleAssignedEvent as IssuerRoleAssigned,
  RelaySlashedEvent as IssuerRelaySlashed,
} from './cap-token-issuer.js';

// ── RelayPromoted observer types (CONTRACTS C8, REQ-RO-009) ─────────────────

/** Shape of the RelayPromoted on-chain event (room_manager.move, Phase 1 RO-003). */
export interface RelayPromotedEvent {
  type: 'RelayPromoted';
  room_id: string;
  old_primary: string;
  new_primary: string;
  epoch: number;
}

/** Observer interface for RelayPromoted chain events. */
export interface RelayPromotedObserver {
  onRelayPromoted(event: RelayPromotedEvent, traceId: string): Promise<void>;
}

/** Default scoring weights — re-exported from scoring.ts for convenience. */
export const DEFAULT_WEIGHTS: ScoringWeights = PVR_WEIGHTS;

/**
 * Maps event type suffix to a known handler.
 * Event types are formatted as `{packageId}::{module}::{EventName}`.
 */
function extractEventName(eventType: string): string {
  const parts = eventType.split('::');
  return parts[parts.length - 1] ?? eventType;
}

/**
 * W-P2 (D-W9) — fire-and-forget a cap-token issuer dispatch. `handleEvent` is a
 * synchronous void function (the poller awaits the handler, but each arm runs
 * sync); the issuer's `onX` handlers are async + already wrap their own bodies in
 * try/catch, so we do not await here. The `.catch` is a defensive backstop that
 * keeps any unexpected rejection from becoming an unhandled promise rejection.
 */
function dispatchCapToken(
  p: Promise<void>,
  logger: Logger,
  ctx: Record<string, unknown>,
): void {
  p.catch((err) => logger.error({ err, ...ctx }, 'cap-token issuer dispatch failed'));
}

/**
 * Handle a single Sui event, updating relay/validator/signaling state and scoring as needed.
 *
 * Room assignment is deferred until EscrowCreated is received. Flow:
 *   RoomCreated -> store in pendingRooms
 *   EscrowCreated -> match room_id -> score relays + validators -> submit proposal
 */
export function handleEvent(
  event: SuiEvent,
  relayState: Map<string, NodeCandidate>,
  signalingState: Map<string, SignalingCandidate>,
  pendingRooms: Map<string, RoomCreated>,
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  txContext?: {
    client: SuiClient;
    signer: Ed25519Keypair;
    config: NetworkConfig;
    cpCapId: string;
    turnIssuer?: TurnIssuer;
    capTokenIssuer?: CapTokenIssuer;
    relayPromotedObserver?: RelayPromotedObserver;
  },
  pendingEscrows?: Map<string, EscrowCreated>,
  validatorState?: Map<string, NodeCandidate>,
  attestedLoad?: Map<string, AttestedLoad>,
  currentEpoch?: bigint,
  /** REQ-RMS-015 — optional canary-flag predicate; relays it flags are excluded from placement (additive/back-compat, undefined => M1 path). */
  byzantineFlag?: (minerId: string) => boolean,
): void {
  const eventName = extractEventName(event.type);
  const data = event.parsedJson as Record<string, unknown>;

  switch (eventName) {
    case 'RelayRegistered': {
      const e = data as unknown as RelayRegistered;
      const regionStr = Array.isArray(e.region)
        ? e.region.map((n) => String(n)).join(',')
        : '';
      const candidate: NodeCandidate = {
        minerId: e.miner_id,
        rtt: 0n, // Unknown until validator probes
        load: 0n, // No load at registration
        stakeAmount: BigInt(e.stake_amount),
        heartbeatAge: 0n, // Assume fresh at registration
        region: regionStr,
        historyScore: PVR_DEFAULT_HISTORY,
      };
      relayState.set(e.miner_id, candidate);
      logger.info({ minerId: e.miner_id, region: regionStr }, 'Relay registered');

      // Re-attempt assignment for rooms deferred due to missing relays
      if (pendingEscrows && pendingEscrows.size > 0) {
        for (const [roomId, escrow] of pendingEscrows) {
          if (pendingRooms.has(roomId)) {
            logger.info({ roomId }, 'New relay registered — retrying deferred assignment');
            pendingEscrows.delete(roomId);
            handleEvent(
              { ...event, type: `${event.type.split('::')[0]}::economic_layer::EscrowCreated`, parsedJson: escrow as unknown as Record<string, unknown> },
              relayState, signalingState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState,
              attestedLoad, currentEpoch, byzantineFlag,
            );
          }
        }
      }
      break;
    }

    case 'RelayLoadUpdated': {
      const e = data as unknown as RelayLoadUpdated;
      const existing = relayState.get(e.miner_id);
      if (existing) {
        existing.load = BigInt(e.new_load);
        logger.info({ minerId: e.miner_id, newLoad: e.new_load }, 'Relay load updated');
      } else {
        logger.warn({ minerId: e.miner_id }, 'RelayLoadUpdated for unknown relay, ignoring');
      }
      break;
    }

    case 'RelayRTTUpdated': {
      const e = data as unknown as RelayRTTUpdated;
      const existing = relayState.get(e.miner_id);
      if (existing) {
        existing.rtt = BigInt(e.rtt);
        logger.info({ minerId: e.miner_id, rtt: e.rtt }, 'Relay RTT updated');
      } else {
        logger.warn({ minerId: e.miner_id }, 'RelayRTTUpdated for unknown relay, ignoring');
      }
      break;
    }

    case 'RelayHeartbeat': {
      // REQ-RMS-019 — refresh candidate.heartbeatAge (was stuck at 0n; no arm existed).
      const e = data as unknown as { miner_id: string; epoch: string };
      const existing = relayState.get(e.miner_id);
      if (existing) {
        const hbEpoch = BigInt(e.epoch);
        const now = currentEpoch ?? hbEpoch; // in tests with no chain epoch, treat the heartbeat as fresh
        existing.heartbeatAge = now > hbEpoch ? now - hbEpoch : 0n;
        logger.info({ minerId: e.miner_id, epoch: e.epoch, heartbeatAge: existing.heartbeatAge.toString() }, 'Relay heartbeat — age refreshed');
      } else {
        logger.warn({ minerId: e.miner_id }, 'RelayHeartbeat for unknown relay, ignoring');
      }
      break;
    }

    case 'RelaySlashed': {
      // ADR-0005 § Mid-room kill-switch — forward to TURN issuer so it stops
      // issuing fresh credentials for this miner. Existing credentials remain
      // technically valid against the slashed coturn until TTL expiry, but
      // no compliant client will use them.
      const e = data as unknown as RelaySlashed;
      if (txContext?.turnIssuer) {
        txContext.turnIssuer.markSlashed(e.relay_miner_id);
        logger.info(
          { relayMinerId: e.relay_miner_id, roomId: e.room_id, slashAmount: e.slash_amount },
          'Relay slashed — TURN issuer kill-switch armed for this miner',
        );
      } else {
        logger.warn(
          { relayMinerId: e.relay_miner_id },
          'RelaySlashed observed but no TurnIssuer in txContext — kill-switch not armed',
        );
      }
      // F62 M2 W-P2 (D-W8) — ADDITIVE cap-token revoke on slash, orthogonal to the
      // TURN kill-switch above. The issuer revokes the slashed relay's RoomCapability
      // (REQ-ADM via revoke_capability_token_via_quorum); the cache evicts on the
      // resulting CapabilityRevoked chain event.
      if (txContext?.capTokenIssuer) {
        const traceId = randomUUID();
        const evt: IssuerRelaySlashed = {
          roomId: e.room_id,
          relayMinerId: e.relay_miner_id,
          slashAmount: e.slash_amount,
        };
        dispatchCapToken(
          txContext.capTokenIssuer.onRelaySlashed(evt, traceId),
          logger,
          { roomId: e.room_id, relayMinerId: e.relay_miner_id, handler: 'onRelaySlashed' },
        );
      }
      break;
    }

    case 'SecretRotated': {
      // F8 (REQ-CRR-005) — emergency relay-secret rotation kill-switch. Mirrors
      // the RelaySlashed → markSlashed precedent above: forward the LEAKED
      // `old_secret_id` to the TURN issuer so it stops serving/reusing the
      // compromised secret immediately, deliberately overriding the 2-secret
      // overlap grace. The on-chain SecretRotated event is the audit anchor;
      // coturn-side eviction + multi-CP coordination stay deferred (turn-issuer
      // scope boundary). Orthogonal to RoomCapability admission tokens (D-009):
      // this is a TURN shared-secret rotation, not a cap-token revoke.
      const e = data as unknown as SecretRotated;
      if (txContext?.turnIssuer) {
        const secretId = Number(e.old_secret_id);
        const evicted = txContext.turnIssuer.emergencyEvictSecret(secretId, e.reason);
        logger.warn(
          {
            cpMinerId: e.cp_miner_id,
            oldSecretId: e.old_secret_id,
            newSecretId: e.new_secret_id,
            reason: e.reason,
            evicted,
          },
          'SecretRotated — TURN issuer emergency kill-switch (F8)',
        );
      } else {
        logger.warn(
          { oldSecretId: e.old_secret_id },
          'SecretRotated observed but no TurnIssuer in txContext — emergency evict not armed',
        );
      }
      break;
    }

    case 'ValidatorRegistered': {
      const e = data as unknown as ValidatorRegistered;
      if (validatorState) {
        const candidate: NodeCandidate = {
          minerId: e.miner_id,
          rtt: 0n,
          load: 0n,
          stakeAmount: BigInt(e.stake_amount),
          heartbeatAge: 0n, // Assume fresh at registration
          region: '', // Validators don't have region in event
          historyScore: PVR_DEFAULT_HISTORY,
        };
        validatorState.set(e.miner_id, candidate);
        logger.info({ minerId: e.miner_id }, 'Validator registered');
      }
      break;
    }

    case 'SignalingRegistered': {
      const e = data as unknown as SignalingRegistered;
      const regionStr = Array.isArray(e.region)
        ? e.region.map((n) => String(n)).join(',')
        : '';
      const candidate: SignalingCandidate = {
        minerId: e.miner_id,
        load: 0n,
        region: regionStr,
      };
      signalingState.set(e.miner_id, candidate);
      logger.info({ minerId: e.miner_id, region: regionStr }, 'Signaling node registered');
      break;
    }

    case 'SignalingLoadUpdated': {
      const e = data as unknown as SignalingLoadUpdated;
      const existing = signalingState.get(e.miner_id);
      if (existing) {
        existing.load = BigInt(e.new_load);
        logger.info({ minerId: e.miner_id, newLoad: e.new_load }, 'Signaling load updated');
      } else {
        logger.warn({ minerId: e.miner_id }, 'SignalingLoadUpdated for unknown signaling node, ignoring');
      }
      break;
    }

    case 'RoomCreated': {
      const e = data as unknown as RoomCreated;
      // Check if escrow already arrived before this room event (race condition)
      const earlyEscrow = pendingEscrows?.get(e.room_id);
      if (earlyEscrow) {
        pendingEscrows!.delete(e.room_id);
        logger.info({ roomId: e.room_id, creator: e.creator, relayMode: e.relay_mode }, 'Room created -- escrow already pending, triggering assignment');
        // Add room to pendingRooms so the EscrowCreated handler can find it
        pendingRooms.set(e.room_id, e);
        // Re-dispatch through EscrowCreated handler by synthesizing the event
        handleEvent(
          { ...event, type: `${event.type.split('::')[0]}::economic_layer::EscrowCreated`, parsedJson: earlyEscrow as unknown as Record<string, unknown> },
          relayState, signalingState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState,
          attestedLoad, currentEpoch, byzantineFlag,
        );
      } else {
        logger.info({ roomId: e.room_id, creator: e.creator, relayMode: e.relay_mode }, 'Room created — waiting for escrow before assignment');
        pendingRooms.set(e.room_id, e);
      }
      break;
    }

    case 'EscrowCreated': {
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
        break;
      }
      pendingRooms.delete(e.room_id);
      logger.info({ roomId: e.room_id, escrowId: e.escrow_id, amount: e.amount }, 'Escrow created — assigning infrastructure');

      // PAIR-03: Skip rooms already voted on
      if (votedRooms.has(e.room_id)) {
        logger.debug({ roomId: e.room_id }, 'Already submitted proposal for this room, skipping');
        break;
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
        break;
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
        break;
      }

      // Pick a signaling node
      const signalingMinerId = pickSignalingNode(signalingState);
      if (!signalingMinerId) {
        logger.warn({ roomId: e.room_id }, 'No signaling nodes available — deferring assignment');
        pendingRooms.set(e.room_id, roomData);
        pendingEscrows?.set(e.room_id, e);
        break;
      }

      // PAIR-02: Score and select validators via PVR canonicalSort (timed when BENCH_LATENCY=1)
      const validators = validatorState ? Array.from(validatorState.values()) : [];
      const rankedValidators = timedCanonicalSort(validators, targetRegion, weights);

      // Select top validators (at least 1 if available)
      const topValidatorIds = rankedValidators
        .slice(0, Math.max(1, Math.min(3, rankedValidators.length)))
        .map(v => v.minerId);

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
        break;
      }

      let topRelayIds: string[];
      if (kR <= 1) {
        // ── M1 PATH (preserved verbatim): single active relay + ballot padded to MIN_RELAY. ──
        // REQ-RMS-002 — i* = argmin (l_i + L_r)/C_worker s.t. <= C_worker, RTT tie-break.
        const chosen = selectPlacementRelay(capacities, roomLoad);
        if (!chosen) {
          logger.warn({ roomId: e.room_id, roomLoad, cWorker }, 'No relay can absorb L_r under capacity ceiling — deferring');
          pendingRooms.set(e.room_id, roomData);
          pendingEscrows?.set(e.room_id, e);
          break;
        }
        // The RECORDED ballot must be >= MIN_RELAY (on-chain floor), even though only `chosen` serves the
        // room. Order: chosen first, then capacity-eligible peers, then back-fill from the rest of the
        // consensus-sorted relays to reach MIN_RELAY (a ballot, not a live assignment). rankedRelays is
        // already consensus-sorted (canonicalSort), chosen-first below.
        const chosenFirst: string[] = [chosen.minerId];
        const eligiblePeers = capacities
          .filter((c) => c.minerId !== chosen.minerId && c.attestedLoadPaths + roomLoad <= c.cWorker)
          .map((c) => c.minerId);
        const restByConsensus = rankedRelays
          .map((r) => r.minerId)
          .filter((id) => id !== chosen.minerId && !eligiblePeers.includes(id)); // not chosen, not already an eligible peer
        const ballot = [...chosenFirst, ...eligiblePeers, ...restByConsensus]; // de-dup guaranteed by the filters
        if (ballot.length < MIN_RELAY) {
          // The ENTIRE pool has < MIN_RELAY relays — cannot record a valid ballot; defer (graceful).
          logger.warn({ roomId: e.room_id, poolSize: ballot.length, minRelay: MIN_RELAY }, 'Fewer than MIN_RELAY relays exist — deferring (cannot satisfy on-chain ballot floor)');
          pendingRooms.set(e.room_id, roomData);
          pendingEscrows?.set(e.room_id, e);
          break;
        }
        topRelayIds = ballot.slice(0, MIN_RELAY); // exactly MIN_RELAY for K_r=1 M1; chosen is index 0
      } else {
        // ── REQ-RMS-021: kR>1 ACTIVE relays (>=3 for the LOCAL demo). All emitted ids ACTIVELY serve. ──
        const activeRelays = selectActiveRelays(capacities, roomLoad, kR);
        if (activeRelays.length < kR) {
          logger.warn({ roomId: e.room_id, need: kR, got: activeRelays.length }, 'Fewer than K_r relays can absorb a share — deferring');
          pendingRooms.set(e.room_id, roomData);
          pendingEscrows?.set(e.room_id, e);
          break;
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
        submitProposal(
          txContext.client,
          txContext.signer,
          txContext.config,
          txContext.cpCapId,
          e.room_id,
          topRelayIds,
          topValidatorIds,
          signalingMinerId,
          submittedScore,
          logger,
        ).then(() => {
          logger.info(
            { roomId: e.room_id, relays: topRelayIds, validators: topValidatorIds, signalingId: signalingMinerId },
            'Pairing proposal submitted successfully',
          );
        }).catch((err) => {
          logger.error({ err, roomId: e.room_id }, 'Pairing proposal TX failed');
        });
      } else {
        logger.warn({ roomId: e.room_id }, 'No TX context — pairing proposal skipped (test mode)');
      }
      break;
    }

    case 'RoomAssigned': {
      // PAIR-03: Clear voted rooms when assignment is finalized
      const e = data as unknown as RoomAssigned;
      clearVotedRoom(e.room_id);
      logger.info(
        { roomId: e.room_id, relayIds: e.relay_ids, signalingId: e.signaling_id },
        'Room assigned — cleared from voted rooms',
      );
      // F62 M2 W-P2 (D-W9) — issue cap-tokens to every assigned peer (REQ-ADM-001).
      // Map the snake_case Move event payload to the issuer's camelCase shape.
      if (txContext?.capTokenIssuer) {
        const traceId = randomUUID();
        const evt: IssuerRoomAssigned = {
          roomId: e.room_id,
          relayIds: e.relay_ids,
          signalingId: e.signaling_id,
          relayMode: e.relay_mode,
          verifiedScore: e.verified_score,
          consensusReached: e.consensus_reached,
          winningCp: e.winning_cp,
          validatorIds: e.validator_ids,
        };
        dispatchCapToken(
          txContext.capTokenIssuer.onRoomAssigned(evt, traceId),
          logger,
          { roomId: e.room_id, handler: 'onRoomAssigned' },
        );
      }
      break;
    }

    case 'CapabilityIssued': {
      // Leg 7c (G3) — observe the on-chain CapabilityIssued event to feed the infra-peer
      // pubkey recovery cache (clones the RoomAssigned dispatch shape above). The cache is
      // keyed by (roomId, peerId); the event carries the real 32-byte peer_pubkey + the
      // emitting peer's miner-id (peer_id). FAIL-CLOSED-AT-INSERT: the cache itself rejects a
      // non-32-byte pubkey (never poisons recovery into a 916 mint). When the event omits a
      // peer_id (the accepted async-hazard per the locked decision) we debug-log + skip the
      // observe rather than key by a non-recovery field.
      const e = data as unknown as {
        token_id?: string;
        room_id: string;
        peer_pubkey: number[];
        role?: number;
        expires_epoch?: string;
        peer_id?: string;
      };
      if (txContext?.capTokenIssuer) {
        const traceId = randomUUID();
        if (e.peer_id) {
          txContext.capTokenIssuer.onCapabilityIssued(
            e.peer_id,
            {
              tokenId: e.token_id,
              roomId: e.room_id,
              peerPubkey: e.peer_pubkey,
              role: e.role,
              expiresEpoch: e.expires_epoch,
            },
            traceId,
          );
        } else {
          logger.debug(
            { roomId: e.room_id },
            'CapabilityIssued observed without a peer_id — infra-peer recovery cache not fed (accepted G3 async-hazard)',
          );
        }
      }
      break;
    }

    case 'RoleAssigned': {
      // Clear voted miner from role-voter when role is assigned
      const e = data as unknown as RoleAssignedEvent;
      clearVotedMiner(e.miner_id);
      logger.info(
        { minerId: e.miner_id, role: e.role },
        'Role assigned — cleared from voted miners',
      );
      // F62 M2 W-P2 (D-W9) — vote-consensus role assignment drives the cap-token
      // refresh path (REQ-ADM-013/014, grace-timer inside the issuer).
      if (txContext?.capTokenIssuer) {
        const traceId = randomUUID();
        const evt: IssuerRoleAssigned = {
          minerId: e.miner_id,
          role: e.role,
          voteCount: e.vote_count,
          threshold: e.threshold,
        };
        dispatchCapToken(
          txContext.capTokenIssuer.onRoleAssigned(evt, traceId),
          logger,
          { minerId: e.miner_id, handler: 'onRoleAssigned' },
        );
      }
      break;
    }

    case 'RoleChanged': {
      // F62 M2 W-P2 (D-W8) — NEW case arm. registration::RoleChanged was emitted
      // (registration.move:51) but previously had no handler. Drives the cap-token
      // role-change refresh (REQ-ADM-013/014); the issuer schedules a cancellable
      // grace timer (a B→A revert cancels a pending A→B refresh).
      const e = data as unknown as RoleChanged;
      if (txContext?.capTokenIssuer) {
        const traceId = randomUUID();
        const evt: IssuerRoleChanged = {
          minerId: e.miner_id,
          oldRole: e.old_role,
          newRole: e.new_role,
          newStake: e.new_stake,
        };
        dispatchCapToken(
          txContext.capTokenIssuer.onRoleChanged(evt, traceId),
          logger,
          { minerId: e.miner_id, handler: 'onRoleChanged' },
        );
      } else {
        logger.debug(
          { minerId: e.miner_id, newRole: e.new_role },
          'RoleChanged observed but no CapTokenIssuer in txContext — refresh not scheduled',
        );
      }
      break;
    }

    case 'MinerRegistered': {
      // VOTE-05: Track unassigned miners (role=0/User) for role voting
      const e = data as unknown as MinerRegistered;
      if (e.role === MinerRole.User) {
        trackUnassignedMiner(e.miner_id);
        logger.info(
          { minerId: e.miner_id },
          'Unassigned miner registered — added to role voting queue',
        );
      }
      break;
    }

    case 'RevoteEligibleMarked': {
      // F47 RV-010: a miner became re-vote-eligible → queue it for a re-vote.
      // Field names read here MUST match the Move struct exactly (OQ-PH16 lock).
      const e = data as unknown as RevoteEligibleMarked;
      trackRevoteCandidate(e.miner_id);
      logger.info(
        { minerId: e.miner_id, reason: e.reason, currentRole: e.current_role, markedAt: e.marked_at },
        'Re-vote eligible marked — added to re-vote queue',
      );
      break;
    }

    case 'RoleTransitioned': {
      // F47 RV-010: a re-vote completed (role changed) → clear the candidate.
      const e = data as unknown as RoleTransitioned;
      clearRevoteCandidate(e.miner_id);
      logger.info(
        { minerId: e.miner_id, oldRole: e.old_role, newRole: e.new_role },
        'Role transitioned — cleared from re-vote queue',
      );
      break;
    }

    case 'RelayPromoted': {
      // M1 Phase 3.1 (REQ-RO-009) — chain-authoritative promotion event (C8).
      // Emitted by room_manager::promote_relay after on-chain staleness assert.
      // Drives client re-discovery via the injected RelayPromotedObserver.
      const e = data as unknown as { room_id: string; old_primary: string; new_primary: string; epoch: number };
      const traceId = randomUUID();
      const evt: RelayPromotedEvent = {
        type: 'RelayPromoted',
        room_id: e.room_id,
        old_primary: e.old_primary,
        new_primary: e.new_primary,
        epoch: e.epoch,
      };
      logger.info(
        {
          trace_id: traceId,
          module: 'event-handler',
          action: 'relay-promoted',
          context: { roomId: e.room_id, oldPrimary: e.old_primary, newPrimary: e.new_primary, epoch: e.epoch },
        },
        'RelayPromoted — relay promotion observed; forwarding to observer',
      );
      if (txContext?.relayPromotedObserver !== undefined) {
        // Fire-and-forget — same pattern as dispatchCapToken (D-W9)
        txContext.relayPromotedObserver
          .onRelayPromoted(evt, traceId)
          .catch((err) =>
            logger.error(
              { trace_id: traceId, module: 'event-handler', err },
              'RelayPromoted observer dispatch failed',
            ),
          );
      } else {
        logger.debug(
          { trace_id: traceId, module: 'event-handler', context: { roomId: e.room_id } },
          'RelayPromoted received but no observer registered',
        );
      }
      break;
    }

    default: {
      logger.debug({ eventType: event.type, eventName }, 'Unknown event type, skipping');
      break;
    }
  }
}

/**
 * Create an event handler function bound to its own relay, validator, and signaling state maps.
 *
 * Returns the handler and state maps for testing/inspection.
 */
export function createEventHandler(
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  txContext?: {
    client: SuiClient;
    signer: Ed25519Keypair;
    config: NetworkConfig;
    cpCapId: string;
    turnIssuer?: TurnIssuer;
    capTokenIssuer?: CapTokenIssuer;
    relayPromotedObserver?: RelayPromotedObserver;
  },
  // REQ-RMS-005/019 — capacity-aware admission context (additive, optional). The daemon wiring
  // populates `attestedLoad` from fetchAttestedLoad on the canary cadence and `currentEpoch`
  // from the chain; both are injected + defaulted so existing callers/tests are unaffected.
  capacityCtx?: {
    attestedLoad?: Map<string, AttestedLoad>;
    currentEpoch?: () => bigint | undefined;
    /**
     * REQ-RMS-015 — fresh canary-flag predicate per dispatch (mirrors currentEpoch's
     * thunk shape so the latest verify-loop accumulator is read each event). The daemon
     * wiring binds it to isRelayFlaggedByCanary(acc, id, budget, MIN_ROUNDS_FOR_CUMULATIVE).
     * Undefined => no exclusion (M1 path). The live accumulator producer is demo/M4b scope.
     */
    byzantineFlag?: () => ((minerId: string) => boolean) | undefined;
  },
): {
  handler: (event: SuiEvent) => Promise<void>;
  relayState: Map<string, NodeCandidate>;
  signalingState: Map<string, SignalingCandidate>;
  validatorState: Map<string, NodeCandidate>;
  pendingRooms: Map<string, RoomCreated>;
  pendingEscrows: Map<string, EscrowCreated>;
} {
  const relayState = new Map<string, NodeCandidate>();
  const signalingState = new Map<string, SignalingCandidate>();
  const validatorState = new Map<string, NodeCandidate>();
  const pendingRooms = new Map<string, RoomCreated>();
  const pendingEscrows = new Map<string, EscrowCreated>();

  const handler = async (event: SuiEvent): Promise<void> => {
    handleEvent(
      event, relayState, signalingState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState,
      capacityCtx?.attestedLoad, capacityCtx?.currentEpoch?.(), capacityCtx?.byzantineFlag?.(),
    );
  };

  return { handler, relayState, signalingState, validatorState, pendingRooms, pendingEscrows };
}
