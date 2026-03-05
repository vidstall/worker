/**
 * Event handler for CP daemon — processes relay/room/CP events from Sui chain.
 *
 * Maintains an in-memory relay state map populated from events.
 * On RoomCreated, runs the scoring algorithm and logs the ranked results.
 * Does NOT submit votes on-chain (Room voting deferred to v2).
 */

import type { SuiEvent } from '@mysten/sui/client';
import type { Logger } from '@dvconf/shared';
import type {
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  RoomCreated,
} from '@dvconf/shared';
import { scoreRelays, type RelayCandidate, type ScoringWeights } from './scoring.js';

/** Default scoring weights (sum = 10_000). */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  reputation: 3_000n,
  rtt: 3_000n,
  load: 2_000n,
  stake: 1_000n,
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
 * Handle a single Sui event, updating relay state and scoring as needed.
 */
export function handleEvent(
  event: SuiEvent,
  relayState: Map<string, RelayCandidate>,
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
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

    case 'RoomCreated': {
      const e = data as unknown as RoomCreated;
      logger.info({ roomId: e.room_id, creator: e.creator, relayMode: e.relay_mode }, 'Room created');

      // Score all known relays for this room
      const relays = Array.from(relayState.values());
      if (relays.length === 0) {
        logger.info({ roomId: e.room_id }, 'No relays available for scoring');
        break;
      }

      // Use empty string as target region (room does not specify region)
      const ranked = scoreRelays(relays, weights, '');
      logger.info(
        {
          roomId: e.room_id,
          relayCount: relays.length,
          topRelays: ranked.slice(0, 5).map((r) => ({
            minerId: r.minerId,
            score: r.score.toString(),
          })),
        },
        'Relay scoring complete (vote NOT submitted — deferred to v2)',
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
 * Create an event handler function bound to its own relay state map.
 *
 * Returns the handler and the relay state map for testing/inspection.
 */
export function createEventHandler(
  logger: Logger,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): {
  handler: (event: SuiEvent) => Promise<void>;
  relayState: Map<string, RelayCandidate>;
} {
  const relayState = new Map<string, RelayCandidate>();

  const handler = async (event: SuiEvent): Promise<void> => {
    handleEvent(event, relayState, logger, weights);
  };

  return { handler, relayState };
}
