/**
 * seed-bootstrap — actor setup: faucet funding, `registration::register`, and the
 * first-CP direct bootstrap (`control_plane_registry::register_cp`).
 *
 * Split out of ../seed-bootstrap.ts (pure code movement, no behavior change).
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { getFaucetHost, requestSuiFromFaucetV2 } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  executeWithRetry,
  extractCreatedObjectByType,
  type NetworkConfig,
  type Logger,
  type TxResult,
} from '../../../packages/shared/src/index.ts'; // relative SOURCE import, not the '@dvconf/shared' bare specifier: scripts/ sits OUTSIDE the pnpm workspace package graph, so the bare name is unresolvable from root node_modules (only apps/* carry the symlink). @mysten/sui above stays bare (it IS a root devDependency); shared's own transitive deps resolve from packages/shared/node_modules. Verified under tsx.

export const MODULE = 'seed-bootstrap';

/**
 * Stake tiers (MIST). CP gets 1.0 SUI (>= the dynamic CP threshold for the FIRST
 * CP = base 0.5 SUI; mirrors cp-daemon/auto-register.ts CP_STAKE). Each voted
 * miner gets 0.3 SUI: role User at register, then clears every apply-side
 * minimum_for_role guard — relay 0.25 / validator 0.1 SUI
 * (constants.move:28-30 DEFAULT_*_THRESHOLD).
 */
export const CP_STAKE_MIST = 1_000_000_000n;

/** Faucet gas-coin poll. The sui faucet is ASYNC ("up to 1 minute"), so poll getCoins
 *  rather than a fixed sleep (revote-localnet-helpers' 1.5s sleep only worked against a fast
 *  standalone faucet; the docker faucet races it -- see the Phase 5.4 gate). */
export const FAUCET_POLL_MS = 1000;
export const FAUCET_TIMEOUT_MS = 90_000;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** No hardcoded hosts — env with localhost defaults (HARD constraint #2). */
// Default to the SDK's canonical localnet faucet (what the proven Phase-4.1 fixture uses);
// docker overrides via FAUCET_URL env (sui-localnet:9123). getFaucetHost('localnet') ->
// http://127.0.0.1:9123/gas; requestSuiFromFaucetV2 uses only its origin (drops the path).
export const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');

/** A seeded node's persisted secret + on-chain handles (one entry per daemon). */
export interface SeededKey {
  secretKey: string;
  capId: string;
  stakeId: string;
  /**
   * The node's on-chain miner_id (= its main address). REQUIRED for gap #3: canary
   * live-seams `loadRelayBondKeys` reads `relay.minerId` for the W-E9 self-slash (it throws
   * without it), and provision-room assigns `relay.minerId` to the room. `read-seed-keys.sh`
   * ignores it (reads only secretKey+capId), so adding it is backward-safe.
   */
  minerId: string;
}

/**
 * Faucet-fund an address then settle for gas-coin indexing. FAUCET_URL is env-
 * driven; `requestSuiFromFaucetV2` builds `new URL('/v2/gas', host)`, so only the
 * host ORIGIN (scheme+host+port) of FAUCET_URL is used (any path suffix like
 * `/gas` is discarded by URL resolution) — the port is what matters.
 */
export async function fundAddress(client: SuiClient, address: string, logger: Logger): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  // The sui faucet is ASYNC; poll until the gas coin is indexed so the first register TX
  // has a coin to split from gas. A fixed sleep races the faucet (P5.4 gate finding).
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) break;
    if (Date.now() > deadline) {
      throw new Error(`faucet gas never indexed for ${address} within ${FAUCET_TIMEOUT_MS}ms`);
    }
    await sleep(FAUCET_POLL_MS);
  }
  logger.info({ module: MODULE, action: 'fund_address', context: { address } }, 'funded address via faucet (gas coin indexed)');
}

/** Generate a fresh keypair and faucet-fund it (replicates createFundedKeypair). */
export async function createFundedKeypair(client: SuiClient, logger: Logger): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  await fundAddress(client, kp.getPublicKey().toSuiAddress(), logger);
  return kp;
}

/**
 * Run a built TX through the shared executeWithRetry and FAIL LOUD on null
 * (retries exhausted). Returns the non-null TxResult so callers can mine objects.
 */
export async function execOrThrow(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<TxResult> {
  const result = await executeWithRetry(client, signer, build, label, logger);
  if (result === null) {
    throw new Error(`${label}: transaction failed after retries`);
  }
  return result;
}

export interface RegisterResult {
  /** miner_id == the keypair address (registration computes id_from_address(sender)). */
  minerId: string;
  minerCapId: string | null;
  cpCapId: string | null;
  stakeId: string;
}

/**
 * Build & sign `registration::register` with a freshly split `stakeMist` coin, then
 * extract the created cap + StakePosition. A stake >= the CP threshold yields a
 * ControlPlaneCap; otherwise a MinerCap.
 *
 * Arg order verified against:
 *   - registration.move:78-91 register(registry, store, coin, ip, port, stun_url,
 *     turn_url, region, bandwidth_mbps, max_concurrent, cpu_cores,
 *     turn_credential_hash) [ctx implicit]
 *   - revote-localnet-helpers.ts:149-165 registerMiner (identical order)
 */
export async function registerMiner(
  client: SuiClient,
  kp: Ed25519Keypair,
  config: NetworkConfig,
  stakeMist: bigint,
  logger: Logger,
): Promise<RegisterResult> {
  const minerId = normalizeSuiAddress(kp.getPublicKey().toSuiAddress());
  const result = await execOrThrow(
    client,
    kp,
    (tx) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeMist)]);
      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId), // registry: &NetworkRegistry
          tx.object(config.minerStoreId), // store: &mut MinerStore
          coin!, // coin: Coin<SUI>
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

  const stakeId = extractCreatedObjectByType(result, '::staking::StakePosition');
  if (!stakeId) {
    throw new Error('registerMiner: no StakePosition in objectChanges');
  }
  // CP stake yields a ControlPlaneCap; everyone else a MinerCap.
  const cpCapId = extractCreatedObjectByType(result, '::caps::ControlPlaneCap');
  const minerCapId = cpCapId ? null : extractCreatedObjectByType(result, '::caps::MinerCap');

  logger.info(
    { module: MODULE, action: 'register_miner', context: { minerId, hasCpCap: cpCapId !== null } },
    'registered miner',
  );
  return { minerId, minerCapId, cpCapId, stakeId };
}

export interface CpHandle {
  kp: Ed25519Keypair;
  minerId: string;
  cpCapId: string;
  stakeId: string;
}

/**
 * Stand up the first CP DIRECTLY (never voting — CPs are the voters): fund, register
 * with 1.0 SUI (>= first-CP threshold 0.5 SUI -> determine_role = CP -> yields a
 * ControlPlaneCap), then enroll via control_plane_registry::register_cp.
 *
 * register_cp arg order verified against:
 *   - control_plane_registry.move:82-87 register_cp(net_reg, registry, cap, stake) [ctx implicit]
 *   - revote-localnet-helpers.ts:232-238 bootstrapCp (identical order)
 */
export async function bootstrapCp(client: SuiClient, config: NetworkConfig, logger: Logger): Promise<CpHandle> {
  const kp = await createFundedKeypair(client, logger);
  const reg = await registerMiner(client, kp, config, CP_STAKE_MIST, logger);
  if (reg.cpCapId === null) {
    throw new Error('bootstrapCp: expected a ControlPlaneCap from a 1.0 SUI register, got none');
  }
  const cpCapId = reg.cpCapId;

  await execOrThrow(
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

  logger.info({ module: MODULE, action: 'bootstrap_cp', context: { minerId: reg.minerId, cpCapId } }, 'bootstrapped CP');
  return { kp, minerId: reg.minerId, cpCapId, stakeId: reg.stakeId };
}
