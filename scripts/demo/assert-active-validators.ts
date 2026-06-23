/**
 * REQ-CMD-1 boot-readiness — assert BOTH validators are on-chain ROLE-ASSIGNED.
 * `docker compose up --wait` only proves containers are healthy, NOT that two distinct
 * validators registered. This reads validator_registry::active_count(&ValidatorRegistry)
 * via devInspect (validator_registry.move:253) and requires >= 2 before Stage 5 runs.
 * devInspect needs no gas/signature (mirrors readIsPaused, network-registry.ts:30-61).
 */
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
} from '../../packages/shared/src/index.ts';

const READ_ONLY_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface ActiveValidatorsResult { ok: boolean; count: number; reason?: string; }

/** Pure: >=2 distinct validators registered means the >=2-distinct canary quorum can form. */
export function assertActiveValidators(count: number): ActiveValidatorsResult {
  if (count < 2) return { ok: false, count, reason: `active_count ${count} < 2 (2nd validator not role-assigned)` };
  return { ok: true, count };
}

/** Read validator_registry::active_count via devInspect and assert >= 2. Exits non-zero on fail. */
async function main(): Promise<void> {
  const logger = createLogger('assert-active-validators');
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::validator_registry::active_count`,
    arguments: [tx.object(config.validatorRegistryId)],
  });
  const res = await client.devInspectTransactionBlock({ sender: READ_ONLY_SENDER, transactionBlock: tx });
  const returnValues = res.results?.[0]?.returnValues ?? [];
  const raw = returnValues[0]?.[0];
  if (!raw) {
    throw new Error('assert-active-validators: devInspect returned no value for active_count');
  }
  const count = Number(bcs.u64().parse(Uint8Array.from(raw)));
  const check = assertActiveValidators(count);
  logger.info({ module: 'assert-active-validators', action: 'check', context: { count, ok: check.ok } }, `validator active_count=${count}`);
  if (!check.ok) {
    process.stderr.write(`assert-active-validators: ${check.reason}\n`);
    process.exit(1);
  }
  process.stdout.write(`ACTIVE_VALIDATORS=${count}\n`);
}

// Run only when invoked directly (the pure assertActiveValidators is import-safe for tests).
if (process.argv[1]?.endsWith('assert-active-validators.ts')) {
  main().catch((err) => {
    process.stderr.write(`assert-active-validators: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
