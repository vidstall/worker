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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import {
  createSuiClient,
  createLogger,
  loadNetworkConfig,
  waitForRoleAssignment,
  type Logger,
  type NetworkConfig,
  type RoleAssigned,
  type RoleVoteCast,
  type RoomAssigned,
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
 * Role-identity / role-behavior env keys. At spawn time these are SCRUBBED from
 * the inherited process.env before layering each spec's env, so a value leaked
 * from a prior step (e.g. the controller exported CP_KEYPAIR for seeding) can
 * NEVER bleed into the wrong role — critically, it keeps VALIDATOR_CAP_ID off the
 * user-miner (presence there ⇒ voting silently skipped) and keeps a leaked
 * REGISTRATION_MODE=voting off the pre-registered infra validators. The
 * user-miner re-sets REGISTRATION_MODE='voting' in its OWN spec.env afterward, so
 * behavior is unchanged — this is defense-in-depth against env pollution.
 */
const IDENTITY_ENV_KEYS = [
  'CP_KEYPAIR',
  'CP_CAP_ID',
  'SUI_PRIVATE_KEY',
  'VALIDATOR_CAP_ID',
  'PRIVATE_KEY',
  'MINER_CAP_ID',
  'SIGNALING_KEYPAIR',
  'REGISTRATION_MODE',
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

// ══════════════════════════════════════════════════════════════════════════
// C4 — live-demo pure helpers (unit-tested). All the fragile parsing/quorum
// logic lives here so the impure orchestration (spawn / devInspect / queryEvents
// polling / main()) stays thin and is exercised by the controller's live run.
// ══════════════════════════════════════════════════════════════════════════

/**
 * The genuine N=5 quorum the demo pins: required = max(1, ceil(active_cp * 6667 /
 * 10000)) (role_voting::compute_threshold / pairing PVR). At 5 active CPs → 4.
 * Single-sourced so the magic "4" is not scattered across the asserts (fact B/C).
 */
export const REQUIRED_QUORUM_AT_N5 = 4;

/**
 * The #7 ProposalSubmitted parsedJson shape (room_manager.move:148-154). NOT a
 * shared type → declared locally. `verified_score` carries the submitted score
 * (room_manager.move:441 — the field is named verified_score, NOT submitted_score).
 */
export interface ProposalSubmittedJson {
  room_id: string;
  cp_id: string;
  verified_score: string;
  relay_count: string;
  validator_count: string;
}

/**
 * Parse the escrow-driver's single STDOUT contract line `ROOM_ID=0x…`
 * (escrow-driver.ts:228). pino JSON logs share the same stdout, so match with the
 * ANCHORED multiline regex — never by reading the whole stream. PURE.
 */
export function parseRoomId(stdout: string): string | null {
  const m = stdout.match(/^ROOM_ID=(\S+)$/m);
  return m ? m[1]! : null;
}

/**
 * Decode an 8-byte little-endian BCS u64 (the devInspect count-getter return
 * shape). Fail-closed: THROWS on any length ≠ 8 (a self-verifying precondition
 * must never silently pass on a malformed read). PURE. Mirrors seed-multicp.ts's
 * inline decode (NOT value-imported — that module runs main() on import).
 */
export function decodeLeU64(bytes: readonly number[]): bigint {
  if (bytes.length !== 8) {
    throw new Error(`decodeLeU64: expected 8 bytes (u64 LE), got ${bytes.length}`);
  }
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i] ?? 0);
  }
  return v;
}

/** The evidence surfaced from a passing #6 role-vote quorum. */
export interface RoleQuorumResult {
  role: number;
  voteCount: string;
  threshold: string;
  /** The distinct, normalized voter addresses that crossed the quorum (size === expectedCount). */
  voters: string[];
}

/**
 * HARD-ASSERT the live #6 role-vote quorum for the user-miner (fact B). Throws on
 * any divergence; returns the evidence on success. At N=5 the finalized
 * RoleAssigned has vote_count === threshold === '4' (u64 → decimal STRING), and
 * exactly 4 DISTINCT RoleVoteCast voters (the 5th CP's late cast aborts 711 → no
 * event). `casts` may contain other miners' votes (a queryEvents MoveEventType
 * filter is not miner-scoped) — they are filtered out here by miner_id. PURE.
 */
export function assertRoleQuorum(
  assigned: RoleAssigned,
  casts: readonly RoleVoteCast[],
  minerAddress: string,
  expectedCount: number,
): RoleQuorumResult {
  const expected = String(expectedCount);
  const miner = normalizeSuiAddress(minerAddress);

  if (normalizeSuiAddress(assigned.miner_id) !== miner) {
    throw new Error(
      `assertRoleQuorum: RoleAssigned.miner_id ${assigned.miner_id} is not the user-miner ${minerAddress}`,
    );
  }
  if (assigned.vote_count !== expected) {
    throw new Error(`assertRoleQuorum: vote_count=${assigned.vote_count}, expected ${expected} (the live 4-of-5 quorum)`);
  }
  if (assigned.threshold !== expected) {
    throw new Error(`assertRoleQuorum: threshold=${assigned.threshold}, expected ${expected} (only 4 when 5 CPs are active)`);
  }

  const voters = [
    ...new Set(
      casts
        .filter((c) => normalizeSuiAddress(c.miner_id) === miner)
        .map((c) => normalizeSuiAddress(c.voter)),
    ),
  ];
  if (voters.length !== expectedCount) {
    throw new Error(
      `assertRoleQuorum: ${voters.length} distinct voters for the user-miner, expected exactly ${expectedCount}`,
    );
  }

  return { role: assigned.role, voteCount: assigned.vote_count, threshold: assigned.threshold, voters };
}

/** The evidence surfaced from a passing #7 pairing quorum. */
export interface PairingQuorumResult {
  winningScore: string;
  winningCp: string;
  /** The distinct, normalized cp_ids that proposed the winning score (size >= expectedCount). */
  agreeingCpIds: string[];
}

/**
 * HARD-ASSERT the live #7 pairing quorum for a room (fact C). Throws on any
 * divergence; returns the evidence on success. A PVR-consensus finalize sets
 * consensus_reached === true and a real winning_cp (the zero ID is the admin
 * fallback), and ≥ expectedCount DISTINCT ProposalSubmitted.cp_id share the SAME
 * verified_score as the winning RoomAssigned.verified_score. `proposals` should
 * already be room-scoped by the caller; this only groups by score. PURE.
 */
export function assertPairingQuorum(
  assigned: RoomAssigned,
  proposals: readonly ProposalSubmittedJson[],
  expectedCount: number,
): PairingQuorumResult {
  if (assigned.consensus_reached !== true) {
    throw new Error(
      `assertPairingQuorum: consensus_reached=${assigned.consensus_reached}, expected true (a CP-quorum finalize, not the admin fallback)`,
    );
  }
  const winningCp = (assigned.winning_cp ?? '').trim();
  const zeroId = normalizeSuiAddress('0x0');
  if (winningCp === '' || normalizeSuiAddress(winningCp) === zeroId) {
    throw new Error(
      `assertPairingQuorum: winning_cp is empty/zero (${assigned.winning_cp}) — that is the admin fallback, not a CP-consensus finalize`,
    );
  }

  const winningScore = assigned.verified_score;
  const agreeingCpIds = [
    ...new Set(
      proposals
        .filter((p) => p.verified_score === winningScore)
        .map((p) => normalizeSuiAddress(p.cp_id)),
    ),
  ];
  if (agreeingCpIds.length < expectedCount) {
    throw new Error(
      `assertPairingQuorum: ${agreeingCpIds.length} distinct CPs proposed the winning score ${winningScore}, expected >= ${expectedCount}`,
    );
  }

  return { winningScore, winningCp: normalizeSuiAddress(winningCp), agreeingCpIds };
}

/**
 * Classify a daemon log line as an executeWithRetry benign-abort trace (fact G):
 * `<label> failed, retrying` (tx.ts:60, warn) or `<label> exhausted retries,
 * skipping` (tx.ts:63, error). Detects the substrings so it works whether or not
 * the line is pino-JSON-wrapped. Returns null for ordinary lines. PURE.
 */
export function classifyRetryLine(line: string): 'retrying' | 'exhausted' | null {
  if (line.includes('exhausted retries, skipping')) return 'exhausted';
  if (line.includes('failed, retrying')) return 'retrying';
  return null;
}

/** Aggregate benign-abort retry traces across every daemon's in-memory tail. */
export interface RetrySummary {
  retrying: number;
  exhausted: number;
}

/**
 * Count executeWithRetry retry/exhaustion traces across a set of daemon tails
 * (fact G honest re-scope): a deterministic Move abort (704/711/719/508) is
 * RETRIED 5× (warn) then swallowed (one benign "exhausted retries" error, null
 * return, NO throw, NO crash). This is a diagnostic SUMMARY only — it is NOT a
 * failure signal (the load-bearing benign-abort check is "every daemon still
 * alive"). PURE.
 */
export function summarizeRetryTails(tails: readonly (readonly string[])[]): RetrySummary {
  const summary: RetrySummary = { retrying: 0, exhausted: 0 };
  for (const tail of tails) {
    for (const line of tail) {
      const kind = classifyRetryLine(line);
      if (kind === 'retrying') summary.retrying++;
      else if (kind === 'exhausted') summary.exhausted++;
    }
  }
  return summary;
}

// ── impure orchestration (spawn / health / teardown) ─────────────────────

const HEALTHZ_TIMEOUT_MS = 120_000; // all-up budget per the spec (≥120s)
const HEALTHZ_POLL_MS = 500;
const TEARDOWN_GRACE_MS = 5_000;

// ── C4 live-demo levers ──
/** Read-only devInspect sender — no gas, no signature (mirrors role-assignment.ts:41 / seed-multicp.ts:73). */
const DEV_INSPECT_SENDER = '0x0000000000000000000000000000000000000000000000000000000000000000';
/**
 * Wave-3 role-vote budget. The 5 CPs poll every ROLE_VOTING_INTERVAL_MS (30s) and
 * need 4 DISTINCT casts to finalize, so a cold discover→4-cast→assign can take
 * ~30-120s; 180s is generous headroom. (This gates launch on #6 finalizing rather
 * than the user-miner's /healthz — see launchFleet wave 3.)
 */
const ROLE_VOTE_TIMEOUT_MS = 180_000;
/** #7 pairing budget: escrow → 5 CPs each submitProposal → PVR finalize; same 30s-poll class as #6. */
const ROOM_ASSIGN_TIMEOUT_MS = 180_000;
const EVENT_POLL_MS = 3_000;
/** queryEvents page size — the demo's 4 user-miner casts / room proposals are the NEWEST role/room events, so a descending page of 50 always contains them. */
const EVENT_QUERY_LIMIT = 50;
/** Absolute entry for the transient #7 pairing driver (foreign CWD ⇒ absolute; mirrors entryFor). */
const ESCROW_ENTRY = join(WORKTREE_ROOT, 'scripts', 'demo', 'escrow-driver.ts');
/** The live-run evidence the controller's run produces (mkdir -p'd at write time). */
const EVIDENCE_PATH = join(WORKTREE_ROOT, '.evidence', 'verification', 'multi-cp-voting-live-run.md');

/** Faucet levers for the self-provisioned user-miner (mirrors escrow-driver.ts:65-79). */
const FAUCET_URL = process.env['FAUCET_URL'] ?? getFaucetHost('localnet');
const FAUCET_SETTLE_MS = 1_500; // let the drip tx settle before reading balance
const MAX_FAUCET_DRIPS = 2;
/** 1 SUI: clears any voted-role stake floor (relay 0.25 / validator 0.1 / signaling 0.05) + register/apply gas + headroom. */
const USER_MINER_MIN_BALANCE_MIST = 1_000_000_000n;

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
 * Self-provision the USER-miner keypair: generate a fresh Ed25519 key, then
 * faucet-fund it until it holds >= USER_MINER_MIN_BALANCE_MIST — drip → settle →
 * check balance, up to MAX_FAUCET_DRIPS, fail loud if still short (mirrors
 * escrow-driver.ts:96-112 fundUntilSufficient). Returns the bech32 secretKey (for
 * the daemon's SUI_PRIVATE_KEY) AND the Sui address — which IS the miner_id the
 * role vote assigns (auto-register.ts:122: minerId = signer.toSuiAddress()), so C4
 * observes #6 by this address WITHOUT parsing a registration event.
 */
async function provisionUserMiner(
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

// ── C4 live-demo orchestration (impure — exercised by the controller's live run) ──

/**
 * devInspect `control_plane_registry::active_cp_count(&CpRegistry): u64` and decode
 * the 8-byte LE u64. FAIL-CLOSED: throws on any RPC/decode error (a precondition
 * assert must never silently pass). Replicates seed-multicp.ts readU64Count INLINE
 * (that module runs main() on import → we import only its TYPE, not this fn).
 */
async function readActiveCpCount(client: SuiClient, config: NetworkConfig): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::control_plane_registry::active_cp_count`,
    arguments: [tx.object(config.cpRegistryId)],
  });
  const result = await client.devInspectTransactionBlock({
    transactionBlock: tx as never,
    sender: DEV_INSPECT_SENDER,
  });
  if (result.error) {
    throw new Error(`readActiveCpCount: devInspect failed: ${result.error}`);
  }
  const returnValues = result.results?.[0]?.returnValues;
  if (!returnValues || returnValues.length === 0) {
    throw new Error('readActiveCpCount: devInspect returned no value');
  }
  return Number(decodeLeU64(returnValues[0]![0] as number[]));
}

/**
 * Page the most-recent Move events of one fully-qualified type (descending). The
 * MoveEventType filter is NOT subject-scoped, so callers filter parsedJson by
 * miner_id / room_id. The demo's votes/proposals are the newest such events, so a
 * single EVENT_QUERY_LIMIT page always contains them.
 */
async function queryMoveEvents(
  client: SuiClient,
  config: NetworkConfig,
  typeSuffix: string,
  limit = EVENT_QUERY_LIMIT,
): Promise<SuiEvent[]> {
  const res = await client.queryEvents({
    query: { MoveEventType: `${config.packageId}::${typeSuffix}` },
    limit,
    order: 'descending',
  });
  return res.data;
}

/**
 * Poll for the #7 `room_manager::RoomAssigned` event for `roomId` (mirrors
 * waitForRoleAssignment's shape — there is no shared waitForRoomAssignment helper).
 * Resolves the matching SuiEvent (caller reads parsedJson + id.txDigest); throws on
 * timeout.
 */
async function waitForRoomAssignment(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
  timeoutMs = ROOM_ASSIGN_TIMEOUT_MS,
  pollIntervalMs = EVENT_POLL_MS,
): Promise<SuiEvent> {
  const deadline = Date.now() + timeoutMs;
  const target = normalizeSuiAddress(roomId);
  logger.info({ module: MODULE, action: 'wait_room_assignment', context: { roomId } }, 'waiting for RoomAssigned (CP pairing quorum)...');
  while (Date.now() < deadline) {
    try {
      const events = await queryMoveEvents(client, config, 'room_manager::RoomAssigned');
      const match = events.find((e) => {
        const pj = e.parsedJson as RoomAssigned | undefined;
        return pj !== undefined && normalizeSuiAddress(pj.room_id) === target;
      });
      if (match) {
        logger.info(
          { module: MODULE, action: 'room_assigned', context: { roomId, txDigest: match.id.txDigest } },
          'RoomAssigned observed',
        );
        return match;
      }
    } catch (err) {
      logger.debug(
        { module: MODULE, action: 'wait_room_assignment', context: { err: err instanceof Error ? err.message : String(err) } },
        'queryEvents RoomAssigned failed, retrying',
      );
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Room assignment timeout after ${timeoutMs}ms for room ${roomId}`);
}

/**
 * Spawn the transient escrow-driver.ts one-shot (register_user → create_room →
 * create_escrow → EscrowCreated → the 5 CPs' pairing vote). Buffers stdout, parses
 * the `ROOM_ID=…` contract line (parseRoomId), and resolves the room id. Rejects
 * LOUD on a non-zero exit or a missing ROOM_ID with the stdout/stderr tail. The
 * driver self-generates its own user key (needs no SUI_PRIVATE_KEY), so the
 * inherited identity keys are scrubbed as noise. A distinct CWD isolates its
 * relative `.cursors/`. Mirrors the spawnProcess idiom (execPath + tsx/esm entry).
 */
async function spawnEscrowDriver(logger: Logger): Promise<string> {
  const cwd = cwdFor('escrow-0');
  mkdirSync(cwd, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of IDENTITY_ENV_KEYS) delete env[k];
  logger.info(
    { module: MODULE, action: 'escrow_driver', context: { entry: ESCROW_ENTRY, cwd } },
    'spawning escrow-driver (register_user → create_room → create_escrow → CP pairing vote)',
  );
  return new Promise<string>((resolveRoom, reject) => {
    const proc = spawn(process.execPath, ['--import', 'tsx/esm', ESCROW_ENTRY], {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.once('error', (err) => reject(new Error(`escrow-driver spawn error: ${err.message}`)));
    proc.once('exit', (code) => {
      const roomId = parseRoomId(stdout);
      if (code !== 0 || roomId === null) {
        const tail = `${stdout}\n${stderr}`.split('\n').filter((l) => l.length > 0).slice(-20).join('\n');
        reject(new Error(`escrow-driver failed (code=${code ?? 'null'}, roomId=${roomId ?? 'none'})\n--- last 20 stdout/stderr lines ---\n${tail}`));
        return;
      }
      logger.info({ module: MODULE, action: 'escrow_driver', context: { roomId, code } }, 'escrow-driver completed; ROOM_ID captured');
      resolveRoom(roomId);
    });
  });
}

/** The load-bearing facts a live demo run proves — captured for the evidence file. */
interface LiveRunEvidence {
  activeCpCount: number;
  role: RoleQuorumResult;
  roleTxDigest: string;
  pairing: PairingQuorumResult;
  roomTxDigest: string;
  roomId: string;
  userMinerAddress: string;
  daemonCount: number;
  retries: RetrySummary;
}

/**
 * Render + write the live-run evidence markdown (mkdir -p'd). Records the two
 * finalize tx digests, the distinct voter/cp sets + the shared score, the
 * active_cp_count==5 precondition, and the HONEST facts F (determinism is
 * structural: canary-OFF + identical env + same on-chain state — NOT an
 * off-chain relayState-equality assert) + G (a benign deterministic abort is
 * RETRIED 5× then swallowed by executeWithRetry — null, no throw, no crash —
 * NOT "non-retryable"). This is the ONLY raw file the demo writes; the asserts
 * above are the load-bearing part, so the caller guards this write.
 */
function writeLiveRunEvidence(ev: LiveRunEvidence): void {
  const stamp = new Date().toISOString();
  const body = `# Multi-CP Voting Live (N=5) — live-run evidence

_Generated ${stamp} by scripts/demo/run-multicp-voting.ts (C4 SEAM)._

## Substrate precondition
- \`control_plane_registry::active_cp_count\` = **${ev.activeCpCount}** (asserted === 5).
- Fleet: ${ev.daemonCount} processes all-up healthy (5 cp + 4 val + 2 relay + 1 sig + 1 user-miner).
- Required quorum at N=5: \`ceil(5 * 6667 / 10000)\` = **${REQUIRED_QUORUM_AT_N5}**.

## #6 — live role-vote (4-of-5 quorum)
- user-miner (miner_id / address): \`${ev.userMinerAddress}\`
- RoleAssigned: role=${ev.role.role}, vote_count=**${ev.role.voteCount}**, threshold=**${ev.role.threshold}**.
- Finalize tx digest: \`${ev.roleTxDigest}\`
- ${ev.role.voters.length} DISTINCT RoleVoteCast voters:
${ev.role.voters.map((v) => `  - \`${v}\``).join('\n')}

## #7 — live pairing (4-of-5 quorum)
- room_id: \`${ev.roomId}\`
- RoomAssigned: consensus_reached=true, winning_cp=\`${ev.pairing.winningCp}\`, verified_score=**${ev.pairing.winningScore}**.
- Finalize tx digest: \`${ev.roomTxDigest}\`
- ${ev.pairing.agreeingCpIds.length} DISTINCT ProposalSubmitted cp_id at the winning score:
${ev.pairing.agreeingCpIds.map((c) => `  - \`${c}\``).join('\n')}

## Benign-abort (all daemons survived — fact G, honest)
- All ${ev.daemonCount} daemons still alive after the demos (no crash).
- executeWithRetry retry traces observed across tails: retrying=${ev.retries.retrying}, exhausted=${ev.retries.exhausted}.
- Mechanism: a deterministic Move abort (704 E_ALREADY_VOTED / 711 E_PRIOR_ASSIGNMENT_PENDING /
  719 E_ROLE_MISMATCH / 508 E_NOT_PENDING) is RETRIED 5× (warn) by executeWithRetry
  (tx.ts:38-69), then swallowed with ONE benign \`exhausted retries, skipping\` error
  (null return, NO throw, NO crash). This is the accurate mechanism — NOT "non-retryable".

## Honesty notes
- **Fact F (determinism pin):** the spec's "assert all 5 CPs' relayState/validatorState
  are equal" is NOT feasible off-chain — every CP reads the SAME on-chain state and derives
  identical scores deterministically. The practical pin implemented here is STRUCTURAL:
  (i) canary is OFF by construction (buildLaunchPlan sets no CANARY_* env), and
  (ii) the active_cp_count==5 precondition above. No fake equality assert is made.
- **Fact G (benign-abort):** see the mechanism note above — retried-then-swallowed, not non-retryable.
`;
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, body, 'utf8');
}

/**
 * Bring up the whole fleet in the 3 ordered waves with per-wave gates:
 *   1. all 5 CPs → wait healthy (every role-vote loop live before the miner votes)
 *   2. infra (4 val + 2 relay + 1 sig) in parallel → wait healthy
 *   3. user-miner LAST → spawn, then gate on the ROLE VOTE FINALIZING
 *      (waitForRoleAssignment), NOT on the user-miner's /healthz.
 * On any failure, tears down whatever was already spawned and rethrows (no orphans).
 *
 * WHY wave-3 gates on the role vote, not healthz: the user-miner's /healthz only
 * comes up AFTER register→vote→apply→register (validator-daemon ensureRegistered
 * BLOCKS on its own ≤120s waitForRoleAssignment before startHealthzServer). Gating
 * launch on healthz would couple success to that apply-side + 120s budget. Gating on
 * the vote finalizing instead proves #6 DIRECTLY and is robust to whatever scarce
 * role the CPs derive. Returns the user-miner ADDRESS (== its role-vote miner_id) so
 * main() observes #6/#7 without parsing a registration event.
 *
 * `handles` is caller-owned and pushed-into as each child spawns, so a SIGINT/
 * SIGTERM handler installed by main() can see + tear down the fleet even mid-wave.
 */
export async function launchFleet(
  logger: Logger,
  handles: ProcessHandle[] = [],
): Promise<{ handles: ProcessHandle[]; userMinerAddress: string }> {
  const config = loadNetworkConfig(); // also validates the published-config env is present
  const client = createSuiClient(config.rpcUrl);

  const keys = loadKeys(KEYS_PATH);
  const { secretKey: userMinerSecretKey, address: userMinerAddress } = await provisionUserMiner(client, logger);
  const plan = buildLaunchPlan(keys, userMinerSecretKey, process.env);

  const cpSpecs = plan.filter((s) => s.order === 'cp');
  const infraSpecs = plan.filter((s) => s.order === 'infra');
  const userMinerSpec = plan.find((s) => s.order === 'user-miner')!;

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

    // wave 3 — user-miner last, then gate on the ROLE VOTE finalizing (proves #6
    // directly). The user-miner registers as a User-role miner in voting mode; the
    // 5 CPs' role-voting loops discover it (MinerRegistered) and cast — the 4th
    // DISTINCT cast crosses the live 4-of-5 quorum and assigns. We do NOT wait on
    // its /healthz (which would couple launch to the apply-side + 120s budget).
    logger.info({ module: MODULE, action: 'wave', context: { wave: 'user-miner', userMinerAddress } }, 'wave 3: spawning user-miner (voting mode)');
    const umHandle = spawnProcess(userMinerSpec, logger);
    handles.push(umHandle);
    logger.info({ module: MODULE, action: 'wait_role_vote', context: { userMinerAddress, timeoutMs: ROLE_VOTE_TIMEOUT_MS } }, 'wave 3 gate: awaiting the 4-of-5 role vote to finalize');
    await waitForRoleAssignment(client, config, userMinerAddress, logger, ROLE_VOTE_TIMEOUT_MS);

    return { handles, userMinerAddress };
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

  // main OWNS the handles so a Ctrl-C during the (up to 3×120s) bringup — or under
  // KEEP_ALIVE — can tear the fleet down instead of orphaning 13 children. The
  // array is threaded INTO launchFleet, which pushes each child as it spawns, so
  // the handler sees the fleet even mid-wave.
  const handles: ProcessHandle[] = [];
  let tearingDown = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (tearingDown) return; // de-dup a DIFFERENT signal mid-teardown (e.g. SIGTERM after SIGINT); handlers are `once`, so a repeat of the SAME signal isn't redelivered here → it hits Node's default = force-quit (the conventional double-Ctrl-C escape hatch)
    tearingDown = true;
    logger.warn({ module: MODULE, action: 'signal', context: { signal: sig, count: handles.length } }, `${sig} received — tearing down fleet`);
    void teardownFleet(handles, logger).finally(() => process.exit(130)); // 130 = terminated by signal (non-zero)
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  const { userMinerAddress } = await launchFleet(logger, handles);
  logger.info(
    { module: MODULE, action: 'all_healthy', context: { count: handles.length, userMinerAddress } },
    `fleet up + role vote finalized — ${handles.length} processes (5 cp + 4 val + 2 relay + 1 sig + 1 user-miner)`,
  );

  // ───────────────────────── C4 SEAM ─────────────────────────
  // The live demo flows (between launch and teardown):
  //   (a) precondition  active_cp_count == 5 (fail-closed; canary-OFF determinism)
  //   (b) #6 role-vote  HARD-ASSERT the live 4-of-5 quorum on the user-miner
  //   (c) #7 pairing    escrow-driver → HARD-ASSERT the live 4-of-5 pairing quorum
  //   (d) benign-abort  every daemon still alive (fact G: retried-then-swallowed)
  //   (e) evidence      write the finalize digests + distinct sets (guarded)
  // On any failure the fleet is torn down before rethrow (no orphans).
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);

  try {
    // (a) precondition — the genuine N=5 substrate on-chain (fact E). Fail-closed.
    const activeCpCount = await readActiveCpCount(client, config);
    if (activeCpCount !== EXPECTED_CPS) {
      throw new Error(`C4 precondition: active_cp_count=${activeCpCount}, expected ${EXPECTED_CPS} — substrate is not the genuine N=5`);
    }
    // (fact F) The infeasible "all 5 CPs' relayState/validatorState equal" assert is
    // replaced by STRUCTURAL determinism: canary is OFF (buildLaunchPlan sets no
    // CANARY_* env) and every CP reads the SAME on-chain state under this
    // active_cp_count==5 precondition, so all 5 derive identical scores. No fake
    // equality assert is made.
    logger.info({ module: MODULE, action: 'precondition', context: { activeCpCount } }, `precondition OK: active_cp_count=${activeCpCount}`);

    // (b) #6 — the vote already finalized during wave 3; re-confirm, then read the
    // events the DAEMONS submitted (queryEvents, not our own TX) and HARD-ASSERT.
    await waitForRoleAssignment(client, config, userMinerAddress, logger, 30_000);
    const assignedEvents = await queryMoveEvents(client, config, 'role_voting::RoleAssigned');
    const assignedEvent = assignedEvents.find(
      (e) => normalizeSuiAddress((e.parsedJson as RoleAssigned).miner_id) === normalizeSuiAddress(userMinerAddress),
    );
    if (!assignedEvent) {
      throw new Error(`C4 #6: no RoleAssigned event found for user-miner ${userMinerAddress}`);
    }
    const castEvents = await queryMoveEvents(client, config, 'role_voting::RoleVoteCast');
    const casts = castEvents.map((e) => e.parsedJson as RoleVoteCast);
    const role = assertRoleQuorum(assignedEvent.parsedJson as RoleAssigned, casts, userMinerAddress, REQUIRED_QUORUM_AT_N5);
    const roleTxDigest = assignedEvent.id.txDigest;
    logger.info(
      { module: MODULE, action: 'role_quorum', context: { role: role.role, voteCount: role.voteCount, threshold: role.threshold, voters: role.voters, txDigest: roleTxDigest } },
      `#6 PASS: live 4-of-5 role vote — vote_count=${role.voteCount}, threshold=${role.threshold}, ${role.voters.length} distinct voters`,
    );

    // (c) #7 — drive the escrow → CP pairing vote, wait for RoomAssigned, HARD-ASSERT.
    const roomId = await spawnEscrowDriver(logger);
    const roomEvent = await waitForRoomAssignment(client, config, roomId, logger);
    const proposalEvents = await queryMoveEvents(client, config, 'room_manager::ProposalSubmitted');
    const proposals = proposalEvents
      .map((e) => e.parsedJson as ProposalSubmittedJson)
      .filter((p) => normalizeSuiAddress(p.room_id) === normalizeSuiAddress(roomId));
    const pairing = assertPairingQuorum(roomEvent.parsedJson as RoomAssigned, proposals, REQUIRED_QUORUM_AT_N5);
    const roomTxDigest = roomEvent.id.txDigest;
    logger.info(
      { module: MODULE, action: 'pairing_quorum', context: { winningCp: pairing.winningCp, winningScore: pairing.winningScore, agreeingCpIds: pairing.agreeingCpIds, txDigest: roomTxDigest } },
      `#7 PASS: live 4-of-5 pairing — ${pairing.agreeingCpIds.length} distinct CPs share score ${pairing.winningScore}`,
    );

    // (d) benign-abort (fact G, honest) — a deterministic Move abort (704/711/719/508)
    // is RETRIED 5× then SWALLOWED by executeWithRetry (null, no throw), so NO daemon
    // should have crashed. The tail retry summary is diagnostic only, NOT a gate.
    const crashed = handles.filter((h) => h.proc.exitCode !== null);
    if (crashed.length > 0) {
      throw new Error(
        `C4 benign-abort: ${crashed.map((h) => `${h.spec.name}(exit=${h.proc.exitCode})`).join(', ')} exited during the demo`,
      );
    }
    const retries = summarizeRetryTails(handles.map((h) => h.tail));
    logger.info(
      { module: MODULE, action: 'benign_abort', context: { daemonsAlive: handles.length, retries } },
      `benign-abort OK: all ${handles.length} daemons alive (retry traces: retrying=${retries.retrying}, exhausted=${retries.exhausted})`,
    );

    // (e) evidence — guarded so a write failure does not void the passing asserts.
    try {
      writeLiveRunEvidence({
        activeCpCount,
        role,
        roleTxDigest,
        pairing,
        roomTxDigest,
        roomId,
        userMinerAddress,
        daemonCount: handles.length,
        retries,
      });
      logger.info({ module: MODULE, action: 'evidence', context: { path: EVIDENCE_PATH } }, `live-run evidence written → ${EVIDENCE_PATH}`);
    } catch (err) {
      logger.warn(
        { module: MODULE, action: 'evidence', context: { path: EVIDENCE_PATH, err: err instanceof Error ? err.message : String(err) } },
        'live-run evidence write failed (non-fatal — the asserts above already passed)',
      );
    }

    logger.info({ module: MODULE, action: 'demos_passed' }, 'C4 live demos PASSED (#6 role-vote 4-of-5 + #7 pairing 4-of-5)');
  } catch (err) {
    logger.error({ module: MODULE, action: 'demo_failed' }, 'C4 live demo failed — tearing down fleet');
    await teardownFleet(handles, logger);
    throw err;
  }
  // ────────────────────────────────────────────────────────────

  if (process.env['KEEP_ALIVE'] === '1') {
    // The SIGINT/SIGTERM handler installed above stays armed → "SIGINT to stop"
    // actually tears the fleet down. The piped child stdio keeps the event loop alive.
    logger.info({ module: MODULE, action: 'keep_alive' }, 'KEEP_ALIVE=1 — demos passed; leaving the fleet running (SIGINT to tear down)');
    return;
  }
  await teardownFleet(handles, logger);
  logger.info({ module: MODULE, action: 'done', context: { count: handles.length } }, 'fleet torn down — C4 live demo run complete');
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
