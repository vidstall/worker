// p2-block-scheduler.ts — counterbalanced block scheduler for the P2 VM-only
// cloud-WAN E2EE OFF/ON window (plan: docs/superpowers/plans/
// 2026-07-16-p2-vm-only-cloud-wan-e2ee-window.md).
//
// PREDECLARED SCHEDULE (do not improvise):
//   6 blocks x (5 OFF + 5 ON) sessions = 12 sub-runs of 5 sessions each.
//   Within-block arm order ALTERNATES by block parity:
//     block 0 OFF->ON, 1 ON->OFF, 2 OFF->ON, 3 ON->OFF, 4 OFF->ON, 5 ON->OFF.
//   subRunStart(s) = baseEpoch + s * (5*windowMs + gapMs),  s in 0..11.
//   Rooms: `p2b<block><arm>-<i>` (i = 0..4); makeups `p2b<block><arm>m-<j>`.
//   Rooms are NEVER named `wan-*` (no collision with the historical wan-0..29).
//
// TWO-MACHINE CONTRACT: both client VMs run this with the SAME --base-epoch;
// each derives every sub-run start + room name independently from that anchor
// (same mechanism as wan-split-driver's --start-epoch). No coordination channel.
//
// Per sub-run it spawns wan-split-driver.ts (tsx child) with
//   --sessions 5 --start-epoch <subRunStart> --e2ee <arm> --room-prefix p2b<block><arm>-
// and TEES the child's full stdout/stderr to
//   bench-output/p2-scheduler-<role>-s<s>-b<block>-<arm>.log
// (the per-session E2EE-attachment evidence of record). ALL sub-runs run even if
// one fails; the process exits non-zero if ANY sub-run's driver exited non-zero,
// and the final line on stdout is a JSON report of per-sub-run status.
//
// Usage (both machines, same --base-epoch / --window-ms / --gap-ms / --makeup):
//   tsx scripts/bench/p2-block-scheduler.ts --role produce --base-epoch <ms> \
//     --relay ws://<k1>:4000 --bench http://<k1>:8081 \
//     --page http://localhost:5173/bench/wan-measure-page.html \
//     [--window-ms 25000] [--gap-ms 60000] [--makeup <block>:<arm>:<count> ...]
//
// Makeups (plan: at most 2 per arm-block; appended AFTER the 12 main slots in
// argv order, each in its own slot s = 12+k with rooms `p2b<block><arm>m-<j>`).
// Pass IDENTICAL --makeup flags on both machines.

import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Arm = 'off' | 'on';
export type SchedulerRole = 'produce' | 'consume';

export const SUB_RUNS = 12;
export const BLOCKS = 6;
export const SESSIONS_PER_SUB_RUN = 5;
export const DEFAULT_WINDOW_MS = 25_000;
export const DEFAULT_GAP_MS = 60_000;

export interface SubRun {
  /** Sub-run index 0..11 (makeups continue 12..). */
  s: number;
  /** Block 0..5 (= floor(s/2) for the 12 main sub-runs). */
  block: number;
  arm: Arm;
  /** Absolute wall-clock start passed verbatim as --start-epoch. */
  startEpochMs: number;
  /** Sessions in this sub-run (5 for main sub-runs; --makeup count for makeups). */
  sessions: number;
  /** Room-name prefix passed verbatim as --room-prefix. */
  roomPrefix: string;
  makeup: boolean;
}

/**
 * Arm of sub-run `s` per the predeclared alternating table: even blocks lead
 * with OFF, odd blocks lead with ON; the second sub-run of a block is the
 * other arm. Pure so both machines and the tests share one implementation.
 */
export function armFor(s: number): Arm {
  const block = Math.floor(s / 2);
  const leading: Arm = block % 2 === 0 ? 'off' : 'on';
  const trailing: Arm = leading === 'off' ? 'on' : 'off';
  return s % 2 === 0 ? leading : trailing;
}

/**
 * The 12 predeclared main sub-runs. PURE — both client machines derive the
 * identical schedule from the shared base epoch, and the tests assert against
 * this exact function.
 */
export function computeSchedule(baseEpoch: number, windowMs: number, gapMs: number): SubRun[] {
  const slotMs = SESSIONS_PER_SUB_RUN * windowMs + gapMs;
  const out: SubRun[] = [];
  for (let s = 0; s < SUB_RUNS; s += 1) {
    const block = Math.floor(s / 2);
    const arm = armFor(s);
    out.push({
      s,
      block,
      arm,
      startEpochMs: baseEpoch + s * slotMs,
      sessions: SESSIONS_PER_SUB_RUN,
      roomPrefix: `p2b${block}${arm}-`,
      makeup: false,
    });
  }
  return out;
}

export interface MakeupSpec {
  block: number;
  arm: Arm;
  count: number;
}

/** Parse one `--makeup <block>:<arm>:<count>` value, strictly. */
export function parseMakeupSpec(raw: string): MakeupSpec {
  const m = /^([0-5]):(off|on):([12])$/.exec(raw);
  if (m === null) {
    throw new Error(
      `--makeup must be <block 0-5>:<off|on>:<count 1-2> (plan caps makeups at 2 per arm-block), got "${raw}"`,
    );
  }
  return { block: Number(m[1]!), arm: m[2] as Arm, count: Number(m[3]!) };
}

/**
 * Makeup sub-runs: appended AFTER the 12 main slots, in argv order, each in its
 * own slot (s = 12+k) so the timing math stays the single slotMs formula. Both
 * machines must pass IDENTICAL --makeup flags to stay clock-aligned. Rooms get
 * the `m` marker: `p2b<block><arm>m-<j>` (j = 0..count-1 from the driver).
 */
export function computeMakeupRuns(
  baseEpoch: number,
  windowMs: number,
  gapMs: number,
  makeups: MakeupSpec[],
): SubRun[] {
  const slotMs = SESSIONS_PER_SUB_RUN * windowMs + gapMs;
  return makeups.map((m, k) => ({
    s: SUB_RUNS + k,
    block: m.block,
    arm: m.arm,
    startEpochMs: baseEpoch + (SUB_RUNS + k) * slotMs,
    sessions: m.count,
    roomPrefix: `p2b${m.block}${m.arm}m-`,
    makeup: true,
  }));
}

export interface SchedulerOpts {
  role: SchedulerRole;
  baseEpochMs: number;
  windowMs: number;
  gapMs: number;
  relay: string;
  bench: string;
  page: string;
  makeups: MakeupSpec[];
}

export function parseSchedulerArgs(argv: string[]): SchedulerOpts {
  // Same strict style as wan-split-driver.parseArgs: unknown flags, missing
  // values, and duplicates all ERROR instead of silently changing the schedule.
  const valueFlags = new Set([
    '--role', '--base-epoch', '--relay', '--bench', '--page',
    '--window-ms', '--gap-ms', '--makeup',
  ]);
  const values = new Map<string, string>();
  const makeups: MakeupSpec[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (!flag.startsWith('--')) throw new Error(`unexpected positional argument: ${flag}`);
    if (!valueFlags.has(flag)) throw new Error(`unknown option: ${flag}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    i += 1;
    if (flag === '--makeup') {
      makeups.push(parseMakeupSpec(value)); // repeatable, argv order preserved
      continue;
    }
    if (values.has(flag)) throw new Error(`duplicate option: ${flag}`);
    values.set(flag, value);
  }

  const req = (k: string): string => {
    const v = values.get(`--${k}`);
    if (v === undefined) throw new Error(`--${k} is REQUIRED`);
    return v;
  };
  const num = (k: string, d: number, minimum: number): number => {
    const raw = values.get(`--${k}`) ?? String(d);
    if (!/^\d+$/.test(raw)) throw new Error(`--${k} must be a strict non-negative integer (got "${raw}").`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < minimum) throw new Error(`--${k} must be >= ${minimum} (got "${raw}").`);
    return n;
  };

  const role = req('role');
  if (role !== 'produce' && role !== 'consume') {
    throw new Error(`--role must be produce or consume (got "${role}").`);
  }

  const baseRaw = req('base-epoch');
  if (!/^\d+$/.test(baseRaw)) {
    throw new Error(
      '--base-epoch <epoch-ms> is REQUIRED and must be IDENTICAL on both machines ' +
        '(the shared wall-clock anchor for all 12 sub-runs).',
    );
  }
  const baseEpochMs = Number(baseRaw);
  if (!Number.isSafeInteger(baseEpochMs) || baseEpochMs <= 0) {
    throw new Error('--base-epoch must be a positive safe integer epoch-ms value');
  }

  return {
    role,
    baseEpochMs,
    windowMs: num('window-ms', DEFAULT_WINDOW_MS, 1),
    gapMs: num('gap-ms', DEFAULT_GAP_MS, 0),
    // relay/bench/page are REQUIRED (no localhost fallbacks): a WAN sub-run that
    // silently pointed at a default would burn a whole predeclared block.
    relay: req('relay'),
    bench: req('bench'),
    page: req('page'),
    makeups,
  };
}

interface SubRunResult {
  s: number;
  block: number;
  arm: Arm;
  makeup: boolean;
  startEpochMs: number;
  sessions: number;
  roomPrefix: string;
  log: string;
  exitCode: number | null;
  status: 'ok' | 'failed';
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER_ENTRY = join(HERE, 'wan-split-driver.ts');
const OUT_DIR = 'bench-output';

/**
 * Run ONE sub-run's wan-split-driver as a tsx child, teeing its combined
 * stdout/stderr to `logPath` AND this process's stdout (evidence of record +
 * live operator visibility). Resolves with the child's exit code — never throws
 * for a non-zero child so the remaining sub-runs always run.
 */
function runSubRun(o: SchedulerOpts, r: SubRun, logPath: string): Promise<number | null> {
  const args = [
    '--import', 'tsx/esm', DRIVER_ENTRY,
    '--role', o.role,
    '--start-epoch', String(r.startEpochMs),
    '--sessions', String(r.sessions),
    '--window-ms', String(o.windowMs),
    '--e2ee', r.arm,
    '--room-prefix', r.roomPrefix,
    '--relay', o.relay,
    '--bench', o.bench,
    '--page', o.page,
  ];
  return new Promise((resolve, reject) => {
    const log = createWriteStream(logPath, { flags: 'w' });
    const child = spawn(process.execPath, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tee = (chunk: Buffer): void => {
      log.write(chunk);
      process.stdout.write(chunk);
    };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    child.once('error', (err) => {
      log.end();
      reject(err); // spawn itself failed (tsx/node missing) — that IS fatal
    });
    child.once('exit', (code) => {
      log.end();
      resolve(code);
    });
  });
}

async function main(): Promise<void> {
  const o = parseSchedulerArgs(process.argv.slice(2));
  const runs = [
    ...computeSchedule(o.baseEpochMs, o.windowMs, o.gapMs),
    ...computeMakeupRuns(o.baseEpochMs, o.windowMs, o.gapMs, o.makeups),
  ];

  // Print the full derived schedule up front so both operators can eyeball that
  // the two machines derived the SAME sub-run starts + room prefixes.
  console.log(
    `p2-block-scheduler: role=${o.role} baseEpoch=${o.baseEpochMs} (${new Date(o.baseEpochMs).toISOString()})\n` +
      `  window=${o.windowMs}ms gap=${o.gapMs}ms slot=${SESSIONS_PER_SUB_RUN * o.windowMs + o.gapMs}ms ` +
      `subRuns=${runs.length} (${SUB_RUNS} main + ${o.makeups.length} makeup)`,
  );
  for (const r of runs) {
    console.log(
      `  s${r.s} block=${r.block} arm=${r.arm}${r.makeup ? ' MAKEUP' : ''} ` +
        `rooms=${r.roomPrefix}<0..${r.sessions - 1}> start=${new Date(r.startEpochMs).toISOString()}`,
    );
  }
  if (Date.now() > o.baseEpochMs) {
    console.log(
      `  WARNING: base epoch already in the past by ${Date.now() - o.baseEpochMs}ms — ` +
        'elapsed windows will be SKIPPED by the driver. Pick a later --base-epoch on BOTH machines.',
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const results: SubRunResult[] = [];
  for (const r of runs) {
    const logPath = join(OUT_DIR, `p2-scheduler-${o.role}-s${r.s}-b${r.block}-${r.arm}.log`);
    console.log(`\n=== sub-run s${r.s} (block ${r.block}, arm ${r.arm}${r.makeup ? ', makeup' : ''}) -> ${logPath} ===`);
    const exitCode = await runSubRun(o, r, logPath);
    const status: SubRunResult['status'] = exitCode === 0 ? 'ok' : 'failed';
    console.log(`=== sub-run s${r.s} exited ${exitCode} (${status}) ===`);
    results.push({
      s: r.s, block: r.block, arm: r.arm, makeup: r.makeup,
      startEpochMs: r.startEpochMs, sessions: r.sessions, roomPrefix: r.roomPrefix,
      log: logPath, exitCode, status,
    });
  }

  const failed = results.filter((r) => r.status === 'failed');
  // The FINAL stdout line is the machine-readable per-sub-run report.
  console.log(JSON.stringify({
    role: o.role,
    baseEpochMs: o.baseEpochMs,
    windowMs: o.windowMs,
    gapMs: o.gapMs,
    subRuns: results,
    failedSubRuns: failed.map((r) => r.s),
    ok: failed.length === 0,
  }, null, 2));

  if (failed.length > 0) {
    process.exitCode = 1; // ran ALL sub-runs, but the window is incomplete
  }
}

// Guard: only run as entrypoint, not when imported by tests.
if (process.argv[1] && (process.argv[1].endsWith('p2-block-scheduler.ts') || process.argv[1].endsWith('p2-block-scheduler.js'))) {
  main().catch((err) => {
    console.error('p2-block-scheduler fatal:', err);
    process.exitCode = 1;
  });
}
