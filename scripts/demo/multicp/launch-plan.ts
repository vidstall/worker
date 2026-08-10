/**
 * Multi-CP Voting Live (N=5) — launch-plan module. Extracted from
 * run-multicp-voting.ts (pure code movement, no behavior change): the shared
 * paths/constants + the PURE ProcessSpec matrix builder (buildLaunchPlan).
 * See run-multicp-voting.ts for the full launcher-level doc comment (fleet
 * shape, wave ordering, env-matrix facts).
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MultiCpKeysFile } from '../seed-multicp.ts'; // TYPE-ONLY: elided at runtime → seed-multicp.ts's unguarded top-level main() is NOT executed on import.

export const MODULE = 'run-multicp-voting';

// ── paths (cwd-independent; resolved from this file via import.meta.url) ──
// NOTE: this file lives in scripts/demo/multicp/, one directory deeper than
// the original scripts/demo/run-multicp-voting.ts, so SCRIPT_DIR climbs one
// extra level to keep WORKTREE_ROOT pointed at the same worktree root.

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)); // …/scripts/demo/multicp
export const WORKTREE_ROOT = resolve(SCRIPT_DIR, '..', '..', '..'); // …/dvconf-daemons-multicp
export const RUN_DIR = join(WORKTREE_ROOT, '.run');
export const KEYS_PATH = process.env['MULTICP_KEYS_PATH'] ?? join(RUN_DIR, 'multicp-keys.json');

export type App = 'cp-daemon' | 'validator-daemon' | 'relay';

/** Absolute path to a daemon entry (foreign CWD ⇒ MUST be absolute; the spec's R6). */
export function entryFor(app: App): string {
  return join(WORKTREE_ROOT, 'apps', app, 'src', 'index.ts');
}
/** Absolute per-process CWD that isolates the relative `.cursors/` (the ONLY isolation). */
export function cwdFor(name: string): string {
  return join(RUN_DIR, name);
}

// ── the genuine N=5 substrate (must match seed-multicp.ts) ───────────────

export const EXPECTED_CPS = 5;
const EXPECTED_VALIDATORS = 4;
const EXPECTED_RELAYS = 2;

// ── port allocation (no collisions; demo profile = canary/TURN/quorum off) ──

const CP_HEALTHZ_BASE = 8091; // cp-0..4 → 8091..8095
const VALIDATOR_HEALTHZ_BASE = 8101; // val-0..3 → 8101..8104
const USER_MINER_HEALTHZ_PORT = 8105;
const RELAY_WS_BASE = 4000; // relay-k WS → 4000, 4010
const RELAY_METRICS_BASE = 4001; // relay-k /metrics + /healthz → 4001, 4011
const RELAY_PORT_STRIDE = 10;
const RELAY_RTC_MIN_BASE = 10000; // relay-k mediasoup UDP → 10000, 10200
const RELAY_RTC_MAX_BASE = 10100; // → 10100, 10300
const RELAY_PIPE_LOW_BASE = 40000; // relay-k inter-relay pipe → 40000, 40200
const RELAY_PIPE_HIGH_BASE = 40100; // → 40100, 40300
const RELAY_RANGE_STRIDE = 200;

/**
 * The 9 published-config vars loadNetworkConfig REQUIRES (any missing ⇒ a child
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
  'ROLE_VOTE_BOX_ID',
] as const;

/**
 * Role-identity / role-behavior env keys. At spawn time these are SCRUBBED from
 * the inherited process.env before layering each spec's env, so a value leaked
 * from a prior step (e.g. the controller exported CP_KEYPAIR for seeding) can
 * NEVER bleed into the wrong role — critically, it keeps VALIDATOR_CAP_ID off the
 * user-miner (presence there ⇒ voting silently skipped) and keeps a leaked
 * REGISTRATION_MODE=voting off the pre-registered infra validators. The
 * user-miner re-sets REGISTRATION_MODE='voting' in its OWN spec.env afterward, so
 * behavior is unchanged — this is defense-in-depth against env pollution.
 */
export const IDENTITY_ENV_KEYS = [
  'CP_KEYPAIR',
  'CP_CAP_ID',
  'SUI_PRIVATE_KEY',
  'VALIDATOR_CAP_ID',
  'PRIVATE_KEY',
  'MINER_CAP_ID',
  'REGISTRATION_MODE',
] as const;

// ── ProcessSpec (the pure plan's unit) ───────────────────────────────────

/** Launch wave — drives the load-bearing spawn ordering (cp → infra → user-miner). */
export type SpawnOrder = 'cp' | 'infra' | 'user-miner';

export interface ProcessSpec {
  /** Stable per-process name, e.g. 'cp-0', 'val-2', 'relay-1', 'user-miner'. */
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
        POLL_INTERVAL_MS: '10000', // R9: ease :9000 RPC pressure under a 12-process boot (5 CPs poll)
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
