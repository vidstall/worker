/**
 * Dispatch-2 actor bootstrap helpers — registering fresh miners, building
 * fully-ready validators (registered + voted + applied + enrolled + session
 * wallet bound), and registering a second relay for the pairing ballot.
 * Pure extraction from the original measure-onchain-cost.ts — no behavior
 * changes.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import {
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
  type TxResult,
} from '../../../packages/shared/src/index.ts';
import { type CpHandle } from '../../demo/seed-bootstrap.ts';
import {
  MODULE,
  MINER_STAKE_MIST,
  fundAndWait,
  makeRow,
  signAndCapture,
  measureCapture,
  type CostRow,
} from './tx-cost-helpers.ts';

// ══════════════════════════════════════════════════════════════════════════
// DISPATCH-2 — the hard ed25519 functions + full room lifecycle.
// ══════════════════════════════════════════════════════════════════════════

/** A validator that has registered, applied its role, enrolled, and bound a
 *  session wallet — i.e. is fully ready to submit_session_proof. */
export interface ReadyValidator {
  mainKp: Ed25519Keypair;   // wallet A = registered operator; signs the proof bytes
  sessionKp: Ed25519Keypair; // wallet B = self_assign_session_wallet-bound; TX sender
  minerId: string;
  capId: string;
  stakeId: string;
}

/**
 * A raw "register a fresh miner as a User" (registration::register) that RETURNS
 * the created cap + stake + the TxResult, so the FIRST call can be MEASURED as the
 * `registration::register` bonus row. Mirrors seed-bootstrap.registerMiner but
 * surfaces the result.
 */
export async function registerFreshMiner(
  client: SuiClient,
  kp: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<{ minerId: string; minerCapId: string; stakeId: string; result: TxResult }> {
  const result = await signAndCapture(
    client,
    kp,
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
    'register',
    logger,
  );
  const minerCapId = extractCreatedObjectByType(result, '::caps::MinerCap');
  const stakeId = extractCreatedObjectByType(result, '::staking::StakePosition');
  if (minerCapId === null) throw new Error('registerFreshMiner: no MinerCap');
  if (stakeId === null) throw new Error('registerFreshMiner: no StakePosition');
  return { minerId: normalizeSuiAddress(kp.getPublicKey().toSuiAddress()), minerCapId, stakeId, result };
}

/**
 * Register + vote + apply + enroll a validator, then bind a fresh session wallet.
 * `measureIdx`: when 0, MEASURE register / register_validator / self_assign_session_wallet
 * (the bonus rows). For subsequent validators these steps are executed but not measured.
 */
export async function buildReadyValidator(
  client: SuiClient,
  cp: CpHandle,
  config: NetworkConfig,
  measureIdx: number,
  rows: CostRow[],
  logger: Logger,
): Promise<ReadyValidator> {
  const ROLE_VALIDATOR = 1;
  const mainKp = Ed25519Keypair.generate();
  await fundAndWait(client, mainKp.getPublicKey().toSuiAddress());

  // registration::register — MEASURED on the first validator (bonus row).
  const reg = await registerFreshMiner(client, mainKp, config, logger);
  if (measureIdx === 0) {
    rows.push(makeRow('register', 'registration', reg.result));
  }

  // CP casts the role vote (already measured in the relay lifecycle; here executed
  // only). Package split: role_voting lives in its own package; no signaling_reg.
  await signAndCapture(
    client,
    cp.kp,
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
          tx.pure.id(reg.minerId),
          tx.pure.u8(ROLE_VALIDATOR),
        ],
      });
    },
    'cast_role_vote(validator)',
    logger,
  );

  // miner applies the voted role. Consume the pending assignment via
  // role_voting::consume_voted_assignment in the SAME PTB (apply_voted_role no
  // longer takes the RoleVoteBox or a signaling_reg directly).
  await signAndCapture(
    client,
    mainKp,
    (tx) => {
      const [newRole] = tx.moveCall({
        target: `${config.roleVotingPackageId}::role_voting::consume_voted_assignment`,
        arguments: [
          tx.object(config.roleVoteBoxId),
          tx.object(reg.minerCapId),
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
          tx.object(reg.minerCapId),
          tx.object(reg.stakeId),
        ],
      });
    },
    'apply_voted_role(validator)',
    logger,
  );

  // validator_registry::register_validator — MEASURED on the first validator (bonus row).
  const buildRegisterValidator = (tx: Transaction): void => {
    tx.moveCall({
      target: `${config.packageId}::validator_registry::register_validator`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(reg.minerCapId),
        tx.object(reg.stakeId),
      ],
    });
  };
  if (measureIdx === 0) {
    const { row } = await measureCapture(client, mainKp, 'register_validator', 'validator_registry', buildRegisterValidator, logger);
    rows.push(row);
  } else {
    await signAndCapture(client, mainKp, buildRegisterValidator, 'register_validator', logger);
  }

  // Bind a fresh session wallet (B). The operator (wallet A) authorises via its MinerCap.
  // blake2b256(0x00 || pubkey_B) == sessionKp address is what submit_session_proof checks.
  const sessionKp = Ed25519Keypair.generate();
  const sessionAddr = sessionKp.getPublicKey().toSuiAddress();
  // Fund the session wallet — it is the TX SENDER of submit_session_proof (needs gas).
  await fundAndWait(client, sessionAddr);

  const buildSelfAssign = (tx: Transaction): void => {
    tx.moveCall({
      target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.validatorRegistryId),
        tx.object(reg.minerCapId),
        tx.pure.address(sessionAddr),
      ],
    });
  };
  if (measureIdx === 0) {
    const { row } = await measureCapture(client, mainKp, 'self_assign_session_wallet', 'validator_registry', buildSelfAssign, logger);
    rows.push(row);
  } else {
    await signAndCapture(client, mainKp, buildSelfAssign, 'self_assign_session_wallet', logger);
  }

  logger.info({ module: MODULE, action: 'ready_validator', minerId: reg.minerId, sessionAddr }, 'validator ready (registered + session wallet bound)');
  return { mainKp, sessionKp, minerId: reg.minerId, capId: reg.minerCapId, stakeId: reg.stakeId };
}

/**
 * Register + vote + apply + enroll a SECOND relay (needed only to satisfy the
 * `relay_ids.length() >= min_relay(=2)` ballot check). Returns its minerId.
 * register_relay here is executed (already measured in the primary lifecycle).
 */
export async function buildSecondRelay(
  client: SuiClient,
  cp: CpHandle,
  config: NetworkConfig,
  logger: Logger,
): Promise<string> {
  const ROLE_RELAY = 2;
  const kp = Ed25519Keypair.generate();
  await fundAndWait(client, kp.getPublicKey().toSuiAddress());
  const reg = await registerFreshMiner(client, kp, config, logger);

  await signAndCapture(client, cp.kp, (tx) => {
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
        tx.pure.id(reg.minerId),
        tx.pure.u8(ROLE_RELAY),
      ],
    });
  }, 'cast_role_vote(relay2)', logger);

  await signAndCapture(client, kp, (tx) => {
    const [newRole] = tx.moveCall({
      target: `${config.roleVotingPackageId}::role_voting::consume_voted_assignment`,
      arguments: [
        tx.object(config.roleVoteBoxId),
        tx.object(reg.minerCapId),
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
        tx.object(reg.minerCapId),
        tx.object(reg.stakeId),
      ],
    });
  }, 'apply_voted_role(relay2)', logger);

  const REGION = Array.from(new TextEncoder().encode('local'));
  const endpoint = Array.from(new TextEncoder().encode('ws://relay-eval-2:4000'));
  await signAndCapture(client, kp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::relay_registry::register_relay`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.relayRegistryId),
        tx.object(reg.minerCapId),
        tx.object(reg.stakeId),
        tx.pure.vector('u8', REGION),
        tx.pure.vector('u8', endpoint),
      ],
    });
  }, 'register_relay(relay2)', logger);

  logger.info({ module: MODULE, action: 'second_relay_done', minerId: reg.minerId }, 'second relay registered (ballot filler)');
  return reg.minerId;
}
