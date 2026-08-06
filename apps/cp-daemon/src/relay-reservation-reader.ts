/**
 * Pre-warm standby — on-chain reservation reader (relay_registry.move's
 * reserved_primary_count / reserved_standby_count).
 *
 * Mirrors relay-liveness-probe.ts's devInspect idiom: one read-only PTB per
 * candidate, no on-chain round-trip, no mutation. Used by room-assignment.ts
 * to skip a relay already at its on-chain reservation ceiling
 * (MAX_RESERVATIONS_PER_RELAY, admission-capacity.ts) before it's placed as
 * either the primary or the standby slot.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import type { NetworkConfig, Logger } from '@dvconf/shared';

const MODULE = 'relay-reservation-reader';

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

function decodeU64(bytes: number[] | undefined): number {
  if (bytes === undefined) return 0;
  return Number(bcs.u64().parse(Uint8Array.from(bytes)));
}

/**
 * Reads relay_registry::reserved_primary_count + reserved_standby_count for
 * a single miner_id. A relay that was never registered aborts on-chain
 * (E_NOT_REGISTERED) -- devInspect surfaces that as `r.error`, treated here
 * as "no reservation known" (0), same fail-open convention as
 * getActiveRelayEndpoints.
 */
async function getOneReservationLoad(
  client: SuiClient,
  config: NetworkConfig,
  minerId: string,
  logger: Logger,
): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::relay_registry::reserved_primary_count`,
    arguments: [tx.object(config.relayRegistryId), tx.pure.id(minerId)],
  });
  tx.moveCall({
    target: `${config.packageId}::relay_registry::reserved_standby_count`,
    arguments: [tx.object(config.relayRegistryId), tx.pure.id(minerId)],
  });
  const r = (await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ZERO,
  })) as DevInspectLike;
  if (r.error) {
    logger.warn(
      { module: MODULE, minerId, err: r.error },
      'reservation count devInspect failed; treating as unreserved',
    );
    return 0;
  }
  const primary = decodeU64(r.results?.[0]?.returnValues?.[0]?.[0]);
  const standby = decodeU64(r.results?.[1]?.returnValues?.[0]?.[0]);
  return primary + standby;
}

/**
 * Batched reservation-load reader: minerId -> reserved_primary_count +
 * reserved_standby_count. Candidates that fail the read (unregistered,
 * devInspect error) are absent from the returned map rather than defaulted
 * to a value that could wrongly exclude them.
 */
export async function getRelayReservationLoad(
  client: SuiClient,
  config: NetworkConfig,
  minerIds: string[],
  logger: Logger,
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    minerIds.map(async (id) => [id, await getOneReservationLoad(client, config, id, logger)] as const),
  );
  return new Map(entries);
}
