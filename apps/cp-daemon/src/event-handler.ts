/**
 * Event handler for CP daemon — processes relay/room/CP/signaling events from Sui chain.
 *
 * Maintains in-memory relay and signaling state maps populated from events.
 * On RoomCreated, runs the scoring algorithm and submits assign_relay_and_signaling TX.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiEvent } from '@mysten/sui/client';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type {
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  RoomCreated,
  EscrowCreated,
  SignalingRegistered,
  SignalingLoadUpdated,
} from '@dvconf/shared';
import { scoreRelays, type RelayCandidate, type ScoringWeights } from './scoring.js';
import { assignRoom, pickSignalingNode, type SignalingCandidate } from './room-assignment.js';

/** Default scoring weights (sum = 10_000). */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  reputation: 3_000n,
  rtt: 2_500n,
  load: 2_000n,
  stake: 1_500n,
  regionMatch: 1_000n,
};

/**
 * Maps event type suffix to a known handler.
 * Event types are formatted as `{packageId}::{module}::{EventName}`.
 */
function extractEventName(eventType: string): string {
  const parts = eventType.split('::');
  return parts[parts.length - 1] ?? eventType;
}

/**
 * Handle a single Sui event, updating relay/signaling state and scoring as needed.
 *
 * Room assignment is deferred until EscrowCreated is received. Flow:
 *   RoomCreated → store in pendingRooms
 *   EscrowCreated → match room_id → score relays → assign infrastructure
 */
export function handleEvent(
  event: SuiEvent,
  relayState: Map<string, RelayCandidate>,
  signalingState: Map<string, SignalingCandidate>,
  pendingRooms: Map<string, RoomCreated>,
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  txContext?: {
    client: SuiClient;
    signer: Ed25519Keypair;
    config: NetworkConfig;
    cpCapId: string;
  },
): void {
  const eventName = extractEventName(event.type);
  const data = event.parsedJson as Record<string, unknown>;

  switch (eventName) {
    case 'RelayRegistered': {
      const e = data as unknown as RelayRegistered;
      const regionStr = Array.isArray(e.region)
        ? e.region.map((n) => String(n)).join(',')
        : '';
      const candidate: RelayCandidate = {
        minerId: e.miner_id,
        reputation: 5_000n, // Default starting reputation (50%)
        rtt: 0n, // Unknown until validator probes
        load: 0n, // No load at registration
        stakeAmount: BigInt(e.stake_amount),
        region: regionStr,
      };
      relayState.set(e.miner_id, candidate);
      logger.info({ minerId: e.miner_id, mode: e.mode, region: regionStr }, 'Relay registered');
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
      logger.info({ roomId: e.room_id, creator: e.creator, relayMode: e.relay_mode }, 'Room created — waiting for escrow before assignment');
      pendingRooms.set(e.room_id, e);
      break;
    }

    case 'EscrowCreated': {
      const e = data as unknown as EscrowCreated;
      const roomData = pendingRooms.get(e.room_id);
      if (!roomData) {
        logger.warn({ roomId: e.room_id }, 'EscrowCreated for unknown room, ignoring');
        break;
      }
      pendingRooms.delete(e.room_id);
      logger.info({ roomId: e.room_id, escrowId: e.escrow_id, amount: e.amount }, 'Escrow created — assigning infrastructure');

      // Score all known relays for this room
      const relays = Array.from(relayState.values());
      if (relays.length === 0) {
        logger.info({ roomId: e.room_id }, 'No relays available for scoring');
        break;
      }

      // Use empty string as target region (room does not specify region)
      const ranked = scoreRelays(relays, weights, '');
      const topRelay = ranked[0];
      if (!topRelay) {
        logger.warn({ roomId: e.room_id }, 'Scoring returned no results');
        break;
      }

      // Pick a signaling node
      const signalingMinerId = pickSignalingNode(signalingState);
      if (!signalingMinerId) {
        logger.warn({ roomId: e.room_id }, 'No signaling nodes available for assignment');
        break;
      }

      logger.info(
        {
          roomId: e.room_id,
          relayCount: relays.length,
          topRelay: topRelay.minerId,
          topRelayScore: topRelay.score.toString(),
          signalingMinerId,
        },
        'Room assignment: submitting TX',
      );

      // Submit assignment TX (fire-and-forget with retry)
      if (txContext) {
        assignRoom(
          txContext.client,
          txContext.signer,
          txContext.config,
          txContext.cpCapId,
          e.room_id,
          topRelay.minerId,
          signalingMinerId,
          logger,
        ).then(() => {
          logger.info({ roomId: e.room_id, relayId: topRelay.minerId, signalingId: signalingMinerId }, 'Room assigned successfully');
        }).catch((err) => {
          logger.error({ err, roomId: e.room_id }, 'Room assignment TX failed');
        });
      } else {
        logger.warn({ roomId: e.room_id }, 'No TX context — room assignment skipped (test mode)');
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
 * Create an event handler function bound to its own relay and signaling state maps.
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
  },
): {
  handler: (event: SuiEvent) => Promise<void>;
  relayState: Map<string, RelayCandidate>;
  signalingState: Map<string, SignalingCandidate>;
  pendingRooms: Map<string, RoomCreated>;
} {
  const relayState = new Map<string, RelayCandidate>();
  const signalingState = new Map<string, SignalingCandidate>();
  const pendingRooms = new Map<string, RoomCreated>();

  const handler = async (event: SuiEvent): Promise<void> => {
    handleEvent(event, relayState, signalingState, pendingRooms, logger, weights, txContext);
  };

  return { handler, relayState, signalingState, pendingRooms };
}
