/**
 * Multi-CP Voting Live (N=5) — Phase C (GĐ2) Task C3: the NATIVE 13-process
 * launcher. Spawns the full local fleet against an already-staged localnet and
 * proves it ALL-UP healthy, then tears it down. This is the launcher SKELETON:
 * it does NOT run the live demo flows (#6 role vote / #7 pairing) — those are
 * C4, which EXTENDS main() at the clearly-marked seam below.
 *
 * THE FLEET (13 processes — the genuine N=5 substrate seed-multicp writes):
 *   wave 1  cp-0..cp-4         5 cp-daemon   (role-vote loops — MUST be up first)
 *   wave 2  val-0..val-3       4 validator   (pre-registered infra: VALIDATOR_CAP_ID set)
 *           relay-0,relay-1    2 relay
 *           sig-0              1 signaling
 *   wave 3  user-miner         1 validator-daemon in VOTING mode (the vote subject)
 *
 * WHY THE ORDER (load-bearing for determinism): all 5 CPs must be healthy BEFORE
 * the user-miner registers, so every role-vote loop is live and the genuine
 * 4-of-5 (required = ceil(5·2/3)) quorum can form. Infra (validators/relays/sig)
 * comes up in parallel between them; the user-miner is spawned LAST.
 *
 * KEY MATRIX FACTS (verified against the daemon entrypoints — see per-field
 * comments + the C3 env-matrix spec):
 *   - Per-process CWD `.run/<role>-<i>/` is the ONLY isolation for the relative
 *     `.cursors/` event-poller state (no env override exists). Because CWD ≠ repo
 *     root, the spawn ENTRY must be an ABSOLUTE path to apps/<app>/src/index.ts and
 *     ALL env is passed explicitly (dotenv's CWD-relative .env discovery won't fire).
 *   - cp-daemon CAP_TOKEN_QUORUM_THRESHOLD defaults to '2' (index.ts:934) → we set
 *     '1' (the cap-token SIGNATURE quorum is orthogonal to the on-chain role-vote
 *     quorum this lane proves; '1' needs no QUORUM_STATE_OBJECT_ID — threshold<2
 *     skips that check). TURN_RPC_TOKEN / QUORUM_CLAIMS_ENABLED stay unset (demo).
 *   - The user-miner has NO slot in the keys file → the launcher self-provisions it
 *     (generate + faucet-fund) and runs it with REGISTRATION_MODE=voting and
 *     VALIDATOR_CAP_ID ABSENT (presence ⇒ voting skipped; auto-register.ts:40,56).
 *
 * SCOPE: connects to an ALREADY-RUNNING localnet with the `multi-cp-live` package
 * published + seeded (seed-multicp.ts already ran → .run/multicp-keys.json exists,
 * the published *_OBJECT_ID set is in env). It does NOT boot `sui start`, publish,
 * or seed. Run from the worktree root against a staged localnet on :9000:
 *   pnpm exec tsx scripts/demo/run-multicp-voting.ts
 *
 * Env levers: MULTICP_KEYS_PATH (default <worktree>/.run/multicp-keys.json),
 * FAUCET_URL / SUI_NETWORK / the published *_OBJECT_ID set (same as seed-multicp.ts),
 * KEEP_ALIVE=1 (leave the fleet running after the all-up check — for C4 to chain off).
 *
 * Fails LOUD: a missing $CFG var, an underfunded user-miner, or any daemon that
 * never reaches /healthz=alive throws; an uncaught throw in main() exits non-zero
 * (already-spawned children are torn down first).
 *
 * Structured logging only (shared pino Logger). No console.log.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import type { SuiClient } from '@mysten/sui/client';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  type Logger,
} from '../../packages/shared/src/index.ts'; // relative SOURCE import — scripts/ sits OUTSIDE the pnpm workspace graph (mirrors seed-multicp.ts:56 / escrow-driver.ts:61).
import type { MultiCpKeysFile } from './seed-multicp.ts'; // TYPE-ONLY: elided at runtime → seed-multicp.ts's unguarded top-level main() is NOT executed on import.

const MODULE = 'run-multicp-voting';

// ── paths (cwd-independent; resolved from this file via import.meta.url) ──

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // …/scripts/demo
const WORKTREE_ROOT = resolve(SCRIPT_DIR, '..', '..'); // …/dvconf-daemons-multicp
const RUN_DIR = join(WORKTREE_ROOT, '.run');
const KEYS_PATH = process.env['MULTICP_KEYS_PATH'] ?? join(RUN_DIR, 'multicp-keys.json');

type App = 'cp-daemon' | 'validator-daemon' | 'relay' | 'signaling';

/** Absolute path to a daemon entry (foreign CWD ⇒ MUST be absolute; the spec's R6). */
function entryFor(app: App): string {
  return join(WORKTREE_ROOT, 'apps', app, 'src', 'index.ts');
}
/** Absolute per-process CWD that isolates the relative `.cursors/` (the ONLY isolation). */
function cwdFor(name: string): string {
  return join(RUN_DIR, name);
}

// ── the genuine N=5 substrate (must match seed-multicp.ts) ───────────────

const EXPECTED_CPS = 5;
const EXPECTED_VALIDATORS = 4;
const EXPECTED_RELAYS = 2;
const EXPECTED_SIGNALING = 1;

// ── port allocation (no collisions; demo profile = canary/TURN/quorum off) ──

const CP_HEALTHZ_BASE = 8091; // cp-0..4 → 8091..8095
const VALIDATOR_HEALTHZ_BASE = 8101; // val-0..3 → 8101..8104
const USER_MINER_HEALTHZ_PORT = 8105;
const SIGNALING_PORT = 8080; // published port (hardcoded — keep exactly ONE signaling)
const SIGNALING_HEALTHZ_PORT = 8082;
const RELAY_WS_BASE = 4000; // relay-k WS → 4000, 4010
const RELAY_METRICS_BASE = 4001; // relay-k /metrics + /healthz → 4001, 4011
const RELAY_PORT_STRIDE = 10;
const RELAY_RTC_MIN_BASE = 10000; // relay-k mediasoup UDP → 10000, 10200
const RELAY_RTC_MAX_BASE = 10100; // → 10100, 10300
const RELAY_PIPE_LOW_BASE = 40000; // relay-k inter-relay pipe → 40000, 40200
const RELAY_PIPE_HIGH_BASE = 40100; // → 40100, 40300
const RELAY_RANGE_STRIDE = 200;

/**
 * The 10 published-config vars loadNetworkConfig REQUIRES (any missing ⇒ a child
 * throws on startup). Every child inherits these; the launcher fails loud here
 * BEFORE any spawn if baseEnv omits one.
 */
const REQUIRED_CFG_VARS = [
  'PACKAGE_ID',
  'NETWORK_REGISTRY_ID',
  'MINER_STORE_ID',
  'CP_REGISTRY_ID',
  'RELAY_REGISTRY_ID',
  'VALIDATOR_REGISTRY_ID',
  'USER_REGISTRY_ID',
  'ROOM_MANAGER_ID',
  'SIGNALING_REGISTRY_ID',
  'ROLE_VOTE_BOX_ID',
] as const;

/**
 * Role-identity env keys. At spawn time these are SCRUBBED from the inherited
 * process.env before layering each spec's env, so a value leaked from a prior
 * step (e.g. the controller exported CP_KEYPAIR for seeding) can NEVER bleed into
 * the wrong role — critically, it keeps VALIDATOR_CAP_ID off the user-miner
 * (presence there ⇒ voting silently skipped).
 */
const IDENTITY_ENV_KEYS = [
  'CP_KEYPAIR',
  'CP_CAP_ID',
  'SUI_PRIVATE_KEY',
  'VALIDATOR_CAP_ID',
  'PRIVATE_KEY',
  'MINER_CAP_ID',
  'SIGNALING_KEYPAIR',
] as const;

// ── ProcessSpec (the pure plan's unit) ───────────────────────────────────

/** Launch wave — drives the load-bearing spawn ordering (cp → infra → user-miner). */
export type SpawnOrder = 'cp' | 'infra' | 'user-miner';

export interface ProcessSpec {
  /** Stable per-process name, e.g. 'cp-0', 'val-2', 'relay-1', 'user-miner', 'sig-0'. */
  name: string;
  /** Which daemon binary under apps/<app>/src/index.ts. */
  app: App;
  /** Absolute path to the daemon entry (foreign CWD ⇒ must be absolute). */
  entry: string;
  /** Absolute, per-process CWD that isolates the relative `.cursors/`. */
  cwd: string;
  /** Fully-resolved child env: the shared $CFG + this process's role matrix. */
  env: Record<string, string>;
  /** TCP/HTTP port whose /healthz is polled for readiness (relay = METRICS_PORT). */
  healthzPort: number;
  /** Launch wave. */
  order: SpawnOrder;
}

/**
 * Build the shared published-config env every child inherits. Validates the 10
 * REQUIRED vars (throws loud, naming the missing one), then adds the two derived
 * levers: SUI_NETWORK (default 'localnet' → http://127.0.0.1:9000) and the
 * CP_REGISTRY_OBJECT_ID alias cp-daemon reads (index.ts:974).
 */
function buildSharedCfg(baseEnv: Record<string, string | undefined>): Record<string, string> {
  const cfg: Record<string, string> = {};
  for (const k of REQUIRED_CFG_VARS) {
    const v = baseEnv[k];
    if (v === undefined || v === '') {
      throw new Error(
        `buildLaunchPlan: required published-config var ${k} is missing from baseEnv ` +
          `(seed/publish must export the 10 *_ID vars before launch)`,
      );
    }
    cfg[k] = v;
  }
  cfg['SUI_NETWORK'] = baseEnv['SUI_NETWORK'] ?? 'localnet';
  cfg['CP_REGISTRY_OBJECT_ID'] = cfg['CP_REGISTRY_ID']!; // cp-daemon alias (index.ts:974).
  return cfg;
}

/**
 * PURE matrix builder — the fragile heart of C3. Maps the seeded keys file + a
 * fresh user-miner key + the published-config baseEnv into 13 fully-specified
 * ProcessSpecs (distinct ports, distinct CWDs, correct per-role identity + cap
 * env, user-miner voting-mode specifics). Touches NO network and spawns NOTHING,
 * so it is unit-testable in isolation.
 */
export function buildLaunchPlan(
  keys: MultiCpKeysFile,
  userMinerSecretKey: string,
  baseEnv: Record<string, string | undefined>,
): ProcessSpec[] {
  // Fail loud unless the keys file is the genuine N=5 substrate — anything else
  // would mis-map ports (e.g. a 5th validator would collide with the user-miner
  // on 8105) or fail to form the 4-of-5 quorum.
  if (keys.cps.length !== EXPECTED_CPS) {
    throw new Error(`buildLaunchPlan: expected ${EXPECTED_CPS} cps, got ${keys.cps.length}`);
  }
  if (keys.validators.length !== EXPECTED_VALIDATORS) {
    throw new Error(`buildLaunchPlan: expected ${EXPECTED_VALIDATORS} validators, got ${keys.validators.length}`);
  }
  if (keys.relays.length !== EXPECTED_RELAYS) {
    throw new Error(`buildLaunchPlan: expected ${EXPECTED_RELAYS} relays, got ${keys.relays.length}`);
  }
  if (keys.signaling.length !== EXPECTED_SIGNALING) {
    throw new Error(`buildLaunchPlan: expected ${EXPECTED_SIGNALING} signaling, got ${keys.signaling.length}`);
  }

  const cfg = buildSharedCfg(baseEnv);
  const specs: ProcessSpec[] = [];

  // ── wave 1 — 5 cp-daemons (role-vote loops up FIRST) ──
  keys.cps.forEach((cp, i) => {
    const healthzPort = CP_HEALTHZ_BASE + i;
    specs.push({
      name: `cp-${i}`,
      app: 'cp-daemon',
      entry: entryFor('cp-daemon'),
      cwd: cwdFor(`cp-${i}`),
      env: {
        ...cfg,
        CP_KEYPAIR: cp.secretKey,
        CP_CAP_ID: cp.capId, // set ⇒ skips on-chain CP self-register (already seeded)
        CP_HEALTHZ_PORT: String(healthzPort),
        CAP_TOKEN_QUORUM_THRESHOLD: '1', // KISS: orthogonal to the role-vote quorum (=4); '1' needs no QUORUM_STATE_OBJECT_ID
        ROLE_VOTING_INTERVAL_MS: '30000',
        HEARTBEAT_INTERVAL_MS: '30000',
        POLL_INTERVAL_MS: '10000', // R9: ease :9000 RPC pressure under a 13-process boot (5 CPs poll)
        REVOTE_SCAN_INTERVAL_EPOCHS: '5',
      },
      healthzPort,
      order: 'cp',
    });
  });

  // ── wave 2a — 4 infra validators (pre-registered: VALIDATOR_CAP_ID set ⇒ no vote) ──
  keys.validators.forEach((val, j) => {
    const healthzPort = VALIDATOR_HEALTHZ_BASE + j;
    specs.push({
      name: `val-${j}`,
      app: 'validator-daemon',
      entry: entryFor('validator-daemon'),
      cwd: cwdFor(`val-${j}`),
      env: {
        ...cfg,
        SUI_PRIVATE_KEY: val.secretKey,
        VALIDATOR_CAP_ID: val.capId, // set ⇒ registration skipped (auto-register.ts:40)
        VALIDATOR_HEALTHZ_PORT: String(healthzPort),
        VALIDATOR_HEARTBEAT_INTERVAL_MS: '30000',
        MEASUREMENT_INTERVAL_MS: '60000',
        // CANARY_* / BENCH_LATENCY unset → no canary loop, no coverage server (8102), no .bench write.
      },
      healthzPort,
      order: 'infra',
    });
  });

  // ── wave 2b — 2 relays ──
  keys.relays.forEach((relay, k) => {
    const wsPort = RELAY_WS_BASE + RELAY_PORT_STRIDE * k;
    const metricsPort = RELAY_METRICS_BASE + RELAY_PORT_STRIDE * k;
    const rtcMin = RELAY_RTC_MIN_BASE + RELAY_RANGE_STRIDE * k;
    const rtcMax = RELAY_RTC_MAX_BASE + RELAY_RANGE_STRIDE * k;
    const pipeLow = RELAY_PIPE_LOW_BASE + RELAY_RANGE_STRIDE * k;
    const pipeHigh = RELAY_PIPE_HIGH_BASE + RELAY_RANGE_STRIDE * k;
    specs.push({
      name: `relay-${k}`,
      app: 'relay',
      entry: entryFor('relay'),
      cwd: cwdFor(`relay-${k}`),
      env: {
        ...cfg,
        PRIVATE_KEY: relay.secretKey,
        MINER_CAP_ID: relay.capId, // set ⇒ skip auto-register (auto-register.ts:96)
        WS_PORT: String(wsPort),
        METRICS_PORT: String(metricsPort),
        RTC_MIN_PORT: String(rtcMin),
        RTC_MAX_PORT: String(rtcMax),
        PIPE_PORT_RANGE: `${pipeLow}-${pipeHigh}`,
        RELAY_ENDPOINT_URL: `ws://127.0.0.1:${wsPort}`,
        ANNOUNCED_IP: '127.0.0.1',
        REGION: 'local',
        RMS_ACTIVE_FORWARD: '0',
        HEARTBEAT_INTERVAL_MS: '30000',
        POLL_INTERVAL_MS: '5000',
        // ENABLE_TURN_DELIVERY unset (demo) → no CP_DAEMON_RPC_URL/TURN_RPC_TOKEN needed.
      },
      healthzPort: metricsPort, // relay serves /healthz on the metrics port (index.ts:933)
      order: 'infra',
    });
  });

  // ── wave 2c — 1 signaling (exactly one; published port 8080, no override) ──
  const sig = keys.signaling[0]!; // length asserted === 1 above
  specs.push({
    name: 'sig-0',
    app: 'signaling',
    entry: entryFor('signaling'),
    cwd: cwdFor('sig-0'),
    env: {
      ...cfg,
      SIGNALING_KEYPAIR: sig.secretKey,
      MINER_CAP_ID: sig.capId, // set ⇒ skip register (auto-register.ts:97)
      SIGNALING_PORT: String(SIGNALING_PORT),
      SIGNALING_HEALTHZ_PORT: String(SIGNALING_HEALTHZ_PORT),
      ENDPOINT_URL: `ws://127.0.0.1:${SIGNALING_PORT}`,
      REGION: 'local',
      HEARTBEAT_INTERVAL_MS: '30000',
      RELAY_ENDPOINT_POLL_INTERVAL_MS: '5000',
    },
    healthzPort: SIGNALING_HEALTHZ_PORT,
    order: 'infra',
  });

  // ── wave 3 — USER-miner LAST (validator-daemon binary, VOTING mode, NO cap) ──
  specs.push({
    name: 'user-miner',
    app: 'validator-daemon',
    entry: entryFor('validator-daemon'),
    cwd: cwdFor('user-miner'),
    env: {
      ...cfg,
      SUI_PRIVATE_KEY: userMinerSecretKey, // fresh funded key (NOT in the keys file)
      REGISTRATION_MODE: 'voting', // triggers self-apply (auto-register.ts:56,120)
      VALIDATOR_HEALTHZ_PORT: String(USER_MINER_HEALTHZ_PORT),
      VALIDATOR_HEARTBEAT_INTERVAL_MS: '30000',
      MEASUREMENT_INTERVAL_MS: '60000',
      // VALIDATOR_CAP_ID DELIBERATELY ABSENT — presence ⇒ voting skipped (auto-register.ts:40).
    },
    healthzPort: USER_MINER_HEALTHZ_PORT,
    order: 'user-miner',
  });

  return specs;
}

// ── impure orchestration (spawn / health / teardown) ─────────────────────

const HEALTHZ_TIMEOUT_MS = 120_000; // all-up budget per the spec (≥120s)
const HEALTHZ_POLL_MS = 500;
const TEARDOWN_GRACE_MS = 5_000;

/** Faucet poll for the self-provisioned user-miner (mirrors seed-bootstrap.ts:78-79). */
const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const FAUCET_POLL_MS = 1_000;
const FAUCET_TIMEOUT_MS = 90_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
 * Spawn one daemon. Entry is absolute; CWD is the isolated `.run/<role>`; env is
 * the inherited process.env with ALL identity keys SCRUBBED, then the spec's
 * fully-resolved env layered on top (so no leaked identity can bleed across
 * roles). stdout/stderr are kept as a small in-memory tail for failure reporting.
 */
export function spawnProcess(spec: ProcessSpec, logger: Logger): ProcessHandle {
  mkdirSync(spec.cwd, { recursive: true });

  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of IDENTITY_ENV_KEYS) delete base[k]; // scrub leaked role identities
  const env: NodeJS.ProcessEnv = { ...base, ...spec.env };

  const proc = spawn(process.execPath, ['--import', 'tsx/esm', spec.entry], {
    cwd: spec.cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  const handle: ProcessHandle = { spec, proc, tail: [], killed: false };
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

/** GET /healthz once; resolve true only on HTTP 200 with {status:"alive"}. */
async function probeHealthz(port: number): Promise<boolean> {
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/healthz`);
    if (resp.status !== 200) return false;
    const body = (await resp.json()) as { status?: string };
    return body.status === 'alive';
  } catch {
    return false; // not yet accepting / connection refused
  }
}

/**
 * Dual-gate readiness for one process: (1) TCP waitForPort on the healthz port
 * (reuses run-smoke's proven poller), then (2) GET /healthz until 200
 * {status:"alive"}. Rejects early if the child exits before ready, and on timeout
 * surfaces the daemon name + last log tail (a voting-mode hang is otherwise silent).
 */
export async function waitHealthy(handle: ProcessHandle, timeoutMs = HEALTHZ_TIMEOUT_MS): Promise<void> {
  const { spec, proc } = handle;
  const deadline = Date.now() + timeoutMs;

  const exited = new Promise<never>((_, reject) => {
    proc.once('exit', (code, signal) => {
      reject(new Error(`${spec.name} exited (code=${code}, signal=${signal ?? 'none'}) before ready`));
    });
  });

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
  }
}

/** Read + parse the seeded multi-CP keys file (fails loud if absent/malformed). */
function loadKeys(path: string): MultiCpKeysFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`run-multicp-voting: keys file not found at ${path} — run seed-multicp.ts first (${err instanceof Error ? err.message : String(err)})`);
  }
  return JSON.parse(raw) as MultiCpKeysFile;
}

/**
 * Self-provision the USER-miner keypair: generate a fresh Ed25519 key, faucet-fund
 * it, and poll getCoins until the gas coin is indexed (mirrors seed-bootstrap.ts
 * fundAddress). Returns the bech32 secretKey for the daemon's SUI_PRIVATE_KEY.
 */
async function provisionUserMiner(client: SuiClient, logger: Logger): Promise<string> {
  const kp = Ed25519Keypair.generate();
  const address = kp.getPublicKey().toSuiAddress();
  await requestSuiFromFaucetV2({ host: FAUCET_URL, recipient: address });
  const deadline = Date.now() + FAUCET_TIMEOUT_MS;
  for (;;) {
    const { data } = await client.getCoins({ owner: address });
    if (data.length > 0) break;
    if (Date.now() > deadline) {
      throw new Error(`provisionUserMiner: faucet gas never indexed for ${address} within ${FAUCET_TIMEOUT_MS}ms`);
    }
    await sleep(FAUCET_POLL_MS);
  }
  logger.info({ module: MODULE, action: 'provision_user_miner', context: { address } }, 'user-miner funded (gas coin indexed)');
  return kp.getSecretKey();
}

/** SIGTERM all handles in reverse-spawn order, wait ≤5s each, then SIGKILL stragglers. */
export async function teardownFleet(handles: readonly ProcessHandle[], logger: Logger): Promise<void> {
  for (const h of [...handles].reverse()) {
    if (h.killed || h.proc.exitCode !== null) continue;
    h.killed = true;
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
}

/**
 * Bring up the whole fleet in the 3 ordered waves with per-wave health gates:
 *   1. all 5 CPs → wait healthy (every role-vote loop live before the miner votes)
 *   2. infra (4 val + 2 relay + 1 sig) in parallel → wait healthy
 *   3. user-miner LAST → wait healthy
 * On any failure, tears down whatever was already spawned and rethrows (no orphans).
 */
export async function launchFleet(logger: Logger): Promise<ProcessHandle[]> {
  const config = loadNetworkConfig(); // also validates the published-config env is present
  const client = createSuiClient(config.rpcUrl);

  const keys = loadKeys(KEYS_PATH);
  const userMinerSecretKey = await provisionUserMiner(client, logger);
  const plan = buildLaunchPlan(keys, userMinerSecretKey, process.env);

  const cpSpecs = plan.filter((s) => s.order === 'cp');
  const infraSpecs = plan.filter((s) => s.order === 'infra');
  const userMinerSpec = plan.find((s) => s.order === 'user-miner')!;

  const handles: ProcessHandle[] = [];
  try {
    // wave 1 — CPs first.
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'cp', count: cpSpecs.length } }, 'wave 1: spawning 5 cp-daemons');
    const cpHandles = cpSpecs.map((s) => spawnProcess(s, logger));
    handles.push(...cpHandles);
    await Promise.all(cpHandles.map((h) => waitHealthy(h)));

    // wave 2 — infra in parallel.
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'infra', count: infraSpecs.length } }, 'wave 2: spawning 4 validators + 2 relays + 1 signaling');
    const infraHandles = infraSpecs.map((s) => spawnProcess(s, logger));
    handles.push(...infraHandles);
    await Promise.all(infraHandles.map((h) => waitHealthy(h)));

    // wave 3 — user-miner last.
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'user-miner' } }, 'wave 3: spawning user-miner (voting mode)');
    const umHandle = spawnProcess(userMinerSpec, logger);
    handles.push(umHandle);
    await waitHealthy(umHandle);

    return handles;
  } catch (err) {
    logger.error({ module: MODULE, action: 'launch_failed', context: { spawned: handles.length } }, 'fleet launch failed — tearing down');
    await teardownFleet(handles, logger);
    throw err;
  }
}

async function main(): Promise<void> {
  const logger = createLogger(MODULE);
  logger.info(
    { module: MODULE, action: 'start', context: { keysPath: KEYS_PATH, worktreeRoot: WORKTREE_ROOT } },
    'run-multicp-voting starting — launching the 13-process N=5 fleet',
  );

  const handles = await launchFleet(logger);
  logger.info(
    { module: MODULE, action: 'all_healthy', context: { count: handles.length } },
    `all ${handles.length} processes healthy (5 cp + 4 val + 2 relay + 1 sig + 1 user-miner)`,
  );

  // ───────────────────────── C4 SEAM ─────────────────────────
  // Task C4 inserts the live demo flows HERE (between launch and teardown):
  //   #6 role-vote: assert the 4-of-5 role-vote quorum on the user-miner
  //   #7 pairing:   drive escrow-driver.ts → assert the 4-of-5 pairing quorum
  // For C3 (skeleton) we only prove all-up health, then tear down — unless
  // KEEP_ALIVE is set, so C4 can keep this fleet running and chain off it.
  // ────────────────────────────────────────────────────────────

  if (process.env['KEEP_ALIVE'] === '1') {
    logger.info({ module: MODULE, action: 'keep_alive' }, 'KEEP_ALIVE=1 — leaving the fleet running (SIGINT to stop)');
    return;
  }
  await teardownFleet(handles, logger);
  logger.info({ module: MODULE, action: 'done', context: { count: handles.length } }, 'fleet torn down — C3 all-up health check complete');
}

// Run only when invoked directly so the unit test can import buildLaunchPlan
// without launching (mirrors escrow-driver.ts:233 / provision-room.ts:91).
if (process.argv[1]?.endsWith('run-multicp-voting.ts')) {
  main().catch((err) => {
    // Fail LOUD: a non-zero exit lets the controller gate on the all-up check.
    process.stderr.write(`run-multicp-voting: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(1);
  });
}
