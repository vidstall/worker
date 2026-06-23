/**
 * Canary-slash E2E lifecycle helpers (Phase 4.1, REQ-CFA-006/007/008).
 *
 * On-chain setup primitives for the canary divergence-slash localnet E2E. Each helper
 * signs its TX with the RELEVANT keypair and asserts on-chain success (fail fast — a
 * silently failed setup TX would otherwise surface as a confusing assertion later).
 *
 * Adapted from cp-daemon/src/__tests__/integration/revote-localnet-helpers.ts (the F47
 * register→vote→apply pattern), extended for the canary-specific roles this E2E needs:
 *   - a RELAY miner that OWNS its StakePosition bond (approach (b): the bond owner signs
 *     its own slash — the W-E9 limitation on record);
 *   - VALIDATOR miners + their Wallet-B session-wallet bindings (so the on-chain
 *     `lookup_session_wallet` resolves each attestation's session pubkey → a distinct
 *     validator_miner_id, INV-C);
 *   - a registered USER who creates a room + an AdminCap-gated relay assignment.
 *
 * Key derivation: a miner's on-chain id == the funded keypair's Sui address, because
 * `registration::register` computes `miner_id = object::id_from_address(sender)`.
 *
 * Structured logging only (shared pino Logger). No console.log.
 *
 * LOCALNET-ONLY: imported solely by canary-slash-e2e.integration.test.ts, run via the
 * canary glob in vitest.integration.config.ts, never the hermetic unit suite.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { MinerRole, type NetworkConfig, type Logger } from '@dvconf/shared';
import { fundAddress } from './localnet-fixture.js';
import {
  createRoomWithRelay as createRoomWithRelayShared,
  signAndAssert,
  type TxStatusLike,
} from '@dvconf/shared';

// Re-export the shared lifecycle bound to this fixture's faucet so callers (canary-slash-e2e)
// keep the SAME 7-arg signature; the 8th injected fundAddress is supplied here.
export async function createRoomWithRelay(
  client: import('@mysten/sui/client').SuiClient,
  userKp: import('@mysten/sui/keypairs/ed25519').Ed25519Keypair,
  deployer: import('@mysten/sui/keypairs/ed25519').Ed25519Keypair,
  adminCapId: string,
  relayMinerId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<string> {
  return createRoomWithRelayShared(client, userKp, deployer, adminCapId, relayMinerId, config, logger, fundAddress);
}

const MODULE = 'canary-localnet-helpers';
const GAS_BUDGET = 100_000_000;

/** Stake tiers (MIST). CP > 0.5 base; relay miner in [0.25, 0.5); validator >= 0.1. */
export const CP_STAKE_MIST = 600_000_000n; // 0.6 SUI → determine_role = CP → ControlPlaneCap
export const RELAY_STAKE_MIST = 300_000_000n; // 0.3 SUI → role User at register → MinerCap (relay min 0.25)
export const VALIDATOR_STAKE_MIST = 300_000_000n; // 0.3 SUI → role User at register; validator min 0.1

// ── object-change shape (subset) ─────────────────────────────────────────────

interface SuiObjectChange {
  type: string;
  objectId?: string;
  objectType?: string;
}

/**
 * Sign + execute a TX EXPECTED to ABORT with `expectedCode` (a Move u64 error code).
 * Returns nothing on the expected abort; throws if the TX SUCCEEDS or aborts with a
 * different code. Used by the no-false-positive + wrong-bond attribution asserts —
 * `dryRunTransactionBlock` returns the MoveAbort with its sub-status code without
 * mutating chain state.
 */
export async function expectMoveAbort(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  expectedCode: number,
  label: string,
  logger: Logger,
): Promise<void> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(GAS_BUDGET);
  tx.setSenderIfNotSet(signer.getPublicKey().toSuiAddress());
  const built = await tx.build({ client });
  const dry = await client.dryRunTransactionBlock({ transactionBlock: built });
  const status = dry.effects.status;
  if (status.status === 'success') {
    throw new Error(`${label}: expected MoveAbort(${expectedCode}) but the TX SUCCEEDED`);
  }
  const errStr = status.error ?? '';
  // Sui surfaces the abort code as e.g. "MoveAbort(.., 686)".
  const m = errStr.match(/MoveAbort\([^)]*?,\s*(\d+)\)/) ?? errStr.match(/,\s*(\d+)\)\s*in command/);
  const actual = m && m[1] !== undefined ? Number(m[1]) : null;
  if (actual !== expectedCode) {
    throw new Error(`${label}: expected MoveAbort(${expectedCode}), got status="${errStr}"`);
  }
  logger.info(
    { module: MODULE, action: label, context: { expectedCode } },
    `${label} aborted with the expected code ${expectedCode}`,
  );
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
  await new Promise((r) => setTimeout(r, 1500));
  logger.info({ module: MODULE, action: 'fund_keypair', context: { address } }, 'funded fresh keypair');
  return kp;
}

interface RegisterResult {
  /** miner_id == the keypair address (object::id_from_address(sender)). */
  minerId: string;
  minerCapId: string | null;
  cpCapId: string | null;
  stakeId: string;
}

/**
 * Build & sign `registration::register` with a freshly split `stakeMist` coin. Parses the
 * created MinerCap / ControlPlaneCap + StakePosition. Arg order (registration.move:78).
 */
async function registerMiner(
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
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          coin,
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

  const stakeId = createdObjectByType(result, '::staking::StakePosition', 'registerMiner');
  let minerCapId: string | null = null;
  let cpCapId: string | null = null;
  try {
    cpCapId = createdObjectByType(result, '::caps::ControlPlaneCap', 'registerMiner');
  } catch {
    minerCapId = createdObjectByType(result, '::caps::MinerCap', 'registerMiner');
  }
  return { minerId: minerAddress, minerCapId, cpCapId, stakeId };
}

export interface CpResult {
  kp: Ed25519Keypair;
  minerId: string;
  cpCapId: string;
  stakeId: string;
}

/**
 * Stand up the network's first CP (drives role votes): register with 0.6 SUI (>= the
 * 0.5 base CP threshold → ControlPlaneCap), then enroll via register_cp.
 */
export async function bootstrapCp(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<CpResult> {
  const kp = await createFundedKeypair(logger);
  const reg = await registerMiner(client, kp, config, CP_STAKE_MIST, logger);
  if (reg.cpCapId === null) {
    throw new Error('bootstrapCp: expected a ControlPlaneCap from a 0.6 SUI register, got none');
  }
  await signAndAssert(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(reg.cpCapId!),
          tx.object(reg.stakeId),
        ],
      });
    },
    'register_cp',
    logger,
  );
  return { kp, minerId: reg.minerId, cpCapId: reg.cpCapId, stakeId: reg.stakeId };
}

/** CP-signed cast_role_vote(minerId, role). Arg order role_voting.move:197 (cp_reg first). */
async function castRoleVoteFromCp(
  client: SuiClient,
  cp: CpResult,
  minerId: string,
  role: number,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
  await signAndAssert(
    client,
    cp.kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::role_voting::cast_role_vote`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roleVoteBoxId),
          tx.object(config.minerStoreId),
          tx.object(config.cpRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(config.signalingRegistryId),
          tx.object(cp.cpCapId),
          tx.pure.id(minerId),
          tx.pure.u8(role),
        ],
      });
    },
    'cast_role_vote',
    logger,
  );
}

/** Miner-signed apply_voted_role. Arg order registration.move:141. */
async function applyVotedRoleAs(
  client: SuiClient,
  minerKp: Ed25519Keypair,
  minerCapId: string,
  stakeId: string,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
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
}

export interface RelayResult {
  /** miner_id (== the funded keypair address). */
  minerId: string;
  minerCapId: string;
  /** The relay's StakePosition object id — OWNED by `kp` (approach (b) bond). */
  stakeId: string;
  /** The relay's funded keypair — SIGNS its own slash (the W-E9 owner-signs limitation). */
  kp: Ed25519Keypair;
}

/**
 * Full relay lifecycle: register (User→MinerCap) → CP votes Relay → miner applies →
 * register_relay. The miner OWNS its StakePosition bond, which the slash entry takes as
 * `&mut` (so the slash tx MUST be signed by `kp`).
 */
export async function registerRelay(
  client: SuiClient,
  cp: CpResult,
  config: NetworkConfig,
  logger: Logger,
): Promise<RelayResult> {
  const minerKp = await createFundedKeypair(logger);
  const reg = await registerMiner(client, minerKp, config, RELAY_STAKE_MIST, logger);
  if (reg.minerCapId === null) {
    throw new Error('registerRelay: expected a MinerCap from a 0.3 SUI register, got none');
  }
  await castRoleVoteFromCp(client, cp, reg.minerId, MinerRole.Relay, config, logger);
  await applyVotedRoleAs(client, minerKp, reg.minerCapId, reg.stakeId, config, logger);
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::relay_registry::register_relay`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.relayRegistryId),
          tx.object(reg.minerCapId!),
          tx.object(reg.stakeId),
          tx.pure.vector('u8', [1, 2, 3, 4]), // region
          tx.pure.vector('u8', [1, 2, 3, 4]), // endpoint_url
        ],
      });
    },
    'register_relay',
    logger,
  );
  logger.info({ module: MODULE, action: 'register_relay', context: { minerId: reg.minerId } }, 'relay registered');
  return { minerId: reg.minerId, minerCapId: reg.minerCapId, stakeId: reg.stakeId, kp: minerKp };
}

export interface ValidatorResult {
  minerId: string;
  /** The validator's pre-registered Wallet-B SESSION keypair (signs canary attestations). */
  sessionKp: Ed25519Keypair;
}

/**
 * Full validator lifecycle + session-wallet binding:
 *   register (User→MinerCap) → CP votes Validator → miner applies (flips MinerCap to
 *   Validator; stake 0.3 >= validator min 0.1) → register_validator → self_assign_session_wallet
 *   binding a FRESH Wallet-B session keypair's Sui address.
 *
 * The bound session address is `sessionKp.getPublicKey().toSuiAddress()`, which equals
 * blake2b256(0x00 || pubkey) — EXACTLY what the slash entry recomputes from each
 * attestation pubkey to resolve the validator_miner_id (INV-C).
 */
export async function registerValidatorWithSession(
  client: SuiClient,
  cp: CpResult,
  config: NetworkConfig,
  logger: Logger,
): Promise<ValidatorResult> {
  const minerKp = await createFundedKeypair(logger);
  const reg = await registerMiner(client, minerKp, config, VALIDATOR_STAKE_MIST, logger);
  if (reg.minerCapId === null) {
    throw new Error('registerValidatorWithSession: expected a MinerCap, got none');
  }
  await castRoleVoteFromCp(client, cp, reg.minerId, MinerRole.Validator, config, logger);
  await applyVotedRoleAs(client, minerKp, reg.minerCapId, reg.stakeId, config, logger);

  // Enroll in the ValidatorRegistry (register_validator arg order validator_registry.move:91).
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::register_validator`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(reg.minerCapId!),
          tx.object(reg.stakeId),
        ],
      });
    },
    'register_validator',
    logger,
  );

  // Bind a FRESH Wallet-B session keypair via self_assign_session_wallet
  // (validator_registry.move:143). The bound address resolves to this miner_id on-chain.
  const sessionKp = Ed25519Keypair.generate();
  const sessionAddr = sessionKp.getPublicKey().toSuiAddress();
  await signAndAssert(
    client,
    minerKp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::self_assign_session_wallet`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.validatorRegistryId),
          tx.object(reg.minerCapId!),
          tx.pure.address(sessionAddr),
        ],
      });
    },
    'self_assign_session_wallet',
    logger,
  );
  logger.info(
    { module: MODULE, action: 'register_validator', context: { minerId: reg.minerId } },
    'validator registered + session-wallet bound',
  );
  return { minerId: reg.minerId, sessionKp };
}

/** Read the current bond value (MIST) of a StakePosition via staking::amount (devInspect). */
export async function readStakeAmount(
  client: SuiClient,
  reader: Ed25519Keypair,
  stakeId: string,
  config: NetworkConfig,
): Promise<bigint> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::staking::amount`,
    arguments: [tx.object(stakeId)],
  });
  const res = await client.devInspectTransactionBlock({
    sender: reader.getPublicKey().toSuiAddress(),
    transactionBlock: tx,
  });
  const ret = res.results?.[0]?.returnValues?.[0];
  if (!ret) {
    throw new Error(`readStakeAmount: no return value (status=${res.effects?.status?.status})`);
  }
  const bytes = Uint8Array.from(ret[0]);
  // u64 LE → bigint.
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v += BigInt(bytes[i]!) << (8n * BigInt(i));
  return v;
}
