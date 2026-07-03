/**
 * Unit tests for tree-topology (cascade-tree Phase T-A).
 * REQ-RMS-039 (determinism) / 040 (degree cap) / 041 (diameter bound) / 048 (K<=2 star shape).
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveDegreeCap, deriveTree, parentOf, childrenOf, neighborsOf, type TreeLayout,
  estimateLatency, deriveMaxDiameter, type LatencyParams,
} from '@dvconf/inter-relay-client';

function serialize(t: TreeLayout) {
  return {
    root: t.root,
    height: t.height,
    diameter: t.diameter,
    withinDiameterBound: t.withinDiameterBound,
    degreeCap: t.degreeCap,
    nodes: [...t.nodes.entries()].map(([id, n]) => ({
      id, parent: n.parent, children: n.children, depth: n.depth,
    })),
  };
}
const H = 10; // generous height bound for determinism tests (bound itself tested in Task 3)

describe('deriveDegreeCap (REQ-RMS-040)', () => {
  it('D = floor((cWorker - uLocal) / P)', () => {
    expect(deriveDegreeCap(300, 0, 9)).toBe(33);
  });
  it('subtracts the local-client budget then floors', () => {
    expect(deriveDegreeCap(300, 10, 9)).toBe(32); // floor(290/9) = 32
  });
  it('returns 0 when local clients consume the whole worker', () => {
    expect(deriveDegreeCap(300, 300, 9)).toBe(0);
    expect(deriveDegreeCap(300, 500, 9)).toBe(0);
  });
  it('returns 0 when there are no producers', () => {
    expect(deriveDegreeCap(300, 0, 0)).toBe(0);
    expect(deriveDegreeCap(300, 0, -1)).toBe(0);
  });
});

describe('deriveTree — determinism (REQ-RMS-039)', () => {
  it('is order-independent (sorted by RelayId)', () => {
    const a = deriveTree(['0x03', '0x01', '0x02'], { degreeCap: 2, maxHeight: H });
    const b = deriveTree(['0x01', '0x02', '0x03'], { degreeCap: 2, maxHeight: H });
    expect(serialize(a)).toEqual(serialize(b));
  });
  it('dedupes exact duplicate ids', () => {
    const t = deriveTree(['0xaa', '0xaa', '0xbb'], { degreeCap: 2, maxHeight: H });
    expect(t.nodes.size).toBe(2);
  });
  it('dedupes case-insensitively (normalizeId lowercases first)', () => {
    const t = deriveTree(['0xAA', '0xaa', '0xBB'], { degreeCap: 2, maxHeight: H });
    expect(t.nodes.size).toBe(2);
  });
  it('root = min RelayId regardless of input order', () => {
    expect(deriveTree(['0x05', '0x02', '0x09'], { degreeCap: 2, maxHeight: H }).root).toBe('0x02');
  });
  it('parent(i) = floor((i-1)/D) over the sorted set (complete D-ary BFS)', () => {
    const t = deriveTree(['0x01', '0x02', '0x03', '0x04', '0x05'], { degreeCap: 2, maxHeight: H });
    expect(t.nodes.get('0x01')!.parent).toBeNull();
    expect(t.nodes.get('0x02')!.parent).toBe('0x01');
    expect(t.nodes.get('0x03')!.parent).toBe('0x01');
    expect(t.nodes.get('0x04')!.parent).toBe('0x02');
    expect(t.nodes.get('0x05')!.parent).toBe('0x02');
    expect(t.nodes.get('0x01')!.children).toEqual(['0x02', '0x03']);
    expect(t.nodes.get('0x02')!.children).toEqual(['0x04', '0x05']);
  });
  it('promote_relay-style reordering yields an identical layout', () => {
    const canonical = deriveTree(['0x01', '0x02', '0x03'], { degreeCap: 2, maxHeight: H });
    const swapped = deriveTree(['0x02', '0x01', '0x03'], { degreeCap: 2, maxHeight: H });
    expect(serialize(swapped)).toEqual(serialize(canonical));
  });
});

describe('deriveTree — trivial sizes', () => {
  it('empty set -> null root, height -1', () => {
    const t = deriveTree([], { degreeCap: 2, maxHeight: 3 });
    expect(t.root).toBeNull();
    expect(t.nodes.size).toBe(0);
    expect(t.height).toBe(-1);
    expect(t.diameter).toBe(0);
    expect(t.withinDiameterBound).toBe(true);
  });
  it('single relay -> root only, height 0, diameter 0', () => {
    const t = deriveTree(['0x01'], { degreeCap: 2, maxHeight: 3 });
    expect(t.root).toBe('0x01');
    expect(t.nodes.get('0x01')!.parent).toBeNull();
    expect(t.nodes.get('0x01')!.children).toEqual([]);
    expect(t.height).toBe(0);
    expect(t.diameter).toBe(0);
  });
});

describe('deriveTree — degree, height, diameter bounds (REQ-RMS-040/041)', () => {
  const seven = ['0x01', '0x02', '0x03', '0x04', '0x05', '0x06', '0x07'];

  it('no node exceeds the degree cap D', () => {
    const t = deriveTree(seven, { degreeCap: 2, maxHeight: 10 });
    for (const n of t.nodes.values()) expect(n.children.length).toBeLessThanOrEqual(2);
  });
  it('height correct for a complete binary tree of 7 (height 2, within bound)', () => {
    const t = deriveTree(seven, { degreeCap: 2, maxHeight: 2 });
    expect(t.height).toBe(2);
    expect(t.withinDiameterBound).toBe(true);
  });
  it('diameter = longest leaf->root->leaf hop path (K=3 D=2 -> 2)', () => {
    const t = deriveTree(['0x01', '0x02', '0x03'], { degreeCap: 2, maxHeight: 10 });
    expect(t.diameter).toBe(2);
  });
  it('diameter of a complete binary tree of 7 = 4', () => {
    const t = deriveTree(seven, { degreeCap: 2, maxHeight: 10 });
    expect(t.diameter).toBe(4); // leaf -> ... -> root -> ... -> leaf = 4 edges
  });
  it('flags withinDiameterBound=false when deeper than maxHeight, but keeps ALL K (no orphan)', () => {
    const t = deriveTree(seven, { degreeCap: 2, maxHeight: 1 });
    expect(t.height).toBe(2);
    expect(t.withinDiameterBound).toBe(false);
    expect(t.nodes.size).toBe(7);
  });
  it('K=2 -> root + exactly one child (STAR shape), height 1, diameter 1 (REQ-RMS-048)', () => {
    const t = deriveTree(['0x01', '0x02'], { degreeCap: 5, maxHeight: 3 });
    expect(t.root).toBe('0x01');
    expect(t.nodes.get('0x01')!.children).toEqual(['0x02']);
    expect(t.nodes.get('0x02')!.parent).toBe('0x01');
    expect(t.height).toBe(1);
    expect(t.diameter).toBe(1);
  });
  it('D=0 (budget exhausted) builds a chain (D forced to 1), bound false for K>1', () => {
    const t = deriveTree(['0x01', '0x02', '0x03'], { degreeCap: 0, maxHeight: 1 });
    expect(t.nodes.get('0x02')!.parent).toBe('0x01');
    expect(t.nodes.get('0x03')!.parent).toBe('0x02');
    expect(t.height).toBe(2);
    expect(t.withinDiameterBound).toBe(false);
  });
});

describe('tree helpers (edge-scoped fan support for T-B, REQ-RMS-043 precondition)', () => {
  const t = deriveTree(['0x01', '0x02', '0x03', '0x04', '0x05'], { degreeCap: 2, maxHeight: 10 });
  // sorted [01,02,03,04,05] D=2: 01 root; children(01)=[02,03]; children(02)=[04,05]; 03,04,05 leaves
  it('parentOf / childrenOf', () => {
    expect(parentOf(t, '0x01')).toBeNull();
    expect(parentOf(t, '0x04')).toBe('0x02');
    expect(childrenOf(t, '0x01')).toEqual(['0x02', '0x03']);
  });
  it('neighborsOf(root) = children only', () => {
    expect(neighborsOf(t, '0x01')).toEqual(['0x02', '0x03']);
  });
  it('neighborsOf(leaf) = [parent]', () => {
    expect(neighborsOf(t, '0x04')).toEqual(['0x02']);
  });
  it('neighborsOf(internal) = [parent, ...children]', () => {
    expect(neighborsOf(t, '0x02')).toEqual(['0x01', '0x04', '0x05']);
  });
  it('helpers normalize the queried id and tolerate unknown ids', () => {
    expect(parentOf(t, '0X04')).toBe('0x02'); // upper-case normalized
    expect(childrenOf(t, '0xZZ')).toEqual([]);
    expect(neighborsOf(t, '0xZZ')).toEqual([]);
  });
});

describe('estimateLatency (REQ-RMS-049)', () => {
  const P: LatencyParams = { lFixedMs: 100, lastMileMs: 40, tHopMs: 30 };

  it('worstMs = lFixed + lastMile + diameter*tHop for a known diameter', () => {
    // K=6, D=2 -> complete binary tree, diameter 4 (two depth-2 branches through root)
    const tree = deriveTree(['0x01', '0x02', '0x03', '0x04', '0x05', '0x06'], { degreeCap: 2, maxHeight: 10 });
    expect(tree.diameter).toBe(4);
    const est = estimateLatency(tree, P);
    expect(est.worstMs).toBe(100 + 40 + 4 * 30); // 260
  });

  it('decomposes relayPathMs / networkMs / hops', () => {
    const tree = deriveTree(['0x01', '0x02', '0x03', '0x04', '0x05', '0x06'], { degreeCap: 2, maxHeight: 10 });
    const est = estimateLatency(tree, P);
    expect(est.hops).toBe(tree.diameter);       // 4
    expect(est.relayPathMs).toBe(4 * 30);       // 120 — the part the TREE controls
    expect(est.networkMs).toBe(40 + 4 * 30);    // 160 = lastMile + relayPath
  });

  it('K<=1 layout (diameter 0) -> worstMs = lFixed + lastMile (no relay hop)', () => {
    const solo = deriveTree(['0x01'], { degreeCap: 2, maxHeight: 10 });
    expect(solo.diameter).toBe(0);
    expect(estimateLatency(solo, P).worstMs).toBe(100 + 40); // lFixed + lastMile, no relay hop
    expect(estimateLatency(solo, P).relayPathMs).toBe(0);    // zero-boundary: tree controls nothing
    expect(estimateLatency(solo, P).networkMs).toBe(40);     // lastMile only
    const empty = deriveTree([], { degreeCap: 2, maxHeight: 10 });
    expect(estimateLatency(empty, P).worstMs).toBe(100 + 40); // lFixed + lastMile, no relay hop
  });

  it('K=2 star (diameter 1) -> exactly one hop added (single-standby latency)', () => {
    const pair = deriveTree(['0x01', '0x02'], { degreeCap: 2, maxHeight: 10 });
    expect(pair.diameter).toBe(1);
    expect(estimateLatency(pair, P).worstMs).toBe(100 + 40 + 1 * 30); // one hop
  });
});

describe('deriveMaxDiameter (REQ-RMS-050)', () => {
  const P: LatencyParams = { lFixedMs: 100, lastMileMs: 40, tHopMs: 30 };

  it('floor((budget - lFixed - lastMile) / tHop)', () => {
    expect(deriveMaxDiameter(300, P)).toBe(5); // floor((300-140)/30) = floor(5.33) = 5
  });

  it('budget == lFixed+lastMile -> 0 (only a 0-hop / single-relay room fits)', () => {
    expect(deriveMaxDiameter(140, P)).toBe(0);
  });

  it('budget < lFixed+lastMile -> -1 SENTINEL (even a single-relay room is over budget; distinct from 0)', () => {
    expect(deriveMaxDiameter(139, P)).toBe(-1);
    expect(deriveMaxDiameter(0, P)).toBe(-1);
  });

  it('tHop <= 0 (loopback/degenerate) -> -1 guard (floor(x/0) would be Infinity)', () => {
    expect(deriveMaxDiameter(300, { ...P, tHopMs: 0 })).toBe(-1);
    expect(deriveMaxDiameter(300, { ...P, tHopMs: -5 })).toBe(-1);
  });
});

describe('estimateLatency <-> deriveMaxDiameter round-trip (no floor off-by-one)', () => {
  const P: LatencyParams = { lFixedMs: 100, lastMileMs: 40, tHopMs: 30 };

  it('for budget >= floor: worstMs <= budget IFF diameter <= deriveMaxDiameter', () => {
    // Sample trees with diameters 0,1,4 and budgets straddling each cap.
    const trees = [
      deriveTree(['0x01'], { degreeCap: 2, maxHeight: 10 }),                                   // diameter 0
      deriveTree(['0x01', '0x02'], { degreeCap: 2, maxHeight: 10 }),                            // diameter 1
      deriveTree(['0x01', '0x02', '0x03', '0x04', '0x05', '0x06'], { degreeCap: 2, maxHeight: 10 }), // diameter 4
    ];
    for (const budget of [140, 170, 199, 200, 260, 320]) {
      const cap = deriveMaxDiameter(budget, P);
      for (const t of trees) {
        const within = estimateLatency(t, P).worstMs <= budget;
        expect(within).toBe(t.diameter <= cap);
      }
    }
  });

  it('boundary: budget < floor -> cap -1 AND worstMs(diameter 0) > budget (iff correctly scoped out)', () => {
    const solo = deriveTree(['0x01'], { degreeCap: 2, maxHeight: 10 }); // diameter 0
    expect(deriveMaxDiameter(139, P)).toBe(-1);
    expect(estimateLatency(solo, P).worstMs).toBeGreaterThan(139); // 140 > 139
  });
});
