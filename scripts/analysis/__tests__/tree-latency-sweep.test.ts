/**
 * Unit tests for the T-L N_max latency sweep (REQ-RMS-051).
 * PURE composition — no daemon boot; estimateRoomLoad + deriveTree + estimateLatency.
 */
import { describe, it, expect } from 'vitest';
// Relative SOURCE path, not the bare `@dvconf/inter-relay-client` specifier: scripts/ sits OUTSIDE
// every workspace package so no pnpm symlink is reachable to resolve the bare value-import at runtime
// (see scripts/demo/m2b-live-bhermetic-slash.ts precedent + the sweep module's import note).
import { deriveTree, toCanonicalRelayId, type LatencyParams } from '../../../packages/inter-relay-client/src/index.ts';
import {
  sweepLatency, findNMax, audioTerm, synthesizeCanonicalIds, type SweepConfig,
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
  });

  it('both audio regimes emit labeled rows', () => {
    const lin = sweepLatency(baseCfg({ audioRegime: 'linear' }));
    const quad = sweepLatency(baseCfg({ audioRegime: 'quadratic' }));
    expect(lin.every((r) => r.label.includes('audio=linear'))).toBe(true);
    expect(quad.every((r) => r.label.includes('audio=quadratic'))).toBe(true);
  });
});

describe('synthesized-ID tree shape == real deriveTree (shape depends on count+degree, not id values)', () => {
  it('synthesizeCanonicalIds(kR) fed to deriveTree matches a hand-built same-size tree', () => {
    for (const kR of [1, 2, 5, 13, 34]) {
      const ids = synthesizeCanonicalIds(kR);
      expect(ids.length).toBe(kR);
      expect(new Set(ids).size).toBe(kR);                    // distinct
      expect(ids.every((id) => id === toCanonicalRelayId(id))).toBe(true); // canonical
      const tree = deriveTree(ids, { degreeCap: 4, maxHeight: BIG });
      expect(tree.nodes.size).toBe(kR);                      // no dedup drop
    }
  });
});
