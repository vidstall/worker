/**
 * Environment, git, and contracts-snapshot verification helpers for the
 * P3 chain-latency measurement harness.
 *
 * Extracted verbatim from measure-chain-latency.ts as part of a pure
 * code-movement refactor; no behavior changes.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { LocalnetHandle } from '../../../apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts';
import { assertLocalnetPortsFree, resolveGitRef } from '../cost-run-safety.ts';

import { CONTRACTS_SOURCE_ROOT, DAEMONS_ROOT } from './constants.ts';
import type { SnapshotVerification } from './types.ts';
import { sleep } from './util.ts';

export function runChecked(
  command: string,
  args: string[],
  label: string,
  options: { cwd?: string; input?: string } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label}: exited ${result.status ?? 'unknown'}: ${(result.stderr ?? '').trim().slice(0, 1200)}`);
  }
  return (result.stdout ?? '').trim();
}

export function gitArgs(repo: string, args: string[]): string[] {
  return ['-c', `safe.directory=${repo.replace(/\\/g, '/')}`, '-C', repo, ...args];
}

export function gitStatus(repo: string): string {
  return runChecked(
    'git',
    gitArgs(repo, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']),
    `git status ${repo}`,
  );
}

export function assertOfficialHarnessScopeClean(): void {
  const paths = [
    'packages/shared/src/chain/events.ts',
    'apps/cp-daemon/src/__tests__/integration/localnet-fixture.ts',
    'apps/validator-daemon/src/session-proof.ts',
    'scripts/demo/seed-bootstrap.ts',
    'scripts/eval/cost-run-safety.ts',
    'scripts/eval/measure-chain-latency.ts',
    'scripts/eval/chain-latency-evidence.ts',
    'scripts/eval/replay-chain-latency.ts',
    'scripts/eval/__tests__/chain-latency-evidence.test.ts',
    'scripts/eval/__tests__/measure-chain-latency.test.ts',
  ];
  const status = runChecked(
    'git',
    gitArgs(DAEMONS_ROOT, ['status', '--porcelain=v1', '--untracked-files=normal', '--', ...paths]),
    'git status harness scope',
  );
  if (status.length !== 0) {
    throw new Error(`official run requires committed/clean harness scope:\n${status}`);
  }
}

export function listFiles(root: string, current = ''): string[] {
  const directory = resolve(root, current);
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath));
    } else {
      files.push(relativePath.replace(/\\/g, '/'));
    }
  }
  return files;
}

export function verifyContractsSnapshot(contractsDir: string, contractRef: string): SnapshotVerification {
  const commit = resolveGitRef(CONTRACTS_SOURCE_ROOT, contractRef);
  const tree = runChecked(
    'git',
    gitArgs(CONTRACTS_SOURCE_ROOT, ['ls-tree', '-r', commit]),
    `git ls-tree ${commit}`,
  );
  const entries = tree.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^[0-9]+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
    if (match === null) throw new Error(`unexpected git ls-tree row: ${line}`);
    return { hash: match[1]!, path: match[2]!.replace(/\\/g, '/') };
  });
  const expectedPaths = entries.map((entry) => entry.path).sort();
  const actualPaths = listFiles(contractsDir).sort();
  if (expectedPaths.length !== actualPaths.length) {
    throw new Error(
      `contracts snapshot file-count mismatch: expected ${expectedPaths.length}, got ${actualPaths.length}`,
    );
  }
  for (let index = 0; index < expectedPaths.length; index += 1) {
    if (expectedPaths[index] !== actualPaths[index]) {
      throw new Error(
        `contracts snapshot inventory mismatch at ${index}: expected ${expectedPaths[index]}, got ${actualPaths[index]}`,
      );
    }
  }
  for (const path of actualPaths) {
    if (!lstatSync(resolve(contractsDir, path)).isFile()) {
      throw new Error(`contracts snapshot contains unsupported non-file entry: ${path}`);
    }
  }
  const hashOutput = runChecked(
    'git',
    ['hash-object', '--stdin-paths'],
    'git hash-object contracts snapshot',
    { cwd: contractsDir, input: `${entries.map((entry) => entry.path).join('\n')}\n` },
  );
  const hashes = hashOutput.split(/\r?\n/).filter(Boolean);
  if (hashes.length !== entries.length) {
    throw new Error(`contracts snapshot hash count mismatch: expected ${entries.length}, got ${hashes.length}`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (hashes[index] !== entries[index]!.hash) {
      throw new Error(`contracts snapshot blob mismatch: ${entries[index]!.path}`);
    }
  }
  return {
    commit,
    trackedFileCount: entries.length,
    treeSha256: createHash('sha256')
      .update(entries.map((entry) => `${entry.hash}  ${entry.path}`).join('\n'), 'utf8')
      .digest('hex'),
  };
}

export function activeSuiEnvironment(): string | null {
  const result = spawnSync('sui', ['client', 'active-env'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length === 0 ? null : value;
}

export function activeSuiAddress(): string | null {
  const result = spawnSync('sui', ['client', 'active-address'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const value = (result.stdout ?? '').trim();
  return value.length === 0 ? null : value;
}

export function switchToCheckedLocalEnvironment(): { alias: string; rpc: string } {
  const envsRaw = runChecked('sui', ['client', 'envs', '--json'], 'sui client envs --json');
  const parsed = JSON.parse(envsRaw) as unknown;
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0])) {
    throw new Error('sui client envs --json returned an unexpected shape');
  }
  const environments = parsed[0] as Array<{ alias?: unknown; rpc?: unknown }>;
  const local = environments.find((entry) => entry.alias === 'local');
  if (local === undefined || local.rpc !== 'http://127.0.0.1:9000') {
    throw new Error(
      `required local Sui environment is missing or misconfigured: ${JSON.stringify(local ?? null)}`,
    );
  }
  runChecked('sui', ['client', 'switch', '--env', 'local'], 'sui client switch --env local');
  const active = activeSuiEnvironment();
  if (active !== 'local') {
    throw new Error(`Sui environment switch verification failed: expected local, got ${active ?? '(none)'}`);
  }
  return { alias: 'local', rpc: local.rpc };
}

export function assertLocalCliEnvironment(handle: LocalnetHandle): string {
  const active = activeSuiEnvironment();
  if (active === null || !active.startsWith('phase40-')) {
    throw new Error(`fixture did not switch to its checked local alias: ${active ?? '(none)'}`);
  }
  if (handle.config.rpcUrl !== 'http://127.0.0.1:9000') {
    throw new Error(`fixture RPC URL is not pinned localnet: ${handle.config.rpcUrl}`);
  }
  return active;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function writeExclusive(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', flag: 'wx' });
}

export async function waitForPortsClosed(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertLocalnetPortsFree();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(500);
    }
  }
}
