/**
 * Cascade-tree Phase T-L (Layer 1) — analytical N_max latency sweep (REQ-RMS-051).
 * PURE composition of estimateRoomLoad (video term, REUSED) + an injected audio model +
 * deriveTree (T-A) + estimateLatency (T-L). NOT part of the pure package: it imports cp-daemon's
 * admission-capacity, so it lives in scripts/ (run via tsx, tested via vitest — no daemon boot).
 * See docs/superpowers/specs/2026-07-03-cascade-tree-latency-model-design.md §6/§7.
 */
import { pathToFileURL } from 'node:url';
import { estimateRoomLoad, type RoomClass } from '../../apps/cp-daemon/src/admission-capacity.js';
// Relative SOURCE path (NOT the bare `@dvconf/inter-relay-client` specifier): scripts/ sits OUTSIDE
// every workspace package, so no pnpm symlink is reachable from here to START bare resolution — a
// VALUE import of the barrel would fail at runtime (only `import type` survives, being elided).
// Pointing INTO the package lets its own internal bare imports resolve against its local node_modules.
// Mirrors the documented precedent in scripts/demo/m2b-live-bhermetic-slash.ts.
import {
  deriveTree, estimateLatency, toCanonicalRelayId,
  type LatencyParams, type RelayId,
} from '../../packages/inter-relay-client/src/index.ts';

export type AudioRegime = 'linear' | 'quadratic';

/** O(N) shipped-conservative floor vs O(N^2) honest worst-case audio fan-out. */
export function audioTerm(regime: AudioRegime, n: number): number {
  return regime === 'quadratic' ? n * (n - 1) : n;
}

/** Distinct canonical 0x ids for a kR-node synthetic tree (shape depends on (kR,D) only, not id values). */
export function synthesizeCanonicalIds(kR: number): RelayId[] {
  const ids: RelayId[] = [];
  for (let i = 0; i < kR; i++) ids.push(toCanonicalRelayId('0x' + (i + 1).toString(16)));
  return ids;
}

export interface SweepConfig {
  roomClass: RoomClass;
  relayMode: 'sfu' | 'mcu';
  audioRegime: AudioRegime;
  degreeCap: number;         // D
  cWorker: number;           // per-worker path ceiling (RMS_C_WORKER_PATHS default 300)
  krMin: number;             // forced-cascade floor; §6/§7 pin krMin=2 (>1 to force a tree)
  maxHeight: number;         // BIG so deriveTree never pre-clips; T-L caps by ms
  params: LatencyParams;
  budgetMs: number;
  nRange: readonly number[];
}

export interface SweepRow {
  n: number;
  audioRegime: AudioRegime;
  lR: number;
  kR: number;
  degreeCap: number;
  diameter: number;
  worstMs: number;
  withinBudget: boolean;
  label: string; // honesty provenance — every row carries its full param set (spec §5 rule)
}

function labelFor(cfg: SweepConfig): string {
  const { params, audioRegime, budgetMs, degreeCap, cWorker, krMin, roomClass, relayMode } = cfg;
  return `class=${roomClass} mode=${relayMode} audio=${audioRegime} D=${degreeCap} cWorker=${cWorker} krMin=${krMin} ` +
    `lFixed=${params.lFixedMs} lastMile=${params.lastMileMs} tHop=${params.tHopMs} budget=${budgetMs}`;
}

/**
 * PURE. One SweepRow per N. The video term REUSES estimateRoomLoad(class, 0, mode) (audio zeroed);
 * the audio model is injected here so the O(N^2) regime never silently calls the O(N) admission term.
 * kR MATCHES event-handler.ts:491 exactly: krMin>1 ? max(krMin, ceil(L_r/cWorker)) : 1.
 * FAIL-CLOSED: tHop<=0 is a loopback/mechanism-floor -> refused (never emit an unlabeled "pass").
 */
export function sweepLatency(cfg: SweepConfig): SweepRow[] {
  if (cfg.params.tHopMs <= 0) {
    throw new Error(
      `sweepLatency: tHopMs<=0 (${cfg.params.tHopMs}) is a loopback/mechanism floor — refused; ` +
      `a real figure needs a labeled WAN tHop (spec §5 honesty rule)`,
    );
  }
  const label = labelFor(cfg);
  const videoTerm = estimateRoomLoad(cfg.roomClass, 0, cfg.relayMode); // audio=0 -> pure video term (REUSE)
  const rows: SweepRow[] = [];
  for (const n of cfg.nRange) {
    const lR = videoTerm + audioTerm(cfg.audioRegime, n);
    const kR = cfg.krMin > 1 ? Math.max(cfg.krMin, Math.ceil(lR / cfg.cWorker)) : 1;
    const ids = synthesizeCanonicalIds(kR);
    const tree = deriveTree(ids, { degreeCap: cfg.degreeCap, maxHeight: cfg.maxHeight });
    const est = estimateLatency(tree, cfg.params);
    rows.push({
      n, audioRegime: cfg.audioRegime, lR, kR, degreeCap: cfg.degreeCap,
      diameter: tree.diameter, worstMs: est.worstMs,
      withinBudget: est.worstMs <= cfg.budgetMs, label,
    });
  }
  return rows;
}

/** Largest N within budget. Monotone worstMs(N) -> the last within-budget N; -1 if none fit. */
export function findNMax(rows: readonly SweepRow[]): number {
  let nMax = -1;
  for (const r of rows) {
    if (r.withinBudget) nMax = r.n;
    else break;
  }
  return nMax;
}

// ---------------------------------------------------------------------------
// CLI: analytical N_max report (the "đo max bằng công thức" advisor deliverable).
// Run: npx tsx scripts/analysis/tree-latency-sweep.ts
// Prints one labeled block per (audio regime, D) at the §5 representative params.
// ---------------------------------------------------------------------------
function formatReport(cfg: SweepConfig): string {
  const rows = sweepLatency(cfg);
  const nMax = findNMax(rows);
  const head = rows[0]?.label ?? labelFor(cfg);
  const body = rows
    .map((r) => `  N=${String(r.n).padStart(4)}  kR=${String(r.kR).padStart(3)}  ` +
      `diameter=${r.diameter}  worst=${String(r.worstMs).padStart(4)}ms  ${r.withinBudget ? 'OK' : 'OVER'}`)
    .join('\n');
  return `[${head}]\n${body}\n  => N_max (within budget) = ${nMax}`;
}

function main(): void {
  const P: LatencyParams = { lFixedMs: 100, lastMileMs: 40, tHopMs: 30 }; // §5 WAN-regional representative
  const nRange = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
  const base: Omit<SweepConfig, 'audioRegime' | 'degreeCap'> = {
    roomClass: 'large', relayMode: 'sfu', cWorker: 300, krMin: 2,
    maxHeight: 999, params: P, budgetMs: 300, nRange,
  };
  const blocks = [
    { audioRegime: 'linear' as AudioRegime, degreeCap: 2 },
    { audioRegime: 'quadratic' as AudioRegime, degreeCap: 3 },
    { audioRegime: 'quadratic' as AudioRegime, degreeCap: 4 },
  ];
  // eslint-disable-next-line no-console
  console.log('# T-L analytical latency sweep (worst-case, video budget 300ms)\n');
  for (const b of blocks) {
    // eslint-disable-next-line no-console
    console.log(formatReport({ ...base, ...b }) + '\n');
  }
}

// Run only when invoked directly (tsx), never on import (keeps the module test-pure).
// pathToFileURL normalizes the Windows backslash argv[1] to a file:// URL so the strict === fires
// (a raw `file://${process.argv[1]}` compare is FALSE on Windows and main() would never run).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
