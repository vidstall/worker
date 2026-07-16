// p2-block-analysis.ts — block-aware ON-OFF analysis for the P2 matched
// cloud-WAN E2EE window (plan: docs/superpowers/plans/
// 2026-07-16-p2-vm-only-cloud-wan-e2ee-window.md, "Estimator, sample unit,
// exclusions").
//
// Estimator: REUSES join-g2g.ts's assembleOneWay VERBATIM (imported, not
// reimplemented) — per-session component medians summed as
//   encode_send + RTT_send/2 + RTT_recv/2 + jitterbuffer_recv + decode_recv
//   + present_recv + 12.5 ms residual (RESIDUAL_MS)
// so the P2 arms use the IDENTICAL estimator as STAR Lane-A (row 5).
//
// Sample unit: one session (one exclusive-create room, `p2b<block><arm>[m]-<i>`).
// Reported per arm: n / p50 / p95 / p99 (nearest-rank, replay.ts percentile) /
// mean / sd (sample, n-1). Per block x arm: median (mid / mean-of-two-mids) and
// the per-block ON-OFF delta of medians. Primary comparison: UNPAIRED
// ON-OFF Δmean and Δp95 of the per-session estimates, block retained as a
// stratum via the bootstrap.
//
// Stratified bootstrap CI: resample sessions WITH replacement within each
// arm x block stratum (stratum sizes preserved), 10,000 iterations, SEEDED
// mulberry32 PRNG — replay with the same seed is byte-identical. CI = 2.5/97.5
// nearest-rank percentiles of the bootstrap Δ distributions.
//
// FAILS LOUDLY (non-zero exit, no partial output) if any observed block has
// fewer than 5 valid sessions in either arm — the deficit list names each
// block/arm/n. Nothing is silently rebalanced (plan's makeup policy).
//
// Validity note: "valid" HERE = assembleOneWay emitted a complete component
// set for the session (plan validity predicate #1). Predicates #2 (per-ON-room
// E2EE attachment console evidence — lives in the p2-scheduler-*.log tees) and
// #3 (exclusive-create room in this window) are enforced OUTSIDE this script.
//
// Usage:
//   tsx scripts/bench/p2-block-analysis.ts <pooled.jsonl | split-dir> [--seed 20260716]
// A split-dir (from p2-arm-split.ts) is read via its p2-arm-off.jsonl +
// p2-arm-on.jsonl (NOT the per-block views, which would duplicate rows).

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleOneWay, type OneWayRow } from './join-g2g.js';
import { percentile } from './replay.js';
// Relative path (same as replay.ts) instead of the '@dvconf/shared' bare
// specifier: the bench scripts live outside every tsconfig, and a scoped
// `tsc --noEmit` cannot resolve the workspace alias (pre-existing condition in
// join-g2g.ts). Type-only either way — erased at runtime.
import type { LatencyEvent } from '../../packages/shared/src/index.js';

export type Arm = 'off' | 'on';

export const DEFAULT_SEED = 20260716;
export const DEFAULT_ITERATIONS = 10_000;
export const MIN_SESSIONS_PER_STRATUM = 5;

/** Same predicate as p2-arm-split.ts (kept in lockstep — Gate-1 room taxonomy). */
export const P2_ROOM_RE = /^p2b(\d)(off|on)m?-/;

/** Deterministic 32-bit PRNG (mulberry32) — seeded so bootstrap replay is byte-identical. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface P2SessionRow {
  roomId: string;
  block: number;
  arm: Arm;
  oneWayMs: number;
}

/** Parse pooled JSONL text into LatencyEvent-shaped rows; malformed lines counted, never fatal. */
export function eventsFromJsonl(raw: string): { events: LatencyEvent[]; malformed: number } {
  const events: LatencyEvent[] = [];
  let malformed = 0;
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as LatencyEvent);
    } catch {
      malformed += 1;
    }
  }
  return { events, malformed };
}

/**
 * Classify assembled per-session rows into arm x block strata by room name.
 * Rooms not matching the P2 taxonomy (canary, historical wan-*) are ignored and
 * listed. A room yielding MORE than one assembled flow row violates the
 * one-exclusive-room-per-session sample-unit contract -> loud failure.
 */
export function toP2Sessions(rows: OneWayRow[]): { sessions: P2SessionRow[]; ignoredRooms: string[] } {
  const sessions: P2SessionRow[] = [];
  const ignored = new Set<string>();
  const seenRooms = new Map<string, number>();
  for (const r of rows) {
    const m = P2_ROOM_RE.exec(r.roomId);
    if (m === null) {
      ignored.add(r.roomId);
      continue;
    }
    seenRooms.set(r.roomId, (seenRooms.get(r.roomId) ?? 0) + 1);
    sessions.push({ roomId: r.roomId, block: Number(m[1]!), arm: m[2] as Arm, oneWayMs: r.oneWayMs });
  }
  const dupes = [...seenRooms.entries()].filter(([, n]) => n > 1).map(([room, n]) => `${room} (${n} flows)`);
  if (dupes.length > 0) {
    throw new Error(
      `SAMPLE-UNIT VIOLATION: ${dupes.length} room(s) assembled to more than one flow row — ` +
        `one session must be one exclusive-create room. Offending: ${dupes.join(', ')}`,
    );
  }
  return { sessions, ignoredRooms: [...ignored].sort() };
}

/** Classic median: middle element, or mean of the two middles (matches join-g2g's component median). */
const medianOf = (values: number[]): number => {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};

const meanOf = (values: number[]): number => values.reduce((s, x) => s + x, 0) / values.length;

/** Sample standard deviation (n-1). */
const sdOf = (values: number[]): number => {
  if (values.length < 2) return 0;
  const mu = meanOf(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - mu) * (x - mu), 0) / (values.length - 1));
};

export interface ArmStats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  sd: number;
}

export interface BlockRow {
  block: number;
  nOff: number;
  nOn: number;
  medianOffMs: number;
  medianOnMs: number;
  deltaMedianOnMinusOffMs: number;
}

export interface P2AnalysisReport {
  estimator: string;
  sampleUnit: string;
  seed: number;
  iterations: number;
  blocks: number[];
  perArm: Record<Arm, ArmStats>;
  perBlock: BlockRow[];
  delta: {
    comparison: string;
    dMeanMs: number;
    dP95Ms: number;
  };
  bootstrap: {
    method: string;
    seed: number;
    iterations: number;
    ci95: {
      dMeanMs: { lo: number; hi: number };
      dP95Ms: { lo: number; hi: number };
    };
  };
  sessions: P2SessionRow[];
}

const armStats = (values: number[]): ArmStats => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 0.5), // nearest-rank (replay.ts family)
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    mean: meanOf(sorted),
    sd: sdOf(sorted),
  };
};

/**
 * The whole predeclared analysis. Throws (FAIL LOUDLY) if any observed block
 * has < MIN_SESSIONS_PER_STRATUM valid sessions in either arm, listing which.
 * Deterministic for a given (sessions, seed, iterations): strata are iterated
 * in fixed order (arm off->on, blocks ascending, sessions sorted by roomId) so
 * the PRNG consumption order — and therefore every number — replays exactly.
 */
export function analyzeP2(
  sessions: P2SessionRow[],
  seed: number = DEFAULT_SEED,
  iterations: number = DEFAULT_ITERATIONS,
): P2AnalysisReport {
  if (sessions.length === 0) throw new Error('no valid P2 sessions found in the input');

  // Strata: arm x block, sessions in DETERMINISTIC order (sorted by roomId) so
  // input file order can never change the bootstrap stream.
  const blocks = [...new Set(sessions.map((s) => s.block))].sort((a, b) => a - b);
  const strata = new Map<string, number[]>(); // `${arm}|${block}` -> oneWayMs[] (roomId-sorted)
  for (const arm of ['off', 'on'] as const) {
    for (const block of blocks) {
      const rows = sessions
        .filter((s) => s.arm === arm && s.block === block)
        .sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
      strata.set(`${arm}|${block}`, rows.map((r) => r.oneWayMs));
    }
  }

  // Completeness gate — every observed block needs >= 5 valid sessions in BOTH arms.
  const deficits: string[] = [];
  for (const block of blocks) {
    for (const arm of ['off', 'on'] as const) {
      const n = strata.get(`${arm}|${block}`)!.length;
      if (n < MIN_SESSIONS_PER_STRATUM) {
        deficits.push(`block ${block} arm ${arm}: ${n} valid session(s) < ${MIN_SESSIONS_PER_STRATUM}`);
      }
    }
  }
  if (deficits.length > 0) {
    throw new Error(
      `INCOMPLETE BLOCKS — refusing to analyze (plan: incomplete blocks are reported, ` +
        `never silently rebalanced):\n  ${deficits.join('\n  ')}`,
    );
  }

  const armValues: Record<Arm, number[]> = {
    off: blocks.flatMap((b) => strata.get(`off|${b}`)!),
    on: blocks.flatMap((b) => strata.get(`on|${b}`)!),
  };
  const perArm: Record<Arm, ArmStats> = { off: armStats(armValues.off), on: armStats(armValues.on) };

  const perBlock: BlockRow[] = blocks.map((block) => {
    const off = strata.get(`off|${block}`)!;
    const on = strata.get(`on|${block}`)!;
    const medianOffMs = medianOf(off);
    const medianOnMs = medianOf(on);
    return { block, nOff: off.length, nOn: on.length, medianOffMs, medianOnMs, deltaMedianOnMinusOffMs: medianOnMs - medianOffMs };
  });

  const dMeanMs = perArm.on.mean - perArm.off.mean;
  const dP95Ms = perArm.on.p95 - perArm.off.p95;

  // Stratified bootstrap: per iteration, per arm, resample each block stratum
  // with replacement at its own size, pool, then Δmean / Δp95 (ON-OFF).
  const rng = mulberry32(seed);
  const bootDMean: number[] = new Array<number>(iterations);
  const bootDP95: number[] = new Array<number>(iterations);
  const armPool = (arm: Arm): number[] => {
    const pooled: number[] = [];
    for (const block of blocks) {
      const stratum = strata.get(`${arm}|${block}`)!;
      for (let k = 0; k < stratum.length; k += 1) {
        pooled.push(stratum[Math.floor(rng() * stratum.length)]!);
      }
    }
    return pooled;
  };
  for (let it = 0; it < iterations; it += 1) {
    const off = armPool('off').sort((a, b) => a - b);
    const on = armPool('on').sort((a, b) => a - b);
    bootDMean[it] = meanOf(on) - meanOf(off);
    bootDP95[it] = percentile(on, 0.95) - percentile(off, 0.95);
  }
  bootDMean.sort((a, b) => a - b);
  bootDP95.sort((a, b) => a - b);
  const ci = (sorted: number[]): { lo: number; hi: number } => ({
    lo: percentile(sorted, 0.025),
    hi: percentile(sorted, 0.975),
  });

  return {
    estimator:
      'join-g2g assembleOneWay (imported): per-session component medians, one-way = ' +
      'encode_send + RTT_send/2 + RTT_recv/2 + jitterbuffer_recv + decode_recv + present_recv + 12.5ms residual ' +
      '(COMPONENT-SUM lower bound; L_present ?? 0)',
    sampleUnit: 'one session = one exclusive-create room (p2b<block><arm>[m]-<i>)',
    seed,
    iterations,
    blocks,
    perArm,
    perBlock,
    delta: {
      comparison: 'ON-OFF, unpaired, block retained as stratum (percentiles nearest-rank; sd sample n-1)',
      dMeanMs,
      dP95Ms,
    },
    bootstrap: {
      method:
        'stratified bootstrap: resample sessions with replacement within arm x block ' +
        '(stratum sizes preserved), mulberry32 seeded PRNG, fixed stratum order (arm off->on, blocks ascending, roomId-sorted); ' +
        'CI = 2.5/97.5 nearest-rank percentiles of the bootstrap deltas',
      seed,
      iterations,
      ci95: { dMeanMs: ci(bootDMean), dP95Ms: ci(bootDP95) },
    },
    sessions: [...sessions].sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)),
  };
}

export interface P2FullReport extends P2AnalysisReport {
  input: {
    malformedLines: number;
    /** Rooms present in the raw but assembled to no valid session row (plan: listed, not deleted). */
    invalidP2Rooms: string[];
    /** Assembled rooms outside the P2 taxonomy (canary / historical wan-*) — excluded from arms. */
    ignoredRooms: string[];
  };
}

/** Full pipeline from pooled JSONL text — the unit the tests drive. */
export function analyzeP2FromJsonl(
  raw: string,
  seed: number = DEFAULT_SEED,
  iterations: number = DEFAULT_ITERATIONS,
): P2FullReport {
  const { events, malformed } = eventsFromJsonl(raw);
  const rows = assembleOneWay(events);
  const { sessions, ignoredRooms } = toP2Sessions(rows);

  // Plan: invalid sessions are retained in the raw and LISTED — surface every
  // P2-taxonomy room seen in the raw that produced no valid session row.
  const p2RoomsInRaw = new Set<string>();
  for (const e of events) {
    const room = (e.context as { room_id?: unknown } | undefined)?.room_id;
    if (typeof room === 'string' && P2_ROOM_RE.test(room)) p2RoomsInRaw.add(room);
  }
  const validRooms = new Set(sessions.map((s) => s.roomId));
  const invalidP2Rooms = [...p2RoomsInRaw].filter((r) => !validRooms.has(r)).sort();

  const report = analyzeP2(sessions, seed, iterations);
  return { ...report, input: { malformedLines: malformed, invalidP2Rooms, ignoredRooms } };
}

// ── CLI ───────────────────────────────────────────────────────────────
function main(): void {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let seed = DEFAULT_SEED;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--seed') {
      const v = argv[++i];
      if (v === undefined || !/^\d+$/.test(v)) throw new Error('--seed must be a non-negative integer');
      seed = Number(v);
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  const input = positional[0];
  if (input === undefined || positional.length > 1) {
    throw new Error('usage: tsx scripts/bench/p2-block-analysis.ts <pooled.jsonl | split-dir> [--seed 20260716]');
  }

  let raw: string;
  if (statSync(input).isDirectory()) {
    // Split-dir mode: the two ARM views are the complete disjoint partition of
    // matched rows (block files are the same rows again — reading them too
    // would double every sample).
    raw =
      readFileSync(join(input, 'p2-arm-off.jsonl'), 'utf8') +
      readFileSync(join(input, 'p2-arm-on.jsonl'), 'utf8');
  } else {
    raw = readFileSync(input, 'utf8');
  }

  const report = analyzeP2FromJsonl(raw, seed);
  console.log(JSON.stringify(report, null, 2));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
  || (process.argv[1] !== undefined && (process.argv[1].endsWith('p2-block-analysis.ts') || process.argv[1].endsWith('p2-block-analysis.js')));
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error('p2-block-analysis FATAL:', (err as Error).message);
    process.exitCode = 1;
  }
}
