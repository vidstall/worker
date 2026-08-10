/**
 * SMH-LIVE orchestrator — infra control: boot channel (run-rms-live-local.ps1 shells),
 * chaos.ps1 wrapper, .env injection, and .logs reading.
 *
 * Split out of run-smh-live.ts (pure code movement, no behavior change).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Fixed paths / constants (AUDIT Step 5) ─────────────────────────────

export const WORKSPACE_ROOT = 'C:\\Thesis\\dvconf';
export const RUN_PS1 = path.join(WORKSPACE_ROOT, 'run-rms-live-local.ps1');
export const DAEMONS_ENV = path.join(WORKSPACE_ROOT, 'dvconf-daemons', '.env');
export const LOGS_DIR = path.join(WORKSPACE_ROOT, '.logs');
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CHAOS_PS1 = path.join(HERE, 'chaos.ps1');

export const BOOT_TIMEOUT_MS = 6 * 60 * 1000;

// ── Small shell + fs boundaries ────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run a `run-rms-live-local.ps1` sub-command (inherits stdio so live output streams). */
export function runPs1(action: string, extra: string[] = []): void {
  execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', RUN_PS1, action, ...extra],
    { cwd: WORKSPACE_ROOT, stdio: 'inherit', timeout: BOOT_TIMEOUT_MS },
  );
}

/** Run a chaos.ps1 verb; return the last non-empty stdout line (the output contract). */
export function chaos(action: 'kill' | 'isopen', port: number): string {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CHAOS_PS1, '-Action', action, '-Port', String(port)],
    { encoding: 'utf8' },
  );
  return out.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '').pop() ?? '';
}

/** Append env lines to the daemons `.env` (deploy just rewrote it, so this must run per-boot). */
export function injectEnv(lines: string[]): void {
  fs.appendFileSync(DAEMONS_ENV, `\n# --- smh-live injected ---\n${lines.join('\n')}\n`);
}

/** Read the newest `.logs/<prefix>*.log`, split into lines (empty when none yet). */
export function newestLogLines(prefix: string): string[] {
  if (!fs.existsSync(LOGS_DIR)) return [];
  const files = fs
    .readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
    .map((f) => ({ f, m: fs.statSync(path.join(LOGS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) return [];
  return fs.readFileSync(path.join(LOGS_DIR, files[0]!.f), 'utf8').split(/\r?\n/);
}

// ── Boot / teardown ────────────────────────────────────────────────────

export function bootFresh(inject: string[]): void {
  // `sui start --force-regenesis` intermittently exceeds the ps1's 120s RPC-ready poll on a
  // contended host (documented flake in localnet-fixture) -> the ps1 `network` step exits 1. Retry
  // it (kill the half-booted sui first) rather than failing the whole run. deploy/daemons are
  // deterministic once the chain is up.
  const NETWORK_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      runPs1('network');
      break;
    } catch (err) {
      if (attempt >= NETWORK_ATTEMPTS) throw err;
      try {
        chaos('kill', 9000);
      } catch {
        /* ignore */
      }
      try {
        chaos('kill', 9123);
      } catch {
        /* ignore */
      }
    }
  }
  runPs1('deploy'); // REWRITES dvconf-daemons/.env — inject AFTER this
  injectEnv(inject);
  runPs1('daemons', ['-RelayCount', '3', '-ValidatorCount', '4']);
}

export function teardown(): void {
  try {
    runPs1('stop');
  } catch {
    // best-effort — never throw from teardown
  }
  // ps1 `stop` intentionally leaves sui alive (AUDIT Step 5) — kill it + the faucet.
  try {
    chaos('kill', 9000);
  } catch {
    /* ignore */
  }
  try {
    chaos('kill', 9123);
  } catch {
    /* ignore */
  }
}
