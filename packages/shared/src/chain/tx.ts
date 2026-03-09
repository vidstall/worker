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
        options: { showEffects: true, showEvents: true },
      });

      await client.waitForTransaction({ digest: result.digest });

      logger.info({ digest: result.digest, attempt }, `${label} succeeded`);

      return {
        digest: result.digest,
        effects: (result.effects ?? {}) as Record<string, unknown>,
        events: (result.events ?? []) as Record<string, unknown>[],
      };
    } catch (err) {
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
 * Extract a created object ID from TX effects by matching the object type suffix.
 *
 * The effects.created array entries look like:
 *   { owner: {...}, reference: { objectId: "0x..." }, objectType: "0xpkg::module::TypeName" }
 *
 * @param result     - TX result from executeWithRetry
 * @param typeSuffix - e.g. '::caps::MinerCap' or '::staking::StakePosition'
 * @returns The objectId if found, null otherwise
 */
export function extractCreatedObjectByType(result: TxResult, typeSuffix: string): string | null {
  const raw = result.effects['created'];
  if (!Array.isArray(raw)) return null;

  const created = raw as Array<Record<string, unknown>>;

  const match = created.find((entry) => {
    const objectType = entry['objectType'];
    return typeof objectType === 'string' && objectType.endsWith(typeSuffix);
  });

  if (!match) return null;

  const reference = match['reference'];
  if (reference === null || typeof reference !== 'object') return null;

  const objectId = (reference as Record<string, unknown>)['objectId'];
  return typeof objectId === 'string' ? objectId : null;
}
