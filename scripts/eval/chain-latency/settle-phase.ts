/**
 * L_chain_settle measurement phase for the P3 chain-latency measurement
 * harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import type { SuiClient } from '@mysten/sui/client';

import type { NetworkConfig } from '../../../packages/shared/src/index.ts';

import { awaitFinality, exactEvent, eventRoomId, executeTimed, makeSampleRecord } from './tx-helpers.ts';
import type { ExactEventMatcher } from './event-matcher.ts';
import type { ChainLatencyOptions, Roster, SampleRecord } from './types.ts';

export async function measureSettlement(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  matcher: ExactEventMatcher,
  options: ChainLatencyOptions,
  sampleIndex: number,
  roomId: string,
  escrowId: string,
): Promise<SampleRecord> {
  const eventType = `${config.packageId}::economic_layer::RewardsDistributed`;
  const execution = await executeTimed(client, roster.userKp, 'distribute_rewards', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::economic_layer::distribute_rewards`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(escrowId),
        tx.object(config.roomManagerId),
        tx.object(config.relayRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(config.cpRegistryId),
      ],
    });
  });
  const receiptEvent = exactEvent(execution.result, eventType, 'distribute_rewards');
  const receiptRoomId = eventRoomId(receiptEvent, 'distribute_rewards');
  if (receiptRoomId !== roomId) {
    throw new Error(`RewardsDistributed receipt room mismatch: expected ${roomId}, got ${receiptRoomId}`);
  }
  const observationPromise = matcher.waitFor(execution.digest, eventType, roomId);
  const [finality, observation] = await Promise.all([
    awaitFinality(client, execution.digest, 'distribute_rewards'),
    observationPromise,
  ]);
  return makeSampleRecord(
    options,
    'L_chain_settle',
    sampleIndex,
    roomId,
    escrowId,
    execution,
    finality,
    observation,
  );
}
