/**
 * Unit tests for cascade-tree Phase T-B tree-aware forwarding.
 * REQ-RMS-042 / 044 / 046 / 048.
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildPipeProducerAnnounce, isPipeProducerAnnounce, deriveTree, treeRoleOf, toCanonicalRelayId, produceLocalFromPipe, InterRelayProducerRegistry, StandbyWarmPipeCoordinator } from '@dvconf/inter-relay-client';
import type { RoomTopology } from '@dvconf/inter-relay-client';
import { deriveTreePosition, fanTargets, fanTargetUrls, nextHopTtl } from '../tree-position.js';

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

// ── coordinator drain harness (compact mirror of inter-relay-warmpipe.test.ts) ──

function makeMockConsumer() {
  return { id: `c-${Math.random().toString(36).slice(2)}`, paused: false, pause: vi.fn().mockResolvedValue(undefined), resume: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
}
function makeMockRouter() {
  const transports: Array<{ produce: ReturnType<typeof vi.fn> }> = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const t = {
        id: `pt-${Math.random().toString(36).slice(2)}`,
        consume: vi.fn().mockResolvedValue(makeMockConsumer()),
        connect: vi.fn().mockResolvedValue(undefined),
        produce: vi.fn(async (o: { id?: string; kind: string }) => ({ id: o.id ?? `fresh-${Math.random().toString(36).slice(2)}`, kind: o.kind, close: vi.fn() })),
        tuple: { localIp: '127.0.0.1', localPort: 40000 },
        close: vi.fn(),
      };
      transports.push(t);
      return t;
    }),
    rtpCapabilities: {} as never,
  };
  return { router, transports };
}
function makeStandbyTopology(roomId: string): RoomTopology {
  return { roomId, role: 'standby', primaryEndpoint: 'ws://primary:4000', standbyEndpoint: 'ws://standby:4000', pipePort: 40000, pipeConsumer: null, pipeTransport: null } as RoomTopology;
}
const rtp = (ssrc: number): never => ({ codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }], encodings: [{ ssrc }] } as never);

describe('per-room origin dedup at the forward drain (T6/B4, N4)', () => {
  const ROOM = 'room-b4';
  it('same originProducerId on two edges → exactly ONE local mint (per-room dedup)', async () => {
    const registry = new InterRelayProducerRegistry();
    // Two parent edges: DISTINCT peerRelayId + DISTINCT per-hop producerId, SAME immutable origin.
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-A', kind: 'video', peerRelayId: 'relay-A', rtpParameters: rtp(11), originProducerId: 'ORIGIN-1' } as never);
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-B', kind: 'video', peerRelayId: 'relay-B', rtpParameters: rtp(22), originProducerId: 'ORIGIN-1' } as never);
    // treeActive: true (5th positional flag).
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, vi.fn(), true, true);
    const rA = makeMockRouter();
    const rB = makeMockRouter();
    await coord.ensure(makeStandbyTopology(ROOM), rA.router as never, 40000, 'relay-A');
    await coord.ensure(makeStandbyTopology(ROOM), rB.router as never, 40001, 'relay-B');
    const totalProduce = [...rA.transports, ...rB.transports].reduce((n, t) => n + t.produce.mock.calls.length, 0);
    expect(totalProduce).toBe(1); // the double-parent collapses to ONE origin mint
  });
  it('two DISTINCT originProducerIds → two mints', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-A', kind: 'video', peerRelayId: 'relay-A', rtpParameters: rtp(11), originProducerId: 'ORIGIN-1' } as never);
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-B', kind: 'video', peerRelayId: 'relay-B', rtpParameters: rtp(22), originProducerId: 'ORIGIN-2' } as never);
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, vi.fn(), true, true);
    const rA = makeMockRouter();
    const rB = makeMockRouter();
    await coord.ensure(makeStandbyTopology(ROOM), rA.router as never, 40000, 'relay-A');
    await coord.ensure(makeStandbyTopology(ROOM), rB.router as never, 40001, 'relay-B');
    const totalProduce = [...rA.transports, ...rB.transports].reduce((n, t) => n + t.produce.mock.calls.length, 0);
    expect(totalProduce).toBe(2); // distinct origins → distinct mints
  });
});

describe('producedOrigins teardown lifecycle (T6/B4, I1)', () => {
  const ROOM = 'room-i1';
  it('per-leg clear() does NOT drop the room origin set → a surviving sibling leg does NOT re-mint the still-live origin', async () => {
    const registry = new InterRelayProducerRegistry();
    // Two legs of ONE room carrying the SAME immutable origin (distinct per-hop ids).
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-A', kind: 'video', peerRelayId: 'relay-A', rtpParameters: rtp(11), originProducerId: 'ORIGIN-1' } as never);
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-B', kind: 'video', peerRelayId: 'relay-B', rtpParameters: rtp(22), originProducerId: 'ORIGIN-1' } as never);
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, vi.fn(), true, true);
    const rA = makeMockRouter();
    const rB = makeMockRouter();
    // Leg A drains + mints ORIGIN-1 once.
    await coord.ensure(makeStandbyTopology(ROOM), rA.router as never, 40000, 'relay-A');
    // Tear down ONLY leg A (per-leg clear) — leg B is still live.
    coord.clear(ROOM, 'relay-A');
    // Drive the SURVIVING sibling leg B for the SAME origin.
    await coord.ensure(makeStandbyTopology(ROOM), rB.router as never, 40001, 'relay-B');
    const totalProduce = [...rA.transports, ...rB.transports].reduce((n, t) => n + t.produce.mock.calls.length, 0);
    // The per-room origin set survived the per-leg clear → NO silent double-produce (the
    // freshId path has no "already exists" throw to catch it). A buggy per-leg delete → 2.
    expect(totalProduce).toBe(1);
  });
  it('clearRoom() DOES drop the room origin set → a fresh drive of the same origin re-mints', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: ROOM, producerId: 'hop-A', kind: 'video', peerRelayId: 'relay-A', rtpParameters: rtp(11), originProducerId: 'ORIGIN-1' } as never);
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, vi.fn(), true, true);
    const r1 = makeMockRouter();
    const r2 = makeMockRouter();
    // First drive mints ORIGIN-1.
    await coord.ensure(makeStandbyTopology(ROOM), r1.router as never, 40000, 'relay-A');
    // Room-wide teardown drops the origin set.
    coord.clearRoom(ROOM);
    // A fresh drive of the SAME origin now re-mints (the reused room started clean).
    await coord.ensure(makeStandbyTopology(ROOM), r2.router as never, 40000, 'relay-A');
    const totalProduce = [...r1.transports, ...r2.transports].reduce((n, t) => n + t.produce.mock.calls.length, 0);
    expect(totalProduce).toBe(2); // clearRoom cleared the set → re-mint
  });
});
