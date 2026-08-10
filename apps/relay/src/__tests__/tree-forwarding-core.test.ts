/**
 * Unit tests for cascade-tree Phase T-B tree-aware forwarding — core pure
 * functions: byte-stability guards, tree-position derivation, fan-target /
 * hop-budget helpers, and the fresh-local-id + origin/hopTtl registry
 * plumbing.
 * REQ-RMS-042 / 044 / 046 / 048.
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { buildPipeProducerAnnounce, isPipeProducerAnnounce, deriveTree, treeRoleOf, toCanonicalRelayId, produceLocalFromPipe, InterRelayProducerRegistry } from '@dvconf/inter-relay-client';
import { deriveTreePosition, fanTargets, fanTargetUrls, nextHopTtl, seedOrDecrementHop, computeTreeFanPlan } from '../tree-position.js';

describe('T-B byte-stability guards (REQ-RMS-048) — MUST stay green through every task', () => {
  it('a default announce frame has EXACTLY the shipped keys (no tree fields)', () => {
    const frame = buildPipeProducerAnnounce('room1', { id: 'prod1', kind: 'video' });
    expect(Object.keys(frame).sort()).toEqual(['kind', 'producerId', 'roomId', 'type']);
    expect('hopTtl' in frame).toBe(false);
    expect('originProducerId' in frame).toBe(false);
  });
  it('a pre-tree frame (no hopTtl/originProducerId) still validates (back-compat)', () => {
    expect(isPipeProducerAnnounce({
      type: 'pipe-producer', roomId: 'room1', producerId: 'prod1', kind: 'video',
    })).toBe(true);
  });
});

describe('treeRoleOf (REQ-RMS-042)', () => {
  const ids = ['0x00', '0x01', '0x02', '0x03', '0x04'];
  // D=2: 0x00 root; children {0x01 [internal], 0x02 [leaf]}; 0x01's children {0x03,0x04 [leaves]}
  const layout = deriveTree(ids, { degreeCap: 2, maxHeight: 3 });
  it('root → "root"', () => expect(treeRoleOf(layout, '0x00')).toBe('root'));
  it('internal (parent AND children) → "internal"', () => expect(treeRoleOf(layout, '0x01')).toBe('internal'));
  it('leaf (parent, no children) → "leaf"', () => expect(treeRoleOf(layout, '0x03')).toBe('leaf'));
  it('unknown id → "leaf" (fail-safe)', () => expect(treeRoleOf(layout, '0xZZ')).toBe('leaf'));
  it('single-node tree root (parent===null, no children) → "leaf" (no forwarding targets)', () => {
    const solo = deriveTree(['0x00'], { degreeCap: 2, maxHeight: 3 });
    expect(treeRoleOf(solo, '0x00')).toBe('leaf');
  });
});

describe('toCanonicalRelayId (REQ-RMS-039)', () => {
  it('lowercases, trims, AND zero-pads to 0x+64hex', () =>
    expect(toCanonicalRelayId('  0xAB  ')).toBe('0x' + '0'.repeat(62) + 'ab')); // 66 chars
  it('pads short-form so lexical sort == numeric sort', () => {
    const p = toCanonicalRelayId('0x1');
    expect(p).toBe('0x' + '0'.repeat(63) + '1');
    expect(p.length).toBe(66);
  });
  it('leaves an already-canonical 64-hex id unchanged', () => {
    const full = '0x' + 'a'.repeat(64);
    expect(toCanonicalRelayId(full)).toBe(full);
  });
  it('pads a bare hex id with no 0x prefix', () =>
    expect(toCanonicalRelayId('ab')).toBe('0x' + '0'.repeat(62) + 'ab'));
  it('throws on oversized hex (>64 chars) rather than silently truncating', () =>
    expect(() => toCanonicalRelayId('0x' + 'a'.repeat(65))).toThrow());
});

describe('hopTtl + originProducerId on PipeProducerAnnounce (T5, REQ-RMS-044/046)', () => {
  it('builder OMITS both when not passed (byte-stable default)', () => {
    const f = buildPipeProducerAnnounce('r', { id: 'p', kind: 'video' });
    expect('hopTtl' in f).toBe(false);
    expect('originProducerId' in f).toBe(false);
  });
  it('builder INCLUDES both when passed', () => {
    const f = buildPipeProducerAnnounce('r', { id: 'p', kind: 'video' }, 'peerA', 'ws://relay', undefined, 3, 'origin-1');
    expect(f.hopTtl).toBe(3);
    expect(f.originProducerId).toBe('origin-1');
  });
  it('guard accepts numeric hopTtl + string originProducerId', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', hopTtl: 2, originProducerId: 'o' })).toBe(true);
  });
  it('guard REJECTS a non-numeric hopTtl', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', hopTtl: 'x' })).toBe(false);
  });
  it('guard REJECTS a non-string originProducerId', () => {
    expect(isPipeProducerAnnounce({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'video', originProducerId: 42 })).toBe(false);
  });
});

describe('deriveTreePosition — SHAPING degree governs (B1)', () => {
  const ids = ['0x02', '0x00', '0x04', '0x01', '0x03']; // unsorted
  it('shapingDegree=2 with NO capacity signal → a real depth-2 tree (internal node exists)', () => {
    const p = deriveTreePosition(ids, '0x01', 2, 3); // capacityCap omitted
    expect(p.parent).toBe('0x' + '0'.repeat(63) + '0'); // R0 canonical
    expect(p.children.length).toBeGreaterThan(0);
    expect(p.role).toBe('internal');
  });
  it('a huge capacityCap does NOT widen the tree (shape still governs)', () => {
    const wide = deriveTreePosition(ids, '0x01', 2, 3, 300);
    expect(wide.role).toBe('internal'); // NOT collapsed to a star
  });
  it('capacity LOWERS D below the shape (saturated worker → fewer children)', () => {
    const p = deriveTreePosition(['0x00','0x01','0x02','0x03'], '0x00', 3, 3, 1); // cap=1 → D=1 chain
    expect(p.children.length).toBeLessThanOrEqual(1);
  });
  it('order-independent', () => {
    expect(deriveTreePosition(['0x00','0x01','0x02'], '0x01', 2, 3))
      .toEqual(deriveTreePosition(['0x02','0x01','0x00'], '0x01', 2, 3));
  });
});

describe('fanTargets + nextHopTtl', () => {
  it('local origin (null) fans all', () => expect(fanTargets(['a','b'], null)).toEqual(['a','b']));
  it('excludes the receive edge', () => expect(fanTargets(['a','b','c'], 'b')).toEqual(['a','c']));
  it('nextHopTtl decrements; undefined passes through; 1→0 signals drop', () => {
    expect(nextHopTtl(3)).toBe(2); expect(nextHopTtl(undefined)).toBeUndefined(); expect(nextHopTtl(1)).toBe(0);
  });
});

describe('seedOrDecrementHop — hop-guard transition (REQ-RMS-044)', () => {
  it('local origin (undefined inbound) SEEDS at the tree diameter', () =>
    expect(seedOrDecrementHop(undefined, 4)).toBe(4));
  it('an inbound hop DECREMENTS by one', () =>
    expect(seedOrDecrementHop(3, 4)).toBe(2));
  it('the last budgeted hop lands on 0 → the caller\'s <= 0 drop-guard fires', () =>
    expect(seedOrDecrementHop(1, 4)).toBe(0));
});

// ── T7 follow-up (§3.3) — the UNIFORM own-produce fan SHAPE is tree-position-driven ──
//
// fanToTreeNeighbors (index.ts main-scoped) drives computeTreeFanPlan; these prove the SHAPE the
// driver mechanically maps to onPrimaryProducer (per childUrl, DOWN) + onStandbyProducer (parentUrl,
// UP), WITHOUT the live endpoint cache / mediasoup. The dispatch that routes EVERY own produce here
// (independent of chain role) is the handleProduce hoist — its flag-off byte-stability is guarded by
// primary-produce-drive + inter-relay-wiring; end-to-end reach is Task 9 integration.

describe('computeTreeFanPlan — uniform own-produce fan shape (T7 follow-up, §3.3, concern #1/#2)', () => {
  // D=2, H=3 tree over 0x00..0x04: 0x00 root; children {0x01 internal, 0x02 leaf}; 0x01 → {0x03,0x04 leaves}.
  const ids = ['0x00', '0x01', '0x02', '0x03', '0x04'];
  const urlByCanon = new Map(ids.map((s) => [toCanonicalRelayId(s), `ws://${s}:4000`] as const));
  const resolve = (id: string) => urlByCanon.get(id) ?? null;

  it('concern #1 — an INTERNAL node OWN produce (receiveEdge=null) fans DOWN to EVERY child AND UP to the parent (dual-role)', () => {
    const pos = deriveTreePosition(ids, '0x01', 2, 3);
    expect(pos.role).toBe('internal');               // sanity: parent≠null AND children≠∅
    const plan = computeTreeFanPlan(pos, null, undefined, resolve);
    // DOWN: one resolved child URL per tree child (the leg the OLD UP-only own-produce wiring MISSED).
    expect(plan.childUrls.slice().sort()).toEqual(pos.children.map((c) => resolve(c)).sort());
    expect(plan.childUrls.length).toBe(pos.children.length);
    expect(plan.childUrls.length).toBeGreaterThan(0);
    // UP: the parent URL is ALSO present → both legs → the intended internal dual-role.
    expect(plan.parentUrl).toBe(resolve(pos.parent!));
    // local origin (undefined inbound) SEEDS the budget from the tree diameter.
    expect(plan.hop).toBe(pos.diameter);
  });

  it('concern #2 — a tree ROOT (parent=null) OWN produce fans DOWN to children only, NO UP (never announces to a non-existent parent)', () => {
    const pos = deriveTreePosition(ids, '0x00', 2, 3);
    expect(pos.parent).toBeNull();
    expect(pos.children.length).toBeGreaterThan(0);
    const plan = computeTreeFanPlan(pos, null, undefined, resolve);
    expect(plan.parentUrl).toBeNull();               // role-independent: a tree root fans DOWN only
    expect(plan.childUrls.length).toBe(pos.children.length);
  });

  it('a LEAF (children=∅) OWN produce fans UP to the parent only (no DOWN targets)', () => {
    const pos = deriveTreePosition(ids, '0x03', 2, 3);
    expect(pos.role).toBe('leaf');
    const plan = computeTreeFanPlan(pos, null, undefined, resolve);
    expect(plan.childUrls).toEqual([]);
    expect(plan.parentUrl).toBe(resolve(pos.parent!));
  });

  it('edge-scope — a producer arriving FROM the parent is NOT echoed back UP (parentUrl null), children still fan DOWN', () => {
    const pos = deriveTreePosition(ids, '0x01', 2, 3);
    const parentUrl = resolve(pos.parent!)!;
    const plan = computeTreeFanPlan(pos, parentUrl, 3, resolve);
    expect(plan.parentUrl).toBeNull();
    expect(plan.childUrls.length).toBe(pos.children.length);
  });

  it('hop guard — inboundHopTtl=1 → hop 0 → EMPTY plan (no re-forward targets, caller still fanned local)', () => {
    const pos = deriveTreePosition(ids, '0x01', 2, 3);
    const plan = computeTreeFanPlan(pos, null, 1, resolve);
    expect(plan.hop).toBe(0);
    expect(plan.childUrls).toEqual([]);
    expect(plan.parentUrl).toBeNull();
  });

  it('an unresolved parent endpoint → parentUrl null (skipped-and-logged in the driver; make-before-break covers it)', () => {
    const pos = deriveTreePosition(ids, '0x01', 2, 3);
    const resolveNoParent = (id: string) => (id === pos.parent ? null : resolve(id));
    const plan = computeTreeFanPlan(pos, null, undefined, resolveNoParent);
    expect(plan.parentUrl).toBeNull();
    expect(plan.childUrls.length).toBe(pos.children.length); // children still resolve
  });
});

describe('fanTargetUrls — id-space bridge + edge-scope (T4, B2)', () => {
  const resolve = (id: string) => ({ '0xA': 'ws://a:4000', '0xB': 'ws://b:4000', '0xC': null } as Record<string,string|null>)[id] ?? null;
  it('translates relayIds → URLs and drops unresolved', () =>
    expect(fanTargetUrls(['0xA','0xB','0xC'], resolve, null)).toEqual(['ws://a:4000','ws://b:4000']));
  it('excludes the receive-edge URL', () =>
    expect(fanTargetUrls(['0xA','0xB'], resolve, 'ws://a:4000')).toEqual(['ws://b:4000']));
});

// ── T6 (REQ-RMS-046/048) — flag-gated fresh LOCAL producerId + per-room origin dedup ──

describe('flag-gated fresh LOCAL producerId (T6, REQ-RMS-046/048)', () => {
  function fakeTransport(seen: Record<string, unknown>[]) {
    return { produce: async (o: Record<string, unknown>) => { seen.push(o); return { id: 'local-' + seen.length } as never; } } as never;
  }
  it('freshId=false (default/shipped) PINS the announced id (byte-stable)', async () => {
    const seen: Record<string, unknown>[] = [];
    await produceLocalFromPipe(fakeTransport(seen), { producerId: 'origin-1', kind: 'video', rtpParameters: {} as never });
    expect(seen[0]!['id']).toBe('origin-1');
  });
  it('freshId=true (tree active) OMITS the id → fresh per hop', async () => {
    const seen: Record<string, unknown>[] = [];
    await produceLocalFromPipe(fakeTransport(seen), { producerId: 'origin-1', kind: 'video', rtpParameters: {} as never }, { freshId: true });
    expect(seen[0]!['id']).toBeUndefined();
  });
});

describe('registry.record preserves originProducerId + hopTtl for the drain (B4)', () => {
  it('copies both immutable-origin fields off the inbound announce', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'r', producerId: 'hop-2', kind: 'video', peerRelayId: 'ws://peer', originProducerId: 'ORIGIN-1', hopTtl: 2 } as never);
    const [a] = reg.resolveAll('r', 'ws://peer');
    expect((a as { originProducerId?: string }).originProducerId).toBe('ORIGIN-1');
    expect((a as { hopTtl?: number }).hopTtl).toBe(2);
  });
  it('a pre-tree announce (no origin/hopTtl) records them undefined (byte-stable)', () => {
    const reg = new InterRelayProducerRegistry();
    reg.record({ type: 'pipe-producer', roomId: 'r', producerId: 'p', kind: 'audio' } as never);
    const [a] = reg.resolveAll('r');
    expect('originProducerId' in (a as object)).toBe(false);
    expect('hopTtl' in (a as object)).toBe(false);
  });
});
