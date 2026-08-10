/**
 * Sui localnet lifecycle + low-level CLI plumbing — extracted from
 * run-smoke.ts (S25.A/B split). Owns the workspace path constants, the
 * shell-out helper (`runCli`), and everything that talks directly to the
 * `sui` binary before any daemon or registry exists: spawning the node,
 * waiting for its RPC, `sui client` env setup, and `test-publish`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmSync,
  createWriteStream,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ed25519Keypair as Ed25519KeypairType } from '@mysten/sui/keypairs/ed25519';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { getFaucetHost } from '@mysten/sui/faucet';
import {
  parsePublishJson,
  waitForPort,
  type PublishOutput,
  type SuiPublishResult,
} from './parsers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Workspace path + endpoint constants ────────────────────────────────

/** Workspace root — three levels up from scripts/bench/ (this file lives one
 * level deeper, in scripts/bench/smoke/, hence the extra `..`). */
export const WORKSPACE_ROOT = resolve(__dirname, '..', '..', '..', '..');
export const CONTRACTS_DIR = join(WORKSPACE_ROOT, 'dvconf-contracts');
export const DAEMONS_DIR = join(WORKSPACE_ROOT, 'dvconf-daemons');
export const LOGS_DIR = join(WORKSPACE_ROOT, '.logs', 'bench');
export const SUI_RPC_URL = 'http://127.0.0.1:9000';
export const FAUCET_URL = getFaucetHost('localnet');

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn a CLI binary and capture stdout/stderr cleanly. No shell — no PS↔python
 * NativeCommandError class possible. Optional timeout SIGTERM-kills the child.
 */
export function runCli(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CliResult> {
  return new Promise((resolveResult, reject) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      resolveResult({ stdout, stderr, code: code ?? 1 });
    });
    if (opts.timeoutMs !== undefined) {
      setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGTERM');
      }, opts.timeoutMs);
    }
  });
}

export interface SuiNodeHandle {
  proc: ChildProcess;
  stop: () => Promise<void>;
}

/**
 * Spawn `sui start --with-faucet --force-regenesis` as a long-lived child.
 * Returns a stop() that SIGTERMs, then SIGKILLs after 5s grace.
 */
export function spawnSuiNode(logFilePath?: string): SuiNodeHandle {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RUST_LOG: 'off,sui_node=info',
  };
  const proc = spawn(
    'sui',
    ['start', '--with-faucet', '--force-regenesis'],
    { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (logFilePath !== undefined) {
    mkdirSync(dirname(logFilePath), { recursive: true });
    const ws = createWriteStream(logFilePath);
    proc.stdout?.pipe(ws);
    proc.stderr?.pipe(ws);
  }
  const stop = (): Promise<void> =>
    new Promise<void>((resolveStop) => {
      if (proc.exitCode !== null || proc.killed) {
        resolveStop();
        return;
      }
      const killTimer = setTimeout(() => {
        if (proc.exitCode === null) proc.kill('SIGKILL');
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolveStop();
      });
      proc.kill('SIGTERM');
    });
  return { proc, stop };
}

/**
 * Wait for the Sui RPC to both bind port 9000 and respond to
 * `sui_getLatestCheckpointSequenceNumber`. Two phases: TCP, then JSON-RPC.
 */
export async function waitForSuiRpc(timeoutMs = 180_000): Promise<void> {
  const portDeadline = Date.now() + Math.min(120_000, timeoutMs);
  await waitForPort('127.0.0.1', 9000, portDeadline - Date.now(), 2000);
  const rpcDeadline = Date.now() + 60_000;
  while (Date.now() < rpcDeadline) {
    try {
      const resp = await fetch(SUI_RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sui_getLatestCheckpointSequenceNumber',
          params: [],
        }),
      });
      const json = (await resp.json()) as { result?: unknown };
      if (json.result !== undefined) return;
    } catch {
      // RPC not yet accepting calls
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('waitForSuiRpc: JSON-RPC not responding after 60s');
}

/**
 * Idempotent `sui client` env setup: new-env (alias `bench-localnet`),
 * switch, faucet-fund the active address.
 */
export async function setupSuiClient(): Promise<void> {
  await runCli('sui', [
    'client',
    'new-env',
    '--alias',
    'bench-localnet',
    '--rpc',
    SUI_RPC_URL,
  ]);
  await runCli('sui', ['client', 'switch', '--env', 'bench-localnet']);
  const faucet = await runCli('sui', [
    'client',
    'faucet',
    '--url',
    `${FAUCET_URL}/gas`,
  ]);
  if (faucet.code !== 0) {
    throw new Error(`sui client faucet failed: ${faucet.stderr.slice(0, 300)}`);
  }
  // Give the faucet a moment to land + checkpoint.
  await new Promise((r) => setTimeout(r, 2000));
}

/**
 * Clean stale publication state (chain-id mismatch after force-regenesis) +
 * stale event-poller cursors that would re-replay old events into fresh chain.
 */
function cleanStaleState(): void {
  // Delete every Pub.<env>.toml + Move.lock — they cache a chain-id that
  // doesn't match after `--force-regenesis`. The PS script only deleted
  // Pub.local.toml because it used a fixed env alias; we use whatever alias
  // we passed to `new-env`, so glob-delete.
  for (const entry of readdirSync(CONTRACTS_DIR)) {
    if (entry.startsWith('Pub.') && entry.endsWith('.toml')) {
      unlinkSync(join(CONTRACTS_DIR, entry));
    }
  }
  const moveLock = join(CONTRACTS_DIR, 'Move.lock');
  if (existsSync(moveLock)) unlinkSync(moveLock);
  for (const sub of ['cp-daemon', 'validator-daemon', 'relay']) {
    const cursorDir = join(DAEMONS_DIR, 'apps', sub, '.cursors');
    if (existsSync(cursorDir)) rmSync(cursorDir, { recursive: true, force: true });
  }
}

/**
 * Publish the Move package via `sui client test-publish --json`. Returns the
 * 6 load-bearing identities surfaced by parsePublishJson.
 */
export async function publishPackage(): Promise<PublishOutput> {
  cleanStaleState();
  const result = await runCli(
    'sui',
    [
      'client',
      'test-publish',
      '--gas-budget',
      '1000000000',
      '--build-env',
      'local',
      '--json',
    ],
    { cwd: CONTRACTS_DIR, timeoutMs: 240_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `sui test-publish exited ${result.code}\n--- STDERR ---\n${result.stderr.slice(0, 1500)}\n--- STDOUT ---\n${result.stdout.slice(0, 1500)}`,
    );
  }
  // Strip any non-JSON noise that `sui` occasionally prints before the JSON.
  const jsonStart = result.stdout.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(
      `sui test-publish produced no JSON: ${result.stdout.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(result.stdout.slice(jsonStart)) as SuiPublishResult;
  return parsePublishJson(parsed);
}

/**
 * Export the bech32 secret key of the currently-active sui client address.
 * Used to construct an SDK signer that holds AdminCap + TreasuryCap after
 * publish, so subsequent transactions can run via the SDK (no shell for ops
 * we control).
 */
export async function loadActiveSigner(): Promise<Ed25519KeypairType> {
  const addrResult = await runCli('sui', ['client', 'active-address']);
  if (addrResult.code !== 0) {
    throw new Error(
      `sui client active-address failed: ${addrResult.stderr.slice(0, 300)}`,
    );
  }
  const activeAddr = addrResult.stdout.trim();
  const exportResult = await runCli('sui', [
    'keytool',
    'export',
    '--key-identity',
    activeAddr,
    '--json',
  ]);
  if (exportResult.code !== 0) {
    throw new Error(
      `sui keytool export failed: ${exportResult.stderr.slice(0, 300)}`,
    );
  }
  const exported = JSON.parse(exportResult.stdout) as {
    exportedPrivateKey?: string;
  };
  if (typeof exported.exportedPrivateKey !== 'string') {
    throw new Error('sui keytool export returned no exportedPrivateKey');
  }
  return Ed25519Keypair.fromSecretKey(exported.exportedPrivateKey);
}
