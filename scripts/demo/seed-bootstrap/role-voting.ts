/**
 * seed-bootstrap — role-voting lifecycle: CP-signed `cast_role_vote`, miner-signed
 * `apply_voted_role`, and role-specific registry enrollment (relay / validator /
 * relay-standby / validator-2).
 *
 * Split out of ../seed-bootstrap.ts (pure code movement, no behavior change).
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiClient } from '@mysten/sui/client';
import { MinerRole, type NetworkConfig, type Logger } from '../../../packages/shared/src/index.ts'; // relative SOURCE import (scripts/ sits OUTSIDE the pnpm workspace graph); mirrors ./actor-setup.ts.
import { MODULE, execOrThrow, createFundedKeypair, registerMiner, type CpHandle, type SeededKey } from './actor-setup.js';

/**
 * Miner stake tier (MIST). 0.3 SUI: role User at register, then clears every
 * apply-side minimum_for_role guard — relay 0.25 / validator 0.1 SUI
 * (constants.move:28-30 DEFAULT_*_THRESHOLD).
 */
export const MINER_STAKE_MIST = 300_000_000n;

export type DaemonRole = 'cp' | 'relay' | 'relay-standby' | 'validator' | 'validator-2';

/**
 * CP-signed `role_voting::cast_role_vote` for `minerId` into `role`. One bootstrapped
 * CP meets the floored quorum (= 1); current_role is User so the re-vote-eligibility
 * guard is skipped on this INITIAL vote -> writes assigned_roles[minerId] = role.
 *
 * Arg order verified against:
 *   - role_voting.move:145-156 cast_role_vote(net_reg, vote_box, miner_store, cp_reg,
 *     _relay_reg, _validator_reg, cap, miner_id, role) [ctx implicit] -- relay/validator
 *     regs are ABI-preserved but unread (the standalone signaling node type's registry
 *     param was dropped entirely, not just left vestigial).
 *   - revote-localnet-helpers.ts castRoleVoteFromCp (identical order)
 *   NOTE: cp_reg comes BEFORE relay/validator regs (DIFFERS from mark_*).
 */
async function castRoleVoteFromCp(
  client: SuiClient,
  cp: CpHandle,
  minerId: string,
  role: number,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await execOrThrow(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
          tx.object(config.roleVoteBoxId), // vote_box: &mut RoleVoteBox
          tx.object(config.minerStoreId), // miner_store: &MinerStore
          tx.object(config.cpRegistryId), // cp_reg: &ControlPlaneRegistry
          tx.object(config.relayRegistryId), // relay_reg: &RelayRegistry
          tx.object(config.validatorRegistryId), // validator_reg: &ValidatorRegistry
          tx.object(cp.cpCapId), // cap: &ControlPlaneCap
          tx.pure.id(minerId), // miner_id: ID
          tx.pure.u8(role), // role: u8
        ],
      });
    },
    'cast_role_vote',
    logger,
  );
}

/**
 * Miner-signed `registration::apply_voted_role` — consumes the pending assignment,
 * flips MinerCap + profile + stake to the voted role. Stake guard requires
 * amount(stake) >= minimum_for_role(new_role) — our 0.3 SUI clears all three.
 *
 * Package split (see services/contract/role-voting): role_voting's
 * consume_assignment is public(package) inside dvconf_role_voting and can no
 * longer be called inline from registration::apply_voted_role (a different
 * package). Chain two moveCalls in the same PTB instead -- still one atomic Sui
 * transaction, same all-or-nothing guarantee as the single call this replaces.
 *
 * Arg order verified against:
 *   - role_voting.move consume_voted_assignment(vote_box, cap): u8
 *   - registration.move apply_voted_role(registry, store, new_role, relay_reg,
 *     validator_reg, cp_reg, cap, stake) [ctx implicit] -- new_role comes from
 *     consume_voted_assignment's return, not a vote_box object (signaling_reg
 *     dropped with the standalone signaling node type's removal)
 *   - packages/shared/src/chain/role-assignment.ts applyVotedRole (identical order)
 */
async function applyVotedRoleAs(
  client: SuiClient,
  minerKp: Ed25519Keypair,
  minerCapId: string,
  stakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await execOrThrow(
    client,
    minerKp,
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
          tx.object(config.networkRegistryId), // registry: &NetworkRegistry
          tx.object(config.minerStoreId), // store: &mut MinerStore
          newRole, // new_role: u8 (was: vote_box)
          tx.object(config.relayRegistryId), // relay_reg: &mut RelayRegistry
          tx.object(config.validatorRegistryId), // validator_reg: &mut ValidatorRegistry
          tx.object(config.cpRegistryId), // cp_reg: &mut ControlPlaneRegistry
          tx.object(minerCapId), // cap: &mut MinerCap
          tx.object(stakeId), // stake: &mut StakePosition
        ],
      });
    },
    'apply_voted_role',
    logger,
  );
}

/**
 * Role-specific registry enrollment, signed by the miner keypair. Arg orders
 * verified against the .move source AND the daemon auto-register.ts callers:
 *   - relay     relay_registry.move:105-112  register_relay(net_reg, registry, cap,
 *               stake, region, endpoint_url)  == relay/auto-register.ts:232-239
 *   - validator validator_registry.move:91-96 register_validator(net_reg, registry,
 *               cap, stake)                    == validator-daemon/auto-register.ts:138-143
 */
async function enrollInRegistry(
  client: SuiClient,
  minerKp: Ed25519Keypair,
  role: DaemonRole,
  minerCapId: string,
  stakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  const REGION = Array.from(new TextEncoder().encode('local'));
  if (role === 'relay') {
    const endpoint = Array.from(new TextEncoder().encode('ws://relay-daemon:4000'));
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.relayRegistryId), // registry: &mut RelayRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
            tx.pure.vector('u8', REGION), // region: vector<u8>
            tx.pure.vector('u8', endpoint), // endpoint_url: vector<u8>
          ],
        });
      },
      'register_relay',
      logger,
    );
  } else if (role === 'validator' || role === 'validator-2') {
    // validator-2 IS a validator on-chain — same registry enrollment (register_validator).
    // The 2nd validator gives the on-chain VecSet two DISTINCT miner_ids so the
    // >=2-distinct canary attestation quorum can form on one host (spec §0.2 co-homing).
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::validator_registry::register_validator`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.validatorRegistryId), // registry: &mut ValidatorRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
          ],
        });
      },
      'register_validator',
      logger,
    );
  } else if (role === 'relay-standby') {
    // relay-standby IS a relay on-chain — votes as Relay, enrolls via relay_registry::register_relay.
    // Uses a DISTINCT endpoint (ws://relay-standby:4002, matching the compose service + WS_PORT 4002)
    // so it is a separate relay_registry entry from the primary relay (ws://relay-daemon:4000).
    const endpoint = Array.from(new TextEncoder().encode('ws://relay-standby:4002'));
    await execOrThrow(
      client,
      minerKp,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::relay_registry::register_relay`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.relayRegistryId), // registry: &mut RelayRegistry
            tx.object(minerCapId), // cap: &MinerCap
            tx.object(stakeId), // stake: &StakePosition
            tx.pure.vector('u8', REGION), // region: vector<u8>
            tx.pure.vector('u8', endpoint), // endpoint_url: vector<u8>
          ],
        });
      },
      'register_relay',
      logger,
    );
  } else {
    throw new Error(`enrollInRegistry: unsupported voted role ${role}`);
  }
}

/** On-chain role code per daemon role (constants.move:14-17; mirrors @dvconf/shared MinerRole). */
function roleCodeFor(role: DaemonRole): number {
  switch (role) {
    case 'relay':
    case 'relay-standby': // standby IS a relay on-chain — same role code (2)
      return MinerRole.Relay; // 2
    case 'validator':
    case 'validator-2': // validator-2 IS a validator on-chain — same role code as validator
      return MinerRole.Validator; // 1
    default:
      throw new Error(`roleCodeFor: ${role} is not a CP-voted role`);
  }
}

/**
 * Full CP-voted lifecycle for ONE miner against the bootstrapped CP, generalised by
 * `role` (called for relay, relay-standby, validator, validator-2):
 *   1. register the miner with 0.3 SUI (role User -> MinerCap)
 *   2. CP casts cast_role_vote(miner_id, roleCode) -> assigned_roles[miner_id] = role
 *   3. miner applies apply_voted_role -> flips MinerCap+profile+stake to the role
 *   4. miner enrolls in the role-specific registry
 */
export async function voteAndApplyMiner(
  client: SuiClient,
  cp: CpHandle,
  role: DaemonRole,
  config: NetworkConfig,
  logger: Logger,
): Promise<SeededKey> {
  const minerKp = await createFundedKeypair(client, logger);
  const reg = await registerMiner(client, minerKp, config, MINER_STAKE_MIST, logger);
  if (reg.minerCapId === null) {
    throw new Error(`voteAndApplyMiner(${role}): expected a MinerCap from a 0.3 SUI register, got none`);
  }
  const minerCapId = reg.minerCapId;

  await castRoleVoteFromCp(client, cp, reg.minerId, roleCodeFor(role), config, logger);
  await applyVotedRoleAs(client, minerKp, minerCapId, reg.stakeId, config, logger);
  await enrollInRegistry(client, minerKp, role, minerCapId, reg.stakeId, config, logger);

  logger.info(
    { module: MODULE, action: 'seed_role', context: { role, minerId: reg.minerId, capId: minerCapId } },
    `seeded ${role} node (registered + enrolled)`,
  );
  return { secretKey: minerKp.getSecretKey(), capId: minerCapId, stakeId: reg.stakeId, minerId: reg.minerId };
}

/** Assemble the keys-file record (pure — unit-testable). One slot per seeded daemon role. */
export function buildKeysRecord(seeded: Record<DaemonRole, SeededKey>): Record<DaemonRole, SeededKey> {
  return seeded;
}
