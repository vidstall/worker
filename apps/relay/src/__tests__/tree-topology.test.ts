/**
 * Unit tests for tree-topology (cascade-tree Phase T-A).
 * REQ-RMS-039 (determinism) / 040 (degree cap) / 041 (diameter bound) / 048 (K<=2 star shape).
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { deriveDegreeCap, deriveTree, type TreeLayout } from '@dvconf/inter-relay-client';

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
