/**
 * Small shared utilities for the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import { performance } from 'node:perf_hooks';

import type { MonotonicWallTime } from './types.ts';

export function nowPair(): MonotonicWallTime {
  const wallEpochMs = Date.now();
  return {
    wallIso: new Date(wallEpochMs).toISOString(),
    wallEpochMs,
    monoMs: performance.now(),
  };
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
}
