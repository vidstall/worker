/**
 * REQ-CMD-2 — Stage-1 live initial role-vote driver (consolidated demo).
 *
 * seed-bootstrap self-votes every seeded miner, so NO node is ever left at
 * role=0/User for the already-live cp-daemon RoleVoter to act on. This one-shot
 * registers ONE fresh funded keypair at a low (User) stake AFTER boot, then does
 * NOT vote — it leaves the on-chain `MinerRegistered{role=User}` event to feed the
 * live `startRoleVoting` loop (role-voter.ts:274, wired at cp index.ts:838 via the
 * event-handler.ts:701 MinerRegistered arm), and polls on-chain until that loop
 * has cast a role assignment. Proves the autonomous voter is live, not just wired.
 *
 * Run (matches seed-bootstrap's container working_dir /work/dvconf-daemons):
 *   pnpm exec tsx scripts/demo/register-lowstake-miner.ts
 *
 * Structured logging only (shared pino Logger). No console.log.
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  executeWithRetry,
  waitForRoleAssignment,
  type NetworkConfig,
  type Logger,
} from '../../packages/shared/src/index.ts';

const MODULE = 'register-lowstake-miner';

/**
 * 0.3 SUI — the seed's proven role=0/User tier (seed-bootstrap.ts:73
 * MINER_STAKE_MIST). With 1 CP already present the dynamic CP threshold is
 * 0.6 SUI (0.5 base + 0.1 step), so 0.3 SUI < threshold -> determine_role = User
 * (staking.move:55-64); register's `stake >= minimum_for_role(User)=0` assert
 * (registration.move:100-101) trivially passes.
 */
export const REGISTRANT_STAKE_MIST = 300_000_000n;

const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const FAUCET_POLL_MS = 1000;
const FAUCET_TIMEOUT_MS = 90_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Throws when the live voter never produced an assignment (undefined), else passes. */
export function assertRoleAssigned(role: number | undefined): asserts role is number {
  if (role === undefined || role === null) {
    throw new Error('register-lowstake-miner: no role assigned — the live cp-daemon RoleVoter did not cast');
  }
}

/** Faucet-fund + poll until the gas coin is indexed (verbatim shape of seed-bootstrap fundAddress). */
async function fundAddress(client: SuiClient, address: string, logger: Logger): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) break;
    if (Date.now() > deadline) {
      throw new Error(`faucet gas never indexed for ${address} within ${FAUCET_TIMEOUT_MS}ms`);
    }
    await sleep(FAUCET_POLL_MS);
  }
  logger.info({ module: MODULE, action: 'fund_address', context: { address } }, 'funded registrant via faucet');
}

/** registration::register with the seed's exact metadata (bandwidth=0,cpu=0 -> voter infers validator). */
async function registerUserMiner(client: SuiClient, kp: Ed25519Keypair, config: NetworkConfig, logger: Logger): Promise<string> {
  const minerId = kp.getPublicKey().toSuiAddress();
  const result = await executeWithRetry(
    client,
    kp,
    (tx: Transaction) => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(REGISTRANT_STAKE_MIST)]);
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
          tx.pure.u64(0), // bandwidth_mbps -> voter infers validator
          tx.pure.u64(0), // max_concurrent
          tx.pure.u64(0), // cpu_cores
          tx.pure.vector('u8', [1, 2, 3, 4]), // turn_credential_hash
        ],
      });
    },
    'register-lowstake-user',
    logger,
  );
  if (result === null) {
    throw new Error('register-lowstake-miner: register TX failed after retries');
  }
  logger.info({ module: MODULE, action: 'registered_user', context: { minerId } }, 'registered low-stake User miner');
  return minerId;
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  const kp = Ed25519Keypair.generate();
  await fundAddress(client, kp.getPublicKey().toSuiAddress(), logger);
  const minerId = await registerUserMiner(client, kp, config, logger);

  logger.info({ module: MODULE, action: 'await_vote', context: { minerId } }, 'awaiting live cp-daemon role assignment...');
  const role = await waitForRoleAssignment(client, config, minerId, logger);
  assertRoleAssigned(role);
  logger.info(
    { module: MODULE, action: 'done', context: { minerId, role } },
    `live RoleVoter assigned role=${role} to the low-stake registrant`,
  );
}

main().catch((err) => {
  process.stderr.write(`register-lowstake-miner: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
