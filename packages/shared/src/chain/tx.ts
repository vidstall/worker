/**
 * Thin TX wrapper with exponential backoff retry.
 *
 * Pattern: build Transaction -> sign -> execute -> wait for finality -> retry on failure.
 * Backoff: 1s base, 2x multiplier, 30s ceiling, 5 max retries.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { TxResult } from '../types/chain.js';
import type { Logger } from 'pino';

const BASE_DELAY_MS = 1_000;
const MULTIPLIER = 2;
const MAX_DELAY_MS = 30_000;
const MAX_RETRIES = 5;

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

      return {
        digest: result.digest,
        effects: (result.effects ?? {}) as Record<string, unknown>,
        events: (result.events ?? []) as Record<string, unknown>[],
        objectChanges: (result.objectChanges ?? []) as Record<string, unknown>[],
      };
    } catch (err) {
      if (isMoveAbort(err)) {
        logger.error({ err, attempt }, `${label} aborted on-chain (deterministic) -- not retrying`);
        return null;
      }

      logger.warn({ err, attempt, delay }, `${label} failed, retrying`);

      if (attempt === MAX_RETRIES) {
        logger.error({ err }, `${label} exhausted retries, skipping`);
        return null;
      }

      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * MULTIPLIER, MAX_DELAY_MS);
    }
  }

  return null;
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
