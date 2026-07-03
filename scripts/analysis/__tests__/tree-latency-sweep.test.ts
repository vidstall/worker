/**
 * Unit tests for the T-L N_max latency sweep (REQ-RMS-051).
 * PURE composition — no daemon boot; estimateRoomLoad + deriveTree + estimateLatency.
 */
import { describe, it, expect } from 'vitest';
// Relative SOURCE path, not the bare `@dvconf/inter-relay-client` specifier: scripts/ sits OUTSIDE
// every workspace package so no pnpm symlink is reachable to resolve the bare value-import at runtime
// (see scripts/demo/m2b-live-bhermetic-slash.ts precedent + the sweep module's import note).
import { deriveTree, toCanonicalRelayId, type LatencyParams } from '../../../packages/inter-relay-client/src/index.ts';
// Relative path (same reason as the barrel import above): scripts/ is outside the workspace, so the
// bare `@dvconf` specifier has no symlink — import the cp-daemon admission helper by source path.
import { estimateRoomLoad } from '../../../apps/cp-daemon/src/admission-capacity.js';
import {
  sweepLatency, findNMax, audioTerm, synthesizeCanonicalIds, type SweepConfig, type AudioRegime,
} from '../tree-latency-sweep.js';

const P: LatencyParams = { lFixedMs: 100, lastMileMs: 40, tHopMs: 30 };
const BIG = 999; // maxHeight so deriveTree never pre-clips; T-L caps by ms

function baseCfg(over: Partial<SweepConfig>): SweepConfig {
  return {
    roomClass: 'large', relayMode: 'sfu', audioRegime: 'quadratic',
    degreeCap: 3, cWorker: 300, krMin: 2, maxHeight: BIG,
    params: P, budgetMs: 300, nRange: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
    ...over,
  };
}

describe('audioTerm regimes', () => {
  it('linear = N, quadratic = N*(N-1)', () => {
    expect(audioTerm('linear', 60)).toBe(60);
    expect(audioTerm('quadratic', 60)).toBe(60 * 59);
  });
});

describe('sweepLatency monotonicity + findNMax (REQ-RMS-051)', () => {
  it('worstMs is non-decreasing in N and produces a single crossover N_max', () => {
    const rows = sweepLatency(baseCfg({}));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.worstMs).toBeGreaterThanOrEqual(rows[i - 1]!.worstMs);
    }
    const nMax = findNMax(rows);
    // every N <= nMax is within budget; every N > nMax is over budget (monotone)
    for (const r of rows) expect(r.withinBudget).toBe(r.n <= nMax);
    expect(nMax).toBeGreaterThan(-1);                     // some N fits
    expect(rows.some((r) => !r.withinBudget)).toBe(true); // and some N does not -> a real crossover
  });

  it('both audio regimes emit labeled rows', () => {
    const lin = sweepLatency(baseCfg({ audioRegime: 'linear' }));
    const quad = sweepLatency(baseCfg({ audioRegime: 'quadratic' }));
    expect(lin.every((r) => r.label.includes('audio=linear'))).toBe(true);
    expect(quad.every((r) => r.label.includes('audio=quadratic'))).toBe(true);
  });
});

describe('synthesizeCanonicalIds(kR): kR distinct canonical ids, no dedup drop', () => {
  it('length=kR, distinct, canonical, deriveTree keeps all kR nodes', () => {
    for (const kR of [1, 2, 5, 13, 34]) {
      const ids = synthesizeCanonicalIds(kR);
      expect(ids.length).toBe(kR);
      expect(new Set(ids).size).toBe(kR);                                 // distinct
      expect(ids.every((id) => id === toCanonicalRelayId(id))).toBe(true); // canonical
      expect(deriveTree(ids, { degreeCap: 4, maxHeight: BIG }).nodes.size).toBe(kR); // no dedup drop
    }
  });
});

describe('deriveTree shape depends on (count, degreeCap) — NOT on id VALUES', () => {
  it('a disjoint-valued id set of the same size+degree yields identical diameter AND height', () => {
    for (const kR of [2, 5, 13, 34]) {
      const a = synthesizeCanonicalIds(kR); // ids 0x1..0xkR
      const b = Array.from({ length: kR }, (_, i) =>
        toCanonicalRelayId('0x' + (0x1000 + i + 1).toString(16))); // entirely different values
      expect(new Set(b).size).toBe(kR);                  // b distinct
      expect(new Set([...a, ...b]).size).toBe(2 * kR);   // a, b are value-disjoint
      const ta = deriveTree(a, { degreeCap: 4, maxHeight: BIG });
      const tb = deriveTree(b, { degreeCap: 4, maxHeight: BIG });
      expect(tb.diameter).toBe(ta.diameter);             // shape invariant to id values
      expect(tb.height).toBe(ta.height);
    }
  });
});

describe('sweepLatency fail-closed on loopback/degenerate tHop (spec §5 honesty rule)', () => {
  it('refuses (throws) when tHopMs <= 0 — never emits an unlabeled loopback "pass"', () => {
    expect(() => sweepLatency(baseCfg({ params: { ...P, tHopMs: 0 } }))).toThrow(/refus|loopback|floor/i);
    expect(() => sweepLatency(baseCfg({ params: { ...P, tHopMs: -5 } }))).toThrow(/refus|loopback|floor/i);
  });
});

describe('video-term reuse: estimateRoomLoad(class, 0, mode) yields the PURE video term', () => {
  it('large/sfu pure video term is the pinned 270 (audio zeroed by passing 0)', () => {
    expect(estimateRoomLoad('large', 0, 'sfu')).toBe(270);
  });
});

describe('krMin=1 shipped default -> kR=1, no tree, flat N-independent floor', () => {
  it('every row: kR=1, diameter=0, worstMs=lFixed+lastMile (no relay hop)', () => {
    const rows = sweepLatency(baseCfg({ krMin: 1 }));
    for (const r of rows) {
      expect(r.kR).toBe(1);
      expect(r.diameter).toBe(0);
      expect(r.worstMs).toBe(100 + 40); // 140, flat — no cascade when krMin=1
    }
  });
});

describe('§7 advisor-table pin — every row = REAL deriveTree+estimateLatency (guards the 2H overestimate)', () => {
  // The six spec §7 rows. diameter/worstMs are the EXACT deriveTree output — NOT 2*height.
  const ROWS: Array<{ n: number; regime: AudioRegime; D: number; kR: number; diameter: number; worstMs: number }> = [
    { n: 60,  regime: 'linear',    D: 2, kR: 2,  diameter: 1, worstMs: 170 },
    { n: 100, regime: 'linear',    D: 2, kR: 2,  diameter: 1, worstMs: 170 },
    { n: 60,  regime: 'quadratic', D: 2, kR: 13, diameter: 6, worstMs: 320 },
    { n: 60,  regime: 'quadratic', D: 3, kR: 13, diameter: 4, worstMs: 260 },
    { n: 100, regime: 'quadratic', D: 3, kR: 34, diameter: 6, worstMs: 320 },
    { n: 100, regime: 'quadratic', D: 4, kR: 34, diameter: 5, worstMs: 290 },
  ];

  it.each(ROWS)('N=$n $regime D=$D -> kR=$kR diameter=$diameter worst=$worstMs', (row) => {
    const [only] = sweepLatency(baseCfg({
      audioRegime: row.regime, degreeCap: row.D, nRange: [row.n],
    }));
    expect(only!.kR).toBe(row.kR);
    expect(only!.diameter).toBe(row.diameter); // EXACT — a 2H proxy (e.g. 6 for the D=4 row) fails here
    expect(only!.worstMs).toBe(row.worstMs);
  });

  it('the two load-bearing fixtures pin exact != 2H directly', () => {
    // K=34,D=4 -> diameter 5 (NOT 2*height=6); K=34,D=3 -> diameter 6
    expect(deriveTree(synthesizeCanonicalIds(34), { degreeCap: 4, maxHeight: BIG }).diameter).toBe(5);
    expect(deriveTree(synthesizeCanonicalIds(34), { degreeCap: 3, maxHeight: BIG }).diameter).toBe(6);
  });
});

describe('provenance label completeness (spec §5 honesty rule)', () => {
  it('every emitted row carries a non-empty label containing the tHop param', () => {
    const rows = sweepLatency(baseCfg({}));
    expect(rows.every((r) => r.label.length > 0 && r.label.includes('tHop=30'))).toBe(true);
  });
});
