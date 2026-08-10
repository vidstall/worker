/**
 * L_chain_create measurement phase for the P3 chain-latency measurement
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

export async function measureCreate(
  client: SuiClient,
  config: NetworkConfig,
  roster: Roster,
  matcher: ExactEventMatcher,
  options: ChainLatencyOptions,
  sampleIndex: number,
): Promise<{ roomId: string; record: SampleRecord }> {
  const eventType = `${config.packageId}::room_manager::RoomCreated`;
  const execution = await executeTimed(client, roster.userKp, 'create_room', (tx) => {
    tx.moveCall({
      target: `${config.packageId}::room_manager::create_room`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roomManagerId),
        tx.object(config.userRegistryId),
        tx.pure.u8(0),
        tx.pure.u64(2),
        tx.pure.u8(0),
      ],
    });
  });
  const receiptEvent = exactEvent(execution.result, eventType, 'create_room');
  const roomId = eventRoomId(receiptEvent, 'create_room');
  const observationPromise = matcher.waitFor(execution.digest, eventType, roomId);
  const [finality, observation] = await Promise.all([
    awaitFinality(client, execution.digest, 'create_room'),
    observationPromise,
  ]);
  return {
    roomId,
    record: makeSampleRecord(
      options,
      'L_chain_create',
      sampleIndex,
      roomId,
      null,
      execution,
      finality,
      observation,
    ),
  };
}
