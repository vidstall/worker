/**
 * Liveness-voting E2E lifecycle helpers ("i expect that job belong to validator" —
 * validator-driven liveness enforcement, see plans/now-i-want-to-dynamic-sundae.md).
 *
 * Adds exactly what canary-localnet-helpers.ts doesn't already expose: a validator
 * registration that returns the Wallet-A signing keypair + MinerCap id (needed to
 * SIGN `cast_liveness_vote`, unlike registerValidatorWithSession's session-wallet-only
 * shape, which is built for canary attestation signing instead), plus the
 * liveness_voting / execute_ejection call wrappers and an epoch-wait poll.
 *
 * Reuses bootstrapCp / registerRelay / readStakeAmount / CpResult from
 * canary-localnet-helpers.ts (same package — no cross-app rootDir issue).
 *
 * LOCALNET-ONLY: imported solely by liveness-ejection-e2e.integration.test.ts, run via
 * `pnpm test:integration`, never the hermetic unit suite.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { MinerRole, type NetworkConfig, type Logger } from '@dvconf/shared';
import { signAndAssert, type TxStatusLike } from '@dvconf/shared';
import { fundAddress } from './localnet-fixture.js';
import { type CpResult } from './canary-localnet-helpers.js';

const MODULE = 'liveness-localnet-helpers';

/** Same tier as canary-localnet-helpers' VALIDATOR_STAKE_MIST (>= validator min 0.1 SUI). */
export const VALIDATOR_STAKE_MIST = 300_000_000n;

interface SuiObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

function createdObjectByType(result: TxStatusLike, substring: string, label: string): string {
  for (const change of (result.objectChanges ?? []) as SuiObjectChange[]) {
    if (change.type === 'created' && typeof change.objectId === 'string' && (change.objectType ?? '').includes(substring)) {
      return change.objectId;
    }
  }
  throw new Error(`${label}: no created object matching ${substring}`);
}

export async function createFundedKeypair(logger: Logger): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  const address = kp.getPublicKey().toSuiAddress();
  await fundAddress(address);
  await new Promise((r) => setTimeout(r, 1500));
  logger.info({ module: MODULE, action: 'fund_keypair', context: { address } }, 'funded fresh keypair');
  return kp;
}

export interface FullValidatorResult {
  minerId: string;
  minerCapId: string;
  stakeId: string;
  /** Wallet-A signing keypair -- SIGNS cast_liveness_vote (a governance action, not a
   * session/economic one, so the daemon's MAIN wallet signs -- see liveness-sweep.ts doc). */
  kp: Ed25519Keypair;
}

/**
 * Full validator lifecycle, returning the Wallet-A keypair + MinerCap id (unlike
 * registerValidatorWithSession, which only returns the Wallet-B session keypair).
 * register (User→MinerCap) → CP votes Validator → miner applies → register_validator.
 */
export async function registerValidatorFull(
  client: SuiClient,
  cp: CpResult,
  config: NetworkConfig,
  logger: Logger,
): Promise<FullValidatorResult> {
  const minerKp = await createFundedKeypair(logger);
  const minerAddress = normalizeSuiAddress(minerKp.getPublicKey().toSuiAddress());

  const registerResult = await signAndAssert(
    client,
    minerKp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(VALIDATOR_STAKE_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin,
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
  const stakeId = createdObjectByType(registerResult, '::staking::StakePosition', 'registerValidatorFull');
  const minerCapId = createdObjectByType(registerResult, '::caps::MinerCap', 'registerValidatorFull');

  await signAndAssert(
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
          tx.object(config.signalingRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(minerAddress),
          tx.pure.u8(MinerRole.Validator),
        ],
      });
    },
    'cast_role_vote(validator)',
    logger,
  );

  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.signalingRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'apply_voted_role',
    logger,
  );

  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::register_validator`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(minerCapId),
          tx.object(stakeId),
        ],
      });
    },
    'register_validator',
    logger,
  );

  logger.info(
    { module: MODULE, action: 'register_validator_full', context: { minerId: minerAddress } },
    'validator registered (Wallet-A only, no session binding)',
  );
  return { minerId: minerAddress, minerCapId, stakeId, kp: minerKp };
}

/** Validator-signed cast_liveness_vote(targetMinerId). Arg order liveness_voting.move:135-146. */
export async function castLivenessVoteAs(
  client: SuiClient,
  validator: FullValidatorResult,
  targetMinerId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await signAndAssert(
    client,
    validator.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::liveness_voting::cast_liveness_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.livenessVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.validatorRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.signalingRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(validator.minerCapId),
          tx.pure.id(targetMinerId),
        ],
      });
    },
    'cast_liveness_vote',
    logger,
  );
}

/**
 * Submit `registration::execute_ejection` -- crank-style (anyone may sign; `signer` here
 * is just a convenient funded keypair, mirroring economic_layer::distribute_rewards).
 * Arg order registration.move:298-308.
 */
export async function executeEjectionAs(
  client: SuiClient,
  signer: Ed25519Keypair,
  targetStakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await signAndAssert(
    client,
    signer,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::execute_ejection`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.livenessVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.signalingRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(targetStakeId),
        ],
      });
    },
    'execute_ejection',
    logger,
  );
}

/** Read `liveness_voting::get_approved_ejection` (Option<u8>) via devInspect. */
export async function getApprovedEjection(
  client: SuiClient,
  reader: Ed25519Keypair,
  targetMinerId: string,
  config: NetworkConfig,
): Promise<number | null> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::liveness_voting::get_approved_ejection`,
    arguments: [tx.object(config.livenessVoteBoxId), tx.pure.id(targetMinerId)],
  });
  const res = await client.devInspectTransactionBlock({
    sender: reader.getPublicKey().toSuiAddress(),
    transactionBlock: tx,
  });
  const ret = res.results?.[0]?.returnValues?.[0];
  if (!ret) return null;
  const bytes = Uint8Array.from(ret[0]);
  // BCS Option<u8>: byte 0 = 0 (None) or 1 (Some), byte 1 = the value (if Some).
  if (bytes.length < 1 || bytes[0] === 0) return null;
  return bytes[1] ?? null;
}

/** Poll `getLatestSuiSystemState().epoch` until it reaches `target` (or time out). */
export async function waitForEpochAtLeast(
  client: SuiClient,
  target: bigint,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {},
  logger?: Logger,
): Promise<bigint> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const state = await client.getLatestSuiSystemState();
    const epoch = BigInt(state.epoch);
    if (epoch >= target) return epoch;
    if (Date.now() >= deadline) {
      throw new Error(`waitForEpochAtLeast: timed out waiting for epoch >= ${target} (last seen ${epoch})`);
    }
    logger?.debug({ module: MODULE, epoch: epoch.toString(), target: target.toString() }, 'waiting for epoch');
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
}
