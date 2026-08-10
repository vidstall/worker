/**
 * Shared row shapes + low-level tx execution/measurement helpers for the
 * on-chain gas measurement fixture (measure-onchain-cost.ts and friends).
 *
 * Pure extraction from the original measure-onchain-cost.ts — no behavior
 * changes.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import { Transaction } from '@mysten/sui/transactions';

import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  executeWithRetry,
  fetchEventsForDigest,
  type Logger,
  type TxResult,
} from '../../../packages/shared/src/index.ts';

export const MODULE = 'measure-onchain-cost';

export const K = 2 as const;
export const N = 4 as const;

// ── raw JSONL row shapes ──────────────────────────────────────────────────

export interface GasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
  nonRefundableStorageFee: string;
}

export interface CostRow {
  fn: string;
  module: string;
  gasUsed: GasUsed;
  digest: string;
  timestamp: string;
}

export interface ProvenanceRow {
  meta: true;
  protocolVersion: string;
  referenceGasPrice: string;
  frameworkRev: string;
  cliVersion: string;
  network: 'localnet';
  timestamp: string;
}

export interface K2ProvenanceRow extends ProvenanceRow {
  schema: 'dvconf-cost-k2/1.0';
  complete: true;
  K: 2;
  N: 4;
  proofCount: 8;
  runId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  workspaceCommit: string;
  workspaceDirty: boolean;
  workspaceDirtyFingerprint: string | null;
  contractCommit: string;
  contractsSourceDirty: boolean;
  contractsSourceDirtyFingerprint: string | null;
  contractsSnapshotDir: string;
  daemonCommit: string;
  daemonDirty: boolean;
  daemonDirtyFingerprint: string | null;
}

/**
 * Pull the 4-field gasUsed off a TxResult's effects. `effects` is a
 * Record<string, unknown> off the shared TxResult; gasUsed is nested.
 * Coerces every field to string (BCS returns strings; be defensive on numbers).
 */
export function gasUsedFromEffects(effects: Record<string, unknown>, label: string): GasUsed {
  const gu = effects['gasUsed'];
  if (gu === undefined || gu === null || typeof gu !== 'object') {
    throw new Error(`${label}: effects.gasUsed missing (effects keys: ${Object.keys(effects).join(',')})`);
  }
  const g = gu as Record<string, unknown>;
  const field = (k: string): string => {
    const v = g[k];
    if (v === undefined || v === null) {
      throw new Error(`${label}: effects.gasUsed.${k} missing`);
    }
    return String(v);
  };
  return {
    computationCost: field('computationCost'),
    storageCost: field('storageCost'),
    storageRebate: field('storageRebate'),
    nonRefundableStorageFee: field('nonRefundableStorageFee'),
  };
}

/** net cost helper for the report table (computation + storage - rebate). */
export function netCost(g: GasUsed): bigint {
  return BigInt(g.computationCost) + BigInt(g.storageCost) - BigInt(g.storageRebate);
}

export function makeRow(fn: string, module: string, result: TxResult): CostRow {
  return {
    fn,
    module,
    gasUsed: gasUsedFromEffects(result.effects, fn),
    digest: result.digest,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Run one measured moveCall through executeWithRetry (which already requests
 * showEffects:true), and return a CostRow. Fails LOUD on a null result.
 */
export async function measure(
  client: SuiClient,
  signer: Ed25519Keypair,
  fn: string,
  module: string,
  build: (tx: Transaction) => void,
  logger: Logger,
): Promise<CostRow> {
  const result = await executeWithRetry(client, signer, build, fn, logger);
  if (result === null) {
    throw new Error(`measure(${fn}): transaction failed after retries`);
  }
  return makeRow(fn, module, result);
}

/**
 * Effects-capturing SINGLE-ATTEMPT execution that asserts on-chain success and
 * surfaces the Move abort string LOUD (unlike executeWithRetry, which blindly
 * retries a deterministic abort 5× then returns null). Used for the
 * Dispatch-2 hard/lifecycle functions where a precondition abort must be
 * diagnosable, and where we need the real `effects` back (for gasUsed + events).
 * Mirrors shared `signAndAssert` but returns a full TxResult-shaped object.
 */
export async function signAndCapture(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
  graphqlClient?: SuiGraphQLClient,
): Promise<TxResult> {
  const tx = new Transaction();
  build(tx);
  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showEvents: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: result.digest });
  const effects = (result.effects ?? {}) as Record<string, unknown>;
  const status = (effects['status'] as { status?: string; error?: string } | undefined);
  if (status?.status !== 'success') {
    throw new Error(`${label} failed on-chain: status=${status?.status ?? 'unknown'} error=${status?.error ?? '(none)'}`);
  }
  logger.info({ module: MODULE, action: label, digest: result.digest }, `${label} succeeded on-chain`);
  let events = (result.events ?? []) as Record<string, unknown>[];
  if (events.length === 0 && graphqlClient) {
    // devnet's public fullnode returns empty `events` on the JSON-RPC execute
    // response (event-shaped reads are deprecated there); harmless no-op on
    // localnet, where JSON-RPC events already come back populated.
    events = (await fetchEventsForDigest(graphqlClient, result.digest)) as unknown as Record<string, unknown>[];
  }
  return {
    digest: result.digest,
    effects,
    events,
    objectChanges: (result.objectChanges ?? []) as Record<string, unknown>[],
  };
}

/** Measured variant of signAndCapture: returns a CostRow AND the raw result. */
export async function measureCapture(
  client: SuiClient,
  signer: Ed25519Keypair,
  fn: string,
  module: string,
  build: (tx: Transaction) => void,
  logger: Logger,
  graphqlClient?: SuiGraphQLClient,
): Promise<{ row: CostRow; result: TxResult }> {
  const result = await signAndCapture(client, signer, build, fn, logger, graphqlClient);
  return { row: makeRow(fn, module, result), result };
}

/**
 * Fetch the publish tx's gasUsed. bootLocalnet() publishes internally but does not
 * return the publish digest, so we recover it from the package object's
 * previousTransaction, then read that tx block's effects.gasUsed.
 */
export async function measurePublish(client: SuiClient, packageId: string, logger: Logger): Promise<CostRow> {
  const pkgObj = await client.getObject({
    id: packageId,
    options: { showPreviousTransaction: true },
  });
  const prevTx = pkgObj.data?.previousTransaction;
  if (typeof prevTx !== 'string') {
    throw new Error(`measurePublish: package ${packageId} has no previousTransaction`);
  }
  const txBlock = await client.getTransactionBlock({
    digest: prevTx,
    options: { showEffects: true },
  });
  const effects = (txBlock.effects ?? {}) as unknown as Record<string, unknown>;
  logger.info({ module: MODULE, action: 'measure_publish', digest: prevTx }, 'captured publish gasUsed');
  return {
    fn: 'publish',
    module: 'package',
    gasUsed: gasUsedFromEffects(effects, 'publish'),
    digest: prevTx,
    timestamp: new Date().toISOString(),
  };
}

// ── faucet helpers (localnet built-in; async → poll for the gas coin) ─────

export const FAUCET_URL = getFaucetHost('localnet');
export const MINER_STAKE_MIST = 300_000_000n;

/** Fund a fresh keypair and wait for its first gas coin to be indexed. */
export async function fundAndWait(client: SuiClient, address: string, timeoutMs = 90_000): Promise<void> {
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) return;
    if (Date.now() > deadline) throw new Error(`faucet gas never indexed for ${address}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
