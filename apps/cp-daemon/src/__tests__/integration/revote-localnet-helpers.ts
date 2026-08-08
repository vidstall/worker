/**
 * Relay-lifecycle helpers for the F47 Phase 4.1 revote-watcher localnet
 * integration test (REQ-RV-013). Kept OUT of localnet-fixture.ts so the Phase
 * 4.0 boot path stays byte-for-byte untouched; reused by Phase 4.3.
 *
 * Every helper signs its TX with the RELEVANT keypair (miner-signed registers &
 * applies; CP-signed votes) and awaits
 * `client.waitForTransaction({ digest, options: { showEffects, showObjectChanges } })`
 * then asserts `effects.status.status === 'success'` (fail fast — a silently
 * failed setup TX would otherwise surface as a confusing assertion later).
 *
 * Key derivation: a miner's on-chain id equals the funded keypair's Sui address,
 * because `registration::register` computes `miner_id = object::id_from_address(sender)`
 * — i.e. it reinterprets the 32-byte sender address as an ID. So we pass
 * `tx.pure.id(minerAddress)` wherever a `miner_id: ID` is needed and cross-check
 * the `MinerRegistered` event's `miner_id` against the address.
 *
 * Structured logging only (shared pino Logger). No console.log.
 *
 * LOCALNET-ONLY: imported solely by the *.integration.test.ts in this dir, which
 * runs via `pnpm test:integration` (vitest.integration.config.ts), never the
 * hermetic unit suite.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { MinerRole, type NetworkConfig, type Logger } from '@dvconf/shared';
import { fundAddress } from './localnet-fixture.js';

const MODULE = 'revote-localnet-helpers';

const GAS_BUDGET = 100_000_000;

/** Stake tiers (MIST). CP > DEFAULT_CP_THRESHOLD (0.5); relay miner in [0.25, 0.5). */
export const CP_STAKE_MIST = 600_000_000n; // 0.6 SUI → determine_role = CP → ControlPlaneCap
export const RELAY_STAKE_MIST = 300_000_000n; // 0.3 SUI → role User at register → MinerCap

// ── object-change shape (subset) ─────────────────────────────────────────────

interface SuiObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

export interface TxStatusLike {
  effects?: { status?: { status?: string; error?: string } };
  objectChanges?: SuiObjectChange[];
  events?: Array<{ type?: string; parsedJson?: unknown }>;
  digest: string;
}

/**
 * Sign + execute a built TX with the given keypair, wait for finality with
 * effects + object changes, and assert success. Returns the full result so
 * callers can mine object ids / events out of it.
 */
async function signAndAssert(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<TxStatusLike> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(GAS_BUDGET);
  const result = (await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  })) as unknown as TxStatusLike;
  await client.waitForTransaction({
    digest: result.digest,
    options: { showEffects: true, showObjectChanges: true },
  });
  const status = result.effects?.status?.status;
  if (status !== 'success') {
    const err = result.effects?.status?.error ?? '(no error string)';
    throw new Error(`${label} failed on-chain: status=${status ?? 'unknown'} error=${err}`);
  }
  logger.info(
    { module: MODULE, action: label, context: { digest: result.digest } },
    `${label} succeeded on-chain`,
  );
  return result;
}

/** Pick a created object id whose type contains `substring`, or throw. */
function createdObjectByType(result: TxStatusLike, substring: string, label: string): string {
  for (const change of result.objectChanges ?? []) {
    if (
      change.type === 'created' &&
      typeof change.objectId === 'string' &&
      (change.objectType ?? '').includes(substring)
    ) {
      return change.objectId;
    }
  }
  throw new Error(`${label}: no created object matching ${substring}`);
}

/** Generate a fresh keypair and faucet-fund it. */
export async function createFundedKeypair(logger: Logger): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  const address = kp.getPublicKey().toSuiAddress();
  await fundAddress(address);
  // Small settle so the gas coin is queryable before the first TX.
  await new Promise((r) => setTimeout(r, 1500));
  logger.info({ module: MODULE, action: 'fund_keypair', context: { address } }, 'funded fresh keypair');
  return kp;
}

interface RegisterResult {
  /** miner_id == the keypair address (object::id_from_address(sender)). */
  minerId: string;
  /** caps::MinerCap object id (only for User/Relay/Validator/Signaling roles). */
  minerCapId: string | null;
  /** caps::ControlPlaneCap object id (only when stake ≥ CP threshold). */
  cpCapId: string | null;
  /** staking::StakePosition object id. */
  stakeId: string;
}

/**
 * Build & sign `registration::register` with a freshly split `stakeMist` coin.
 * Parses the created MinerCap / ControlPlaneCap + StakePosition, and asserts the
 * MinerRegistered event's miner_id equals the funded address (the id == address
 * derivation cross-check).
 *
 * Arg order (registration.move:78): registry, store, coin, ip, port, stun_url,
 * turn_url, region, bandwidth_mbps, max_concurrent, cpu_cores, turn_credential_hash.
 */
export async function registerMiner(
  client: SuiClient,
  kp: Ed25519Keypair,
  config: NetworkConfig,
  stakeMist: bigint,
  logger: Logger,
): Promise<RegisterResult> {
  const minerAddress = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());
  const result = await signAndAssert(
    client,
    kp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeMist)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId), // registry: &NetworkRegistry
          tx.object(config.minerStoreId), // store: &mut MinerStore
          coin, // coin: Coin<SUI>
          tx.pure.vector('u8', [1, 2, 3, 4]), // ip
          tx.pure.u16(0), // port
          tx.pure.vector('u8', [1, 2, 3, 4]), // stun_url
          tx.pure.vector('u8', [1, 2, 3, 4]), // turn_url
          tx.pure.vector('u8', [1, 2, 3, 4]), // region
          tx.pure.u64(0), // bandwidth_mbps
          tx.pure.u64(0), // max_concurrent
          tx.pure.u64(0), // cpu_cores
          tx.pure.vector('u8', [1, 2, 3, 4]), // turn_credential_hash
        ],
      });
    },
    'register',
    logger,
  );

  // Cross-check: MinerRegistered.miner_id == the funded address.
  const evt = (result.events ?? []).find((e) => (e.type ?? '').includes('::registration::MinerRegistered'));
  const evtMinerId =
    evt && typeof (evt.parsedJson as { miner_id?: unknown })?.miner_id === 'string'
      ? normalizeSuiAddress((evt.parsedJson as { miner_id: string }).miner_id)
      : null;
  if (evtMinerId === null) {
    throw new Error('registerMiner: MinerRegistered event missing or malformed');
  }
  if (evtMinerId !== minerAddress) {
    throw new Error(`registerMiner: miner_id ${evtMinerId} != funded address ${minerAddress}`);
  }

  const stakeId = createdObjectByType(result, '::staking::StakePosition', 'registerMiner');
  let minerCapId: string | null = null;
  let cpCapId: string | null = null;
  try {
    cpCapId = createdObjectByType(result, '::caps::ControlPlaneCap', 'registerMiner');
  } catch {
    minerCapId = createdObjectByType(result, '::caps::MinerCap', 'registerMiner');
  }

  logger.info(
    { module: MODULE, action: 'register_miner', context: { minerId: minerAddress, hasCpCap: cpCapId !== null } },
    'registered miner',
  );
  return { minerId: minerAddress, minerCapId, cpCapId, stakeId };
}

export interface BootstrapCpResult {
  kp: Ed25519Keypair;
  minerId: string;
  cpCapId: string;
  stakeId: string;
}

/**
 * Stand up the network's first CP: fund a keypair, register with 0.6 SUI (>
 * DEFAULT_CP_THRESHOLD 0.5 → determine_role = CP → yields a ControlPlaneCap),
 * then enroll via `control_plane_registry::register_cp`.
 *
 * register_cp arg order (control_plane_registry.move:82): net_reg, registry,
 * cap, stake.
 */
export async function bootstrapCp(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
  stakeMist: bigint = CP_STAKE_MIST, // default 0.6 SUI keeps existing 1-CP callers unchanged; B2 passes higher for 5-CP setup
): Promise<BootstrapCpResult> {
  const kp = await createFundedKeypair(logger);
  const reg = await registerMiner(client, kp, config, stakeMist, logger);
  if (reg.cpCapId === null) {
    throw new Error(`bootstrapCp: expected a ControlPlaneCap from a ${stakeMist} MIST register, got none`);
  }
  const cpCapId = reg.cpCapId;

  await signAndAssert(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
          tx.object(config.cpRegistryId), // registry: &mut ControlPlaneRegistry
          tx.object(cpCapId), // cap: &ControlPlaneCap
          tx.object(reg.stakeId), // stake: &StakePosition
        ],
      });
    },
    'register_cp',
    logger,
  );

  logger.info(
    { module: MODULE, action: 'bootstrap_cp', context: { minerId: reg.minerId } },
    'bootstrapped CP node',
  );
  return { kp, minerId: reg.minerId, cpCapId, stakeId: reg.stakeId };
}

export interface RelayResult {
  minerId: string;
  minerCapId: string;
  stakeId: string;
  /** The miner's funded keypair — needed to sign a follow-up re-vote apply (Phase 4.3). */
  kp: Ed25519Keypair;
}

/**
 * CP-signed `role_voting::cast_role_vote` for `minerId` into `role`. Returns the TX
 * result so callers can read the RoleVoteCast / RoleAssigned events. With one
 * bootstrapped CP this meets the floored quorum (= 1) and writes
 * assigned_roles[minerId] = role. INITIAL vote: current_role is User so the
 * re-vote-eligibility guard is skipped. RE-vote: the miner MUST already be in the
 * revote_eligible pool (i.e. a watcher mark landed) or the cast aborts.
 *
 * Arg order (role_voting.move:197): net_reg, vote_box, miner_store, cp_reg,
 * relay_reg, validator_reg, signaling_reg, cap, miner_id, role. NOTE: cp_reg comes
 * BEFORE relay/validator/signaling — DIFFERS from the mark_* entries.
 */
export async function castRoleVoteFromCp(
  client: SuiClient,
  cp: BootstrapCpResult,
  minerId: string,
  role: number,
  config: NetworkConfig,
  logger: Logger,
): Promise<TxStatusLike> {
  return signAndAssert(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.roleVotingPackageId}::role_voting::cast_role_vote`,
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
 * flips MinerCap + profile + stake to the voted role, and on a genuine change
 * (old_role != new_role) cleans up the miner's stale OLD-role registry entry and
 * emits RoleTransitioned. The apply-side stake guard requires
 * `amount(stake) >= minimum_for_role(new_role)`. Returns the TX result so callers
 * can read RoleTransitioned / RoleApplied.
 *
 * Arg order (registration.move:141): registry, store, vote_box, relay_reg,
 * validator_reg, cp_reg, cap, stake.
 */
export async function applyVotedRoleAs(
  client: SuiClient,
  minerKp: Ed25519Keypair,
  minerCapId: string,
  stakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<TxStatusLike> {
  return signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::registration::apply_voted_role`,
        arguments: [
          tx.object(config.networkRegistryId), // registry: &NetworkRegistry
          tx.object(config.minerStoreId), // store: &mut MinerStore
          tx.object(config.roleVoteBoxId), // vote_box: &mut RoleVoteBox
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
 * Full relay lifecycle for one miner against an already-bootstrapped CP:
 *   1. register the miner with 0.3 SUI (role User at register → MinerCap).
 *   2. CP signs cast_role_vote(miner_id, Relay) — current_role is User so the
 *      re-vote-eligibility guard is skipped; 1 CP meets the floored threshold (=1)
 *      → writes assigned_roles[miner_id] = Relay.
 *   3. miner signs apply_voted_role — consumes the assignment, flips
 *      MinerCap+profile+stake to Relay (stake 0.3 ≥ relay min 0.25; binding
 *      stake.miner_id == miner_id).
 *   4. miner signs register_relay → RelayRegistry entry with last_heartbeat = epoch.
 */
export async function voteAndApplyRelay(
  client: SuiClient,
  cp: BootstrapCpResult,
  config: NetworkConfig,
  logger: Logger,
): Promise<RelayResult> {
  // 1. register as a User-role miner.
  const minerKp = await createFundedKeypair(logger);
  const reg = await registerMiner(client, minerKp, config, RELAY_STAKE_MIST, logger);
  if (reg.minerCapId === null) {
    throw new Error('voteAndApplyRelay: expected a MinerCap from a 0.3 SUI register, got none');
  }
  const minerCapId = reg.minerCapId;
  const minerId = reg.minerId;

  // 2. CP casts the relay vote (current_role User → eligibility guard skipped; 1 CP
  //    meets the floored threshold = 1 → writes assigned_roles[miner_id] = Relay).
  await castRoleVoteFromCp(client, cp, minerId, MinerRole.Relay, config, logger);

  // 3. miner applies the voted role (stake 0.3 ≥ relay min 0.25; binding miner_id).
  await applyVotedRoleAs(client, minerKp, minerCapId, reg.stakeId, config, logger);

  // 4. miner enters the RelayRegistry.
  // register_relay arg order (relay_registry.move:105): net_reg, registry, cap,
  // stake, region, endpoint_url.
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::relay_registry::register_relay`,
        arguments: [
          tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
          tx.object(config.relayRegistryId), // registry: &mut RelayRegistry
          tx.object(minerCapId), // cap: &MinerCap
          tx.object(reg.stakeId), // stake: &StakePosition
          tx.pure.vector('u8', [1, 2, 3, 4]), // region
          tx.pure.vector('u8', [1, 2, 3, 4]), // endpoint_url
        ],
      });
    },
    'register_relay',
    logger,
  );

  logger.info(
    { module: MODULE, action: 'vote_and_apply_relay', context: { minerId } },
    'miner is now a registered relay',
  );
  return { minerId, minerCapId, stakeId: reg.stakeId, kp: minerKp };
}

/**
 * Poll `getLatestSuiSystemState().epoch` (~1s cadence) until it reaches `target`,
 * or throw after `timeoutMs`. Returns the epoch actually reached.
 */
export async function waitForEpochAtLeast(
  client: SuiClient,
  target: bigint,
  opts: { timeoutMs: number },
  logger: Logger,
): Promise<bigint> {
  const deadline = Date.now() + opts.timeoutMs;
  let current = BigInt((await client.getLatestSuiSystemState()).epoch);
  while (current < target) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForEpochAtLeast: epoch ${current} < target ${target} after ${opts.timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 1000));
    current = BigInt((await client.getLatestSuiSystemState()).epoch);
  }
  logger.info(
    { module: MODULE, action: 'wait_epoch', context: { target: target.toString(), reached: current.toString() } },
    'reached target epoch',
  );
  return current;
}
