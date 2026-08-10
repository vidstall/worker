/**
 * Liveness sweep -- vote casting + ejection.
 *
 * STAKE POSITION LOOKUP: `StakePosition` is a SHARED object (post owned→shared
 * migration, see liveness_voting.move's module doc) with no on-chain miner_id ->
 * object_id index, so `execute_ejection`'s `position` argument is resolved via a
 * GraphQL `objects(filter: { type: "<pkg>::staking::StakePosition" })` scan
 * (Sui's documented mechanism for finding shared objects by type, independent of
 * owner) rather than a Move-side lookup table.
 *
 * Extracted from the former `liveness-sweep.ts` monolith. `findStakePositionId`
 * is re-exported from `liveness-sweep.ts` so external import sites are unchanged.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient, GraphQLQueryResult } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';

/** Cast `cast_liveness_vote` against `targetMinerId`, signed by this validator's main wallet. */
export async function castLivenessVote(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  targetMinerId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::liveness_voting::cast_liveness_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.livenessVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.validatorRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.pure.id(targetMinerId),
        ],
      });
    },
    'cast-liveness-vote',
    logger,
  );
  return result !== null;
}

// ── GraphQL: resolve a miner_id's StakePosition shared-object id ──

const STAKE_POSITION_QUERY = `
  query FindStakePositions($type: String!, $after: String) {
    objects(filter: { type: $type }, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        address
        asMoveObject { contents { json } }
      }
    }
  }
`;

interface StakePositionQueryResult {
  objects: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ address: string; asMoveObject: { contents: { json: unknown } } | null }>;
  };
}

/**
 * Scan all shared `StakePosition` objects of this deployment's ORIGINAL package
 * (the struct's type is pinned to the defining package forever, same rationale
 * as NetworkConfig.originalPackageId / EventPoller) looking for one whose
 * `miner_id` field matches `targetMinerId`. Returns `null` if not found or the
 * query fails (crash-safe — caller skips the ejection attempt this tick).
 */
export async function findStakePositionId(
  graphqlClient: SuiGraphQLClient,
  config: NetworkConfig,
  targetMinerId: string,
  logger: Logger,
  maxPages = 20,
): Promise<string | null> {
  const type = `${config.originalPackageId ?? config.packageId}::staking::StakePosition`;
  let cursor: string | null = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const result: GraphQLQueryResult<StakePositionQueryResult> = await graphqlClient.query<
        StakePositionQueryResult,
        { type: string; after: string | null }
      >({ query: STAKE_POSITION_QUERY, variables: { type, after: cursor } });

      const conn = result.data?.objects;
      if (!conn) break;

      for (const node of conn.nodes) {
        const json = node.asMoveObject?.contents.json as { miner_id?: string } | undefined;
        if (json?.miner_id === targetMinerId) return node.address;
      }

      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  } catch (err) {
    logger.warn({ err, targetMinerId }, 'liveness-sweep: findStakePositionId GraphQL query failed');
    return null;
  }
  return null;
}

/** Submit `registration::execute_ejection` for a target whose quorum has already been approved. */
export async function executeEjection(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  stakePositionId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::registration::execute_ejection`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.livenessVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(stakePositionId),
        ],
      });
    },
    'execute-ejection',
    logger,
  );
  return result !== null;
}
