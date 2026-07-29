/**
 * Thin TX wrapper with exponential backoff retry.
 *
 * Pattern: build Transaction -> sign -> execute -> wait for finality -> retry on failure.
 * Backoff: 1s base, 2x multiplier, 30s ceiling, 5 max retries.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Histogram, Counter } from 'prom-client';
import type { TxResult } from '../types/chain.js';
import type { Logger } from 'pino';
import type { Registry } from '../metrics-prom.js';
import { createDurationHistogram, createCounter } from '../metrics-prom.js';

const BASE_DELAY_MS = 1_000;
const MULTIPLIER = 2;
const MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 5;

// Module-level, opt-in metrics state -- `executeWithRetry` is called from
// ~20 sites across every chain-facing daemon (auto-register, heartbeat,
// role-voter, cap-token issuance, room lifecycle, ...), each with its own
// per-service `prom-client` Registry created in that daemon's own
// index.ts. Threading a registry through every call site would be a huge,
// invasive diff; instead each daemon calls `registerTxMetrics()` ONCE at
// startup (right after creating its registry) and every `executeWithRetry`
// call in that process automatically gets instrumented for free, using its
// existing `label` argument as the `method` metric label -- no call-site
// changes needed. Uninitialized (no daemon called `registerTxMetrics`) is
// a safe, cheap no-op, e.g. for `bot`, which never calls this function.
let txMetrics: { histogram: Histogram<string>; retries: Counter<string>; service: string } | null = null;

/**
 * Wire `dvconf_chain_tx_duration_seconds{service,method}` and
 * `dvconf_chain_tx_retries_total{service,method}` into `registry` --
 * called once per daemon process, not per transaction.
 */
export function registerTxMetrics(registry: Registry, service: string): void {
  txMetrics = {
    service,
    histogram: createDurationHistogram(
      registry,
      'dvconf_chain_tx_duration_seconds',
      'Wall-clock duration of executeWithRetry, from first attempt to final success/failure',
      ['service', 'method'],
    ),
    retries: createCounter(
      registry,
      'dvconf_chain_tx_retries_total',
      'Retry attempts consumed by executeWithRetry beyond the first (success or exhaustion)',
      ['service', 'method'],
    ),
  };
}

/**
 * A Move abort is a DETERMINISTIC on-chain rejection (an `assert!` failed against
 * current on-chain state) -- rebuilding and resubmitting the exact same
 * transaction will fail with the exact same abort code every time within the
 * retry window (on-chain state affecting the assert doesn't change in the
 * seconds between retries), so retrying it is pure wasted gas-estimation calls
 * and backoff delay. Fail fast on the first attempt instead of burning all
 * MAX_RETRIES; a caller that wants to try again after on-chain state actually
 * changes (e.g. a periodic sweep tick) will naturally re-invoke this on its own
 * next cycle.
 */
function isMoveAbort(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('MoveAbort');
}

/**
 * Execute a Sui transaction with automatic retry and exponential backoff.
 *
 * @param client    - SuiClient instance
 * @param signer    - Ed25519Keypair to sign the transaction
 * @param buildTx   - Callback that populates the Transaction
 * @param label     - Human-readable label for logging
 * @param logger    - Pino logger instance
 * @returns TxResult on success, null if all retries exhausted
 */
export async function executeWithRetry(
  client: SuiClient,
  signer: Ed25519Keypair,
  buildTx: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<TxResult | null> {
  let delay = BASE_DELAY_MS;
  const t0 = Date.now();
  const finish = <T>(result: T, attempt: number): T => {
    if (txMetrics) {
      txMetrics.histogram.observe({ service: txMetrics.service, method: label }, (Date.now() - t0) / 1000);
      if (attempt > 1) txMetrics.retries.inc({ service: txMetrics.service, method: label }, attempt - 1);
    }
    return result;
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const tx = new Transaction();
      buildTx(tx);

      const result = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: { showEffects: true, showEvents: true, showObjectChanges: true },
      });

      await client.waitForTransaction({ digest: result.digest });

      logger.info({ digest: result.digest, attempt }, `${label} succeeded`);

      return finish(
        {
          digest: result.digest,
          effects: (result.effects ?? {}) as Record<string, unknown>,
          events: (result.events ?? []) as Record<string, unknown>[],
          objectChanges: (result.objectChanges ?? []) as Record<string, unknown>[],
        },
        attempt,
      );
    } catch (err) {
      if (isMoveAbort(err)) {
        logger.error({ err, attempt }, `${label} aborted on-chain (deterministic) -- not retrying`);
        return finish(null, attempt);
      }

      logger.warn({ err, attempt, delay }, `${label} failed, retrying`);

      if (attempt === MAX_RETRIES) {
        logger.error({ err }, `${label} exhausted retries, skipping`);
        return finish(null, attempt);
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * MULTIPLIER, MAX_DELAY_MS);
    }
  }

  return finish(null, MAX_RETRIES);
}

/**
 * Extract a created object ID from TX objectChanges by matching the object type suffix.
 *
 * The objectChanges array entries for created objects look like:
 *   { type: "created", objectType: "0xpkg::module::TypeName", objectId: "0x...", ... }
 *
 * @param result     - TX result from executeWithRetry
 * @param typeSuffix - e.g. '::caps::MinerCap' or '::staking::StakePosition'
 * @returns The objectId if found, null otherwise
 */
export function extractCreatedObjectByType(result: TxResult, typeSuffix: string): string | null {
  const changes = result.objectChanges;
  if (!Array.isArray(changes)) return null;

  const match = changes.find((entry) => {
    return (
      entry['type'] === 'created' &&
      typeof entry['objectType'] === 'string' &&
      (entry['objectType'] as string).endsWith(typeSuffix)
    );
  });

  if (!match) return null;

  const objectId = match['objectId'];
  return typeof objectId === 'string' ? objectId : null;
}
