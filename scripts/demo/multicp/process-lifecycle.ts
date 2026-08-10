/**
 * Multi-CP Voting Live (N=5) — process lifecycle module, extracted from
 * run-multicp-voting.ts (pure code movement, no behavior change): spawning a
 * daemon child, dual-gate readiness (TCP + /healthz), the user-miner
 * self-provisioning faucet flow, and teardown (tree-kill per platform).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync, mkdirSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import { type Logger } from '../../../packages/shared/src/index.ts'; // relative SOURCE import — scripts/ sits OUTSIDE the pnpm workspace graph (mirrors seed-multicp.ts:56 / escrow-driver.ts:61).
import type { MultiCpKeysFile } from '../seed-multicp.ts'; // TYPE-ONLY: elided at runtime → seed-multicp.ts's unguarded top-level main() is NOT executed on import.
import { MODULE, IDENTITY_ENV_KEYS, type ProcessSpec } from './launch-plan.ts';

const HEALTHZ_TIMEOUT_MS = 120_000; // all-up budget per the spec (≥120s)
const HEALTHZ_POLL_MS = 500;
const TEARDOWN_GRACE_MS = 5_000;

/** Faucet levers for the self-provisioned user-miner (mirrors escrow-driver.ts:65-79). */
const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const FAUCET_SETTLE_MS = 1_500; // let the drip tx settle before reading balance
const MAX_FAUCET_DRIPS = 2;
/**
 * 1 SUI wallet BALANCE for the user-miner: faucet-fund + register/apply/register GAS
 * headroom. NOTE — balance ≠ stake: the daemon stakes a FIXED 0.1 SUI (auto-register.ts:59)
 * regardless of wallet balance, so this 1 SUI does NOT clear a voted-role stake floor > 0.1
 * (relay 0.25 / cp 0.5). If the CPs assign such a role, apply_voted_role aborts 713 (or the
 * follow-on register aborts) and the subject daemon exits AFTER #6 — benign, and does NOT
 * affect the #6/#7 proofs (read from on-chain events; see main() step d).
 */
const USER_MINER_MIN_BALANCE_MIST = 1_000_000_000n;

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One TCP connect attempt. Resolves true on connect, false on error/timeout.
 * Replicated from scripts/bench/run-smoke.ts:276 (that module is outside the
 * workspace tsconfig graph + carries unrelated latent type errors, so we copy the
 * small pure poller rather than import it — same discipline as seed-bootstrap.ts).
 */
function tryConnectOnce(host: string, port: number, connectTimeoutMs: number): Promise<boolean> {
  return new Promise((resolveOk) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveOk(ok);
    };
    socket.setTimeout(connectTimeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/** Poll a TCP port until it accepts a connection, or throw after `timeoutMs`. */
async function waitForPort(host: string, port: number, timeoutMs: number, pollIntervalMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tryConnectOnce(host, port, Math.min(1000, pollIntervalMs))) return;
    await sleep(pollIntervalMs);
  }
  throw new Error(`waitForPort: ${host}:${port} not reachable after ${timeoutMs}ms`);
}

/** A spawned process plus the spec that produced it (for health + teardown). */
export interface ProcessHandle {
  spec: ProcessSpec;
  proc: ChildProcess;
  /** Last lines of merged stdout+stderr, surfaced on a ready/teardown failure. */
  tail: string[];
  killed: boolean;
}

const MAX_TAIL_LINES = 60;

/**
 * Build a child's env: scrub EVERY role-identity/behavior key from a COPY of
 * `inherited` (so a leaked CP_KEYPAIR / VALIDATOR_CAP_ID / REGISTRATION_MODE can't
 * bleed into the wrong role), then layer the spec's fully-resolved env on top.
 * PURE (takes `inherited` explicitly, mutates nothing) + unit-tested — this is the
 * only safety-critical env behavior, so it is locked by a test.
 */
export function mergeChildEnv(inherited: NodeJS.ProcessEnv, spec: ProcessSpec): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...inherited };
  for (const k of IDENTITY_ENV_KEYS) delete base[k];
  return { ...base, ...spec.env };
}

/**
 * Spawn one daemon. Entry is absolute; CWD is the isolated `.run/<role>`; env is
 * the inherited process.env with ALL identity keys SCRUBBED, then the spec's
 * fully-resolved env layered on top (see mergeChildEnv). stdout/stderr are kept as
 * a small in-memory tail for failure reporting.
 */
export function spawnProcess(spec: ProcessSpec, logger: Logger): ProcessHandle {
  mkdirSync(spec.cwd, { recursive: true });

  const env = mergeChildEnv(process.env, spec);

  const proc = spawn(process.execPath, ['--import', 'tsx/esm', spec.entry], {
    cwd: spec.cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  const handle: ProcessHandle = { spec, proc, tail: [], killed: false };
  // Best-effort line splitting: a log line straddling a chunk boundary is mis-split
  // (no cross-chunk buffering). Acceptable here — the tail only feeds failure reporting
  // + the DIAGNOSTIC summarizeRetryTails, never a gate; the load-bearing proofs read
  // on-chain events, not this text.
  const onChunk = (chunk: Buffer): void => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.length === 0) continue;
      handle.tail.push(line);
      if (handle.tail.length > MAX_TAIL_LINES) handle.tail.shift();
    }
  };
  proc.stdout?.on('data', onChunk);
  proc.stderr?.on('data', onChunk);

  logger.info(
    { module: MODULE, action: 'spawn', context: { name: spec.name, pid: proc.pid, healthzPort: spec.healthzPort, cwd: spec.cwd } },
    `spawned ${spec.name}`,
  );
  return handle;
}

/**
 * GET /healthz once; resolve true only on HTTP 200 with {status:"alive"}. A 2s
 * per-request abort guards against a daemon that accepts the TCP socket but never
 * answers (undici's default ~300s timeout would otherwise blow the 120s budget);
 * the abort folds into the catch → false → retry loop.
 */
async function probeHealthz(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    if (resp.status !== 200) return false;
    const body = (await resp.json()) as { status?: string };
    return body.status === 'alive';
  } catch {
    return false; // not yet accepting / connection refused / per-request abort
  }
}

/**
 * Dual-gate readiness for one process: (1) TCP waitForPort on the healthz port
 * (the locally-replicated poller above), then (2) GET /healthz until 200
 * {status:"alive"}. Rejects early if the child exits before ready, and on timeout
 * surfaces the daemon name + last log tail (a voting-mode hang is otherwise silent).
 */
export async function waitHealthy(handle: ProcessHandle, timeoutMs = HEALTHZ_TIMEOUT_MS): Promise<void> {
  const { spec, proc } = handle;
  const deadline = Date.now() + timeoutMs;

  let rejectExit: (err: Error) => void = () => {};
  const exitListener = (code: number | null, signal: NodeJS.Signals | null): void => {
    rejectExit(new Error(`${spec.name} exited (code=${code}, signal=${signal ?? 'none'}) before ready`));
  };
  const exited = new Promise<never>((_, reject) => {
    rejectExit = reject;
  });
  proc.once('exit', exitListener);

  const ready = (async (): Promise<void> => {
    await waitForPort('127.0.0.1', spec.healthzPort, Math.max(1, deadline - Date.now()), HEALTHZ_POLL_MS);
    while (Date.now() < deadline) {
      if (await probeHealthz(spec.healthzPort)) return;
      await sleep(HEALTHZ_POLL_MS);
    }
    throw new Error(`${spec.name} /healthz never reported alive on :${spec.healthzPort} within ${timeoutMs}ms`);
  })();

  try {
    await Promise.race([ready, exited]);
  } catch (err) {
    const tail = handle.tail.slice(-20).join('\n');
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`waitHealthy(${spec.name}): ${msg}\n--- last 20 log lines ---\n${tail}`);
  } finally {
    // Detach the exit listener so a later teardown 'exit' doesn't fire a dangling
    // rejection (the success path never consumes it).
    proc.removeListener('exit', exitListener);
  }
}

/** Read + parse the seeded multi-CP keys file (fails loud if absent/malformed). */
export function loadKeys(path: string): MultiCpKeysFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`run-multicp-voting: keys file not found at ${path} — run seed-multicp.ts first (${err instanceof Error ? err.message : String(err)})`);
  }
  return JSON.parse(raw) as MultiCpKeysFile;
}

/**
 * Self-provision the USER-miner keypair: generate a fresh Ed25519 key, then
 * faucet-fund it until it holds >= USER_MINER_MIN_BALANCE_MIST — drip → settle →
 * check balance, up to MAX_FAUCET_DRIPS, fail loud if still short (mirrors
 * escrow-driver.ts:96-112 fundUntilSufficient). Returns the bech32 secretKey (for
 * the daemon's SUI_PRIVATE_KEY) AND the Sui address — which IS the miner_id the
 * role vote assigns (auto-register.ts:122: minerId = signer.toSuiAddress()), so C4
 * observes #6 by this address WITHOUT parsing a registration event.
 */
export async function provisionUserMiner(
  client: SuiClient,
  logger: Logger,
): Promise<{ secretKey: string; address: string }> {
  const kp = Ed25519Keypair.generate();
  const address = kp.getPublicKey().toSuiAddress();
  let balance = 0n;
  for (let drip = 1; drip <= MAX_FAUCET_DRIPS; drip++) {
    await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
    await sleep(FAUCET_SETTLE_MS);
    balance = BigInt((await client.getBalance({ owner: address })).totalBalance);
    logger.info(
      { module: MODULE, action: 'provision_user_miner', context: { address, drip, balance: balance.toString() } },
      'user-miner faucet drip settled',
    );
    if (balance >= USER_MINER_MIN_BALANCE_MIST) return { secretKey: kp.getSecretKey(), address };
  }
  throw new Error(
    `provisionUserMiner: ${address} underfunded after ${MAX_FAUCET_DRIPS} faucet drips ` +
      `(${balance} < ${USER_MINER_MIN_BALANCE_MIST} MIST)`,
  );
}

/**
 * Kill ONE handle + ALL its descendants. On Windows this MUST be a tree-kill: the
 * relay spawns mediasoup C++ worker subprocesses that orphan under a plain
 * proc.kill() and keep holding the RTC UDP ranges (10000-10300) → the NEXT run
 * collides. Node-on-Windows also maps SIGTERM to TerminateProcess (no graceful
 * handler runs anyway), so we go straight to `taskkill /T /F` (mirrors the
 * project's existing `sui start` "needs taskkill /T" durable). NOTE: because
 * Windows teardown is a forced TerminateProcess, graceful on-chain deregistration
 * cannot run there — acceptable for a throwaway demo localnet. On POSIX, keep the
 * graceful SIGTERM → grace → SIGKILL escalation.
 */
async function killHandle(h: ProcessHandle, logger: Logger): Promise<void> {
  if (h.killed || h.proc.exitCode !== null || h.proc.pid === undefined) return;
  h.killed = true;

  if (process.platform === 'win32') {
    logger.info({ module: MODULE, action: 'teardown', context: { name: h.spec.name, pid: h.proc.pid } }, `taskkill /T /F ${h.spec.name} (tree)`);
    await new Promise<void>((res) => {
      const tk = spawn('taskkill', ['/PID', String(h.proc.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
      tk.once('exit', () => res());
      tk.once('error', () => res()); // taskkill missing / already dead — best effort, never throw
    });
    return;
  }

  logger.info({ module: MODULE, action: 'teardown', context: { name: h.spec.name, pid: h.proc.pid } }, `SIGTERM ${h.spec.name}`);
  h.proc.kill('SIGTERM');
  const exited = await new Promise<boolean>((res) => {
    const timer = setTimeout(() => res(false), TEARDOWN_GRACE_MS);
    h.proc.once('exit', () => {
      clearTimeout(timer);
      res(true);
    });
  });
  if (!exited) {
    logger.warn({ module: MODULE, action: 'teardown', context: { name: h.spec.name } }, `SIGKILL ${h.spec.name} (graceful exit timed out)`);
    h.proc.kill('SIGKILL');
  }
}

/** Tear down all handles in reverse-spawn order (tree-kill per platform; never throws). */
export async function teardownFleet(handles: readonly ProcessHandle[], logger: Logger): Promise<void> {
  for (const h of [...handles].reverse()) {
    await killHandle(h, logger);
  }
}
