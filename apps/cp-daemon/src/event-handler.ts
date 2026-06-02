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
  },
  pendingEscrows?: Map<string, EscrowCreated>,
  validatorState?: Map<string, NodeCandidate>,
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
      const relays = Array.from(relayState.values());
      if (relays.length === 0) {
        logger.info({ roomId: e.room_id }, 'No relays available — deferring assignment');
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

      // Get relay IDs for proposal (top 2 relays or all if fewer)
      const topRelayIds = rankedRelays
        .slice(0, Math.max(1, Math.min(2, rankedRelays.length)))
        .map(r => r.minerId);

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
    handleEvent(event, relayState, signalingState, pendingRooms, logger, weights, txContext, pendingEscrows, validatorState);
  };

  return { handler, relayState, signalingState, validatorState, pendingRooms, pendingEscrows };
}
