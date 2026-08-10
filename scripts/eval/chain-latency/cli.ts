/**
 * CLI argument parsing for the P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { CONTRACTS_SOURCE_ROOT, PINNED_CONTRACT_REF } from './constants.ts';
import type { ChainLatencyOptions, RunMode } from './types.ts';

function flagValue(argv: string[], flag: string): string | undefined {
  const indexes = argv.flatMap((value, index) => value === flag ? [index] : []);
  if (indexes.length > 1) throw new Error(`${flag} may be supplied only once`);
  if (indexes.length === 0) return undefined;
  const value = argv[indexes[0]! + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseChainLatencyOptions(argv: string[]): ChainLatencyOptions {
  const knownFlags = new Set([
    '--contracts-dir',
    '--contract-ref',
    '--run-id',
    '--trace-id',
    '--samples',
    '--output-root',
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith('--')) throw new Error(`unexpected positional argument: ${value}`);
    if (!knownFlags.has(value)) throw new Error(`unknown option: ${value}`);
    index += 1;
  }

  const contractsArg = flagValue(argv, '--contracts-dir');
  if (contractsArg === undefined) throw new Error('--contracts-dir is required');
  const contractsDir = resolve(contractsArg);
  if (isWithin(CONTRACTS_SOURCE_ROOT, contractsDir)) {
    throw new Error(`refusing canonical contracts working tree: ${contractsDir}`);
  }
  if (!existsSync(resolve(contractsDir, 'Move.toml')) || !existsSync(resolve(contractsDir, 'Move.lock'))) {
    throw new Error(`contracts snapshot must contain Move.toml and Move.lock: ${contractsDir}`);
  }

  const contractRef = flagValue(argv, '--contract-ref') ?? PINNED_CONTRACT_REF;
  if (!/^[0-9a-fA-F]{7,40}$/.test(contractRef)) {
    throw new Error('--contract-ref must be a 7-40 digit hexadecimal Git ref');
  }

  const runId = flagValue(argv, '--run-id');
  if (runId === undefined) throw new Error('--run-id is required');
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw new Error('--run-id may contain only letters, digits, dot, underscore, and dash');
  }

  const traceId = flagValue(argv, '--trace-id') ?? randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(traceId)) {
    throw new Error('--trace-id must be a UUIDv4');
  }

  const samplesRaw = flagValue(argv, '--samples');
  if (samplesRaw === undefined) throw new Error('--samples is required and must be 1 or 30');
  const samplesNumber = Number(samplesRaw);
  if (samplesNumber !== 1 && samplesNumber !== 30) {
    throw new Error('--samples must be exactly 1 (spike) or 30 (official)');
  }
  const samples = samplesNumber as 1 | 30;
  const mode: RunMode = samples === 1 ? 'spike' : 'official';

  const outputArg = flagValue(argv, '--output-root');
  if (outputArg === undefined) throw new Error('--output-root is required');
  const outputRoot = resolve(outputArg);
  const runDir = resolve(outputRoot, runId);
  if (!isWithin(outputRoot, runDir) || runDir === outputRoot) {
    throw new Error(`derived run directory escapes output root: ${runDir}`);
  }
  if (existsSync(runDir)) throw new Error(`run directory already exists: ${runDir}`);

  return { contractsDir, contractRef, runId, traceId, samples, mode, outputRoot, runDir };
}
