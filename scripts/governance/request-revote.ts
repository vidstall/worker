/**
 * F47 Phase 2.3 (REQ-RV-011) — miner self-request re-vote CLI.
 *
 * Lets a miner OPERATOR voluntarily re-enter the role-vote pool ("career change")
 * by submitting a MinerCap-gated `mark_revote_eligible_miner_request` TX. The
 * MinerCap names the miner, and the Move entry additionally asserts
 * `ctx.sender() == profile.owner` (cap-forgery defense, role_voting.move:509), so
 * the SUBMITTING key must be the miner's registered operator key — holding a cap is
 * not enough.
 *
 * Placement (D-S70-1): the ROADMAP/DESIGN named `apps/miner/src/cli.ts`, but no
 * `apps/miner` package exists — miners run AS the relay / validator / signaling /
 * cp daemons, there is no unified miner binary. Per DS-PH3-1 (every F47 utility
 * script ships as tsx, not a new app) this lives beside the sibling governance
 * helpers (`scripts/governance/gen-governance-sig-fixture.ts`). The testable
 * {@link buildRequestRevoteTx} builder keeps the PTB shape under unit test even
 * though the I/O `main()` glue is not.
 *
 * Run:
 *   pnpm --dir dvconf-daemons exec tsx scripts/governance/request-revote.ts --miner-cap <objectId>
 * Env (same as the daemons): PACKAGE_ID, NETWORK_REGISTRY_ID, ROLE_VOTE_BOX_ID,
 *   MINER_STORE_ID, …, RPC_URL, SUI_PRIVATE_KEY.
 *
 * Implements REQ-RV-011 (miner self-request surface).
 */

import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  loadKeypair,
  executeWithRetry,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';

const MODULE = 'miner-request-revote';

/**
 * Add the `mark_revote_eligible_miner_request` moveCall to a PTB. Arg order mirrors
 * role_voting.move:491 exactly (net_reg, vote_box, miner_store, cap) — `ctx` is
 * implicit in a PTB.
 */
export function buildRequestRevoteTx(tx: Transaction, config: NetworkConfig, minerCapId: string): void {
  tx.moveCall({
    target: `${config.packageId}::role_voting::mark_revote_eligible_miner_request`,
    arguments: [
      tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
      tx.object(config.roleVoteBoxId), // vote_box: &mut RoleVoteBox
      tx.object(config.minerStoreId), // miner_store: &MinerStore
      tx.object(minerCapId), // cap: &MinerCap
    ],
  });
}

/** Sign + submit a miner self-request re-vote TX with the operator's own key. */
export async function submitRequestRevote(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  logger: Logger,
): Promise<void> {
  const traceId = randomUUID();
  await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => buildRequestRevoteTx(tx, config, minerCapId),
    'request-revote',
    logger,
  );
  logger.info(
    { trace_id: traceId, module: MODULE, action: 'request_revote_tx', context: { minerCapId } },
    'Miner request-revote TX confirmed on-chain',
  );
}

/** Parse `--miner-cap <objectId>` from an argv slice. Returns null when absent/empty. */
export function parseMinerCapFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--miner-cap') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) return next;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  const minerCapId = parseMinerCapFlag(process.argv.slice(2));
  if (!minerCapId) {
    process.stderr.write('request-revote: --miner-cap <objectId> is required\n');
    process.exit(2);
    return;
  }
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  // SUI_PRIVATE_KEY MUST be the miner's registered operator key: the Move entry
  // asserts ctx.sender() == profile.owner (role_voting.move:509), so a wrong key
  // aborts on-chain with E_INVALID_CAP_OWNER even with a valid cap. See docstring.
  const signer = loadKeypair('SUI_PRIVATE_KEY');
  await submitRequestRevote(client, signer, config, minerCapId, logger);
  process.stdout.write(`${JSON.stringify({ ok: true, minerCapId })}\n`);
}

// Only run when executed directly (`tsx request-revote.ts …`); stays inert on import
// so the unit test can exercise the builder without firing the CLI.
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`request-revote: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
