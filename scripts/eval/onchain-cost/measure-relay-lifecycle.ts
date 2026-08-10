/**
 * The full CP-voted relay lifecycle (Dispatch-1 register→vote→apply→register_relay
 * chain) with PER-STEP gasUsed capture. Pure extraction from the original
 * measure-onchain-cost.ts — no behavior changes.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  executeWithRetry,
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
} from '../../../packages/shared/src/index.ts';
import { type CpHandle } from '../../demo/seed-bootstrap.ts';
import { MODULE, MINER_STAKE_MIST, fundAndWait, measure, type CostRow } from './tx-cost-helpers.ts';

/**
 * The full CP-voted relay lifecycle with PER-STEP gasUsed capture. Mirrors
 * seed-bootstrap.ts voteAndApplyMiner but measures cast_role_vote /
 * apply_voted_role / register_relay individually (and reaches the relay's
 * MinerCap + StakePosition so its heartbeat/update_load/report_degradation are
 * measurable).
 *
 * Returns { kp, capId, minerId, stakeId } so the caller can measure relay
 * heartbeats AND (Dispatch-2) use this relay as a ballot member + proof target.
 */
export async function measureRelayLifecycle(
  client: SuiClient,
  cp: CpHandle,
  config: NetworkConfig,
  rows: CostRow[],
  logger: Logger,
): Promise<{ kp: Ed25519Keypair; capId: string; minerId: string; stakeId: string }> {
  const ROLE_RELAY = 2;

  // fund a fresh relay keypair
  const relayKp = Ed25519Keypair.generate();
  const relayAddr = relayKp.getPublicKey().toSuiAddress();
  await fundAndWait(client, relayAddr);
  const minerId = normalizeSuiAddress(relayAddr);

  // step 1: registration::register (0.3 SUI -> MinerCap) — executed, not measured this dispatch
  const regResult = await executeWithRetry(
    client,
    relayKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(MINER_STAKE_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin!,
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u16(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.vector('u8', [1, 2, 3, 4]),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.u64(0),
          tx.pure.vector('u8', [1, 2, 3, 4]),
        ],
      });
    },
    'register(relay)',
    logger,
  );
  if (regResult === null) throw new Error('measureRelayLifecycle: register failed');
  const minerCapId = extractCreatedObjectByType(regResult, '::caps::MinerCap');
  const stakeId = extractCreatedObjectByType(regResult, '::staking::StakePosition');
  if (minerCapId === null) throw new Error('measureRelayLifecycle: no MinerCap');
  if (stakeId === null) throw new Error('measureRelayLifecycle: no StakePosition');

  // step 2: role_voting::cast_role_vote (signed by CP) — MEASURED. Package split
  // (see services/contract/role-voting): role_voting lives in its own package.
  // Signature no longer takes a signaling_reg -- the standalone signaling node
  // type was removed from the contract.
  rows.push(
    await measure(
      client,
      cp.kp,
      'cast_role_vote',
      'role_voting',
      (tx) => {
        tx.moveCall({
          target: `${config.roleVotingPackageId}::role_voting::cast_role_vote`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roleVoteBoxId),
            tx.object(config.minerStoreId),
            tx.object(config.cpRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(cp.cpCapId),
            tx.pure.id(minerId),
            tx.pure.u8(ROLE_RELAY),
          ],
        });
      },
      logger,
    ),
  );

  // step 3: registration::apply_voted_role (signed by relay miner) — MEASURED.
  // apply_voted_role no longer takes the RoleVoteBox (or a signaling_reg) directly
  // -- consume the pending assignment via role_voting::consume_voted_assignment in
  // the SAME PTB and feed its u8 return into apply_voted_role's new_role param
  // (mirrors packages/shared/src/chain/role-assignment.ts applyVotedRole). The
  // measured gasUsed now covers both calls -- that IS the on-chain cost of
  // "applying a voted role" post-removal.
  rows.push(
    await measure(
      client,
      relayKp,
      'apply_voted_role',
      'registration',
      (tx) => {
        const [newRole] = tx.moveCall({
          target: `${config.roleVotingPackageId}::role_voting::consume_voted_assignment`,
          arguments: [
            tx.object(config.roleVoteBoxId),
            tx.object(minerCapId),
          ],
        });
        tx.moveCall({
          target: `${config.packageId}::registration::apply_voted_role`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.minerStoreId),
            newRole,
            tx.object(config.relayRegistryId),
            tx.object(config.validatorRegistryId),
            tx.object(config.cpRegistryId),
            tx.object(minerCapId),
            tx.object(stakeId),
          ],
        });
      },
      logger,
    ),
  );

  // step 4: relay_registry::register_relay (signed by relay miner) — MEASURED
  const REGION = Array.from(new TextEncoder().encode('local'));
  const endpoint = Array.from(new TextEncoder().encode('ws://relay-eval:4000'));
  rows.push(
    await measure(
      client,
      relayKp,
      'register_relay',
      'relay_registry',
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(minerCapId),
            tx.object(stakeId),
            tx.pure.vector('u8', REGION),
            tx.pure.vector('u8', endpoint),
          ],
        });
      },
      logger,
    ),
  );

  logger.info({ module: MODULE, action: 'relay_lifecycle_done', minerId }, 'relay registered + 3 steps measured');
  return { kp: relayKp, capId: minerCapId, minerId, stakeId };
}
