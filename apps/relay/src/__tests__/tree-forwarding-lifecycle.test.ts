/**
 * Unit tests for cascade-tree Phase T-B tree-aware forwarding — the
 * StandbyWarmPipeCoordinator origin-dedup / teardown lifecycle, the T7
 * coordinator callback threading (originProducerId + hopTtl survive the
 * mint/queue/drain), and the T8 make-before-break re-parent primitive.
 * REQ-RMS-042 / 044 / 046 / 048.
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect, vi } from 'vitest';
import { InterRelayProducerRegistry, StandbyWarmPipeCoordinator, makeReparentHarness } from '@dvconf/inter-relay-client';
import type { RoomTopology } from '@dvconf/inter-relay-client';
import { seedOrDecrementHop } from '../tree-position.js';
import { makeOnReverseAnnounce } from '../reverse-announce-handler.js';

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

// ── T7 (REQ-RMS-042/043/044/046) — the coordinator CALLBACK threading each fan site depends on ──
//
// SCOPE (honest — no circular claim): these unit-prove the COORDINATOR CALLBACK THREADING only
// (originProducerId + hopTtl survive the mint/queue/drain). They do NOT cover the fanToTreeNeighbors
// plan→leg mapping (childUrls→onPrimaryProducer / parentUrl→onStandbyProducer), which is index.ts
// main-scoped: that mapping is REVIEW-ONLY (a T-C live obligation), NOT covered by the Task 9
// integration test (which RECONSTRUCTS the fan, so it can't see the signaling/index dispatch). The
// one signaling seam that WOULD break on a revert — the handleProduce own-produce HOIST — is covered
// RED-on-revert by tree-own-produce-hoist.test.ts (a spy on the REAL handleProduce). Here we pin:
// (1) the reverse hub-fan preserves the IMMUTABLE origin across the mint, (2) the internal-node
// received-DOWN re-forward callback receives the immutable origin + inbound hop budget, (3) the
// OWN-produce UP announce carries a seeded hop budget through the queued-then-drained path, and
// (4) the cascade terminates (hop guard + per-room origin dedup, no double-consume).

describe('T7 Step 3 — reverse hub-fan: originProducerId survives the reverse mint (REQ-RMS-043/046)', () => {
  const room = { router: {} } as never; // truthy room so the handler proceeds to reverseMint
  it('a reverse announce carrying originProducerId "O" + hopTtl 2 → registerReverseMinted receives "O" + 2 (NOT the fresh hub-mint id)', async () => {
    const registerReverseMinted = vi.fn();
    const mintedProducer = { id: 'fresh-hub-mint', kind: 'video' } as never; // fresh per-hop id ≠ origin
    const onReverseAnnounce = makeOnReverseAnnounce({
      ensureReverseLeg: vi.fn().mockResolvedValue(undefined),
      reverseMint: vi.fn().mockResolvedValue(mintedProducer),
      getRoom: () => room,
      registerReverseMinted,
    });
    // onReverseAnnounce(roomId, producerId, kind, rtpParameters, peerRelayId, producerPeerId, originProducerId, hopTtl)
    await onReverseAnnounce('roomZ', 'hop-3-id', 'video', rtp(42), 'ws://child', 'pub-1', 'O', 2);
    expect(registerReverseMinted).toHaveBeenCalledTimes(1);
    // registerReverseMinted(roomId, minted, originRelayId, producerPeerId, originProducerId, inboundHopTtl)
    expect(registerReverseMinted).toHaveBeenCalledWith('roomZ', mintedProducer, 'ws://child', 'pub-1', 'O', 2);
  });
  it('a pre-tree reverse announce (no origin/hopTtl) → registerReverseMinted called with the EXACT 4-arg tuple (byte-stable guard-widen)', async () => {
    const registerReverseMinted = vi.fn();
    const mintedProducer = { id: 'p', kind: 'video' } as never;
    const onReverseAnnounce = makeOnReverseAnnounce({
      ensureReverseLeg: vi.fn().mockResolvedValue(undefined),
      reverseMint: vi.fn().mockResolvedValue(mintedProducer),
      getRoom: () => room,
      registerReverseMinted,
    });
    await onReverseAnnounce('roomZ', 'p', 'video', rtp(42), 'ws://child', 'pub-1');
    expect(registerReverseMinted).toHaveBeenCalledWith('roomZ', mintedProducer, 'ws://child', 'pub-1');
    expect(registerReverseMinted.mock.calls[0]!.length).toBe(4); // no trailing undefined origin/hop
  });
});

describe('T7 Step 4 — internal-node received-DOWN re-forward: onLocalProducer threads origin + hopTtl (REQ-RMS-042/044/046)', () => {
  it('a forwarded announce carrying originProducerId + hopTtl → onLocalProducer gets the immutable origin + inbound hop (6-arg) for the DOWN re-forward', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'rD', producerId: 'hop-2', kind: 'video', peerRelayId: 'ws://parent', rtpParameters: rtp(5), originProducerId: 'ORIGIN-1', hopTtl: 2 } as never);
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true, true);
    const r = makeMockRouter();
    await coord.ensure(makeStandbyTopology('rD'), r.router as never, 40000, 'ws://parent');
    expect(onLocalProducer).toHaveBeenCalledTimes(1);
    const call = onLocalProducer.mock.calls[0]!;
    // (roomId, producer, producerPeerId, peerRelayId, originProducerId, inboundHopTtl)
    expect(call[0]).toBe('rD');
    expect(call[3]).toBe('ws://parent');            // the PARENT edge (receiveEdge for the DOWN re-forward)
    expect(call[4]).toBe('ORIGIN-1');               // IMMUTABLE origin (NOT the fresh per-hop mint id)
    expect(call[5]).toBe(2);                        // inbound hop budget threaded for the re-forward
    expect((call[1] as { id: string }).id).not.toBe('ORIGIN-1'); // the minted producer has a FRESH id
  });
  it('a pre-tree forwarded announce (no origin/hopTtl) → onLocalProducer gets the EXACT 4-arg tuple (shipped star path byte-stable)', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'rD2', producerId: 'p', kind: 'video', peerRelayId: 'ws://parent', rtpParameters: rtp(5) } as never);
    const onLocalProducer = vi.fn();
    // treeActive FALSE → shipped star path; onLocalProducer must fire the EXACT 4-arg tuple.
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true, false);
    const r = makeMockRouter();
    await coord.ensure(makeStandbyTopology('rD2'), r.router as never, 40000, 'ws://parent');
    expect(onLocalProducer).toHaveBeenCalledTimes(1);
    expect(onLocalProducer.mock.calls[0]!.length).toBe(4); // NO trailing undefined origin/hop
  });
});

describe('T7 Step 2 — OWN-produce UP announce: seeded hopTtl + origin survive queue→drain (REQ-RMS-044/046)', () => {
  const REMAPPED = rtp(987654);
  it('a local produce QUEUED before the reverse leg connects, then drained, still emits hopTtl + originProducerId on the UP announce', async () => {
    const upAnnounce = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), undefined, vi.fn(), true, true);
    coord.setReverseAnnouncer(upAnnounce);
    // QUEUE (no transport bound yet) — carry the seeded exact-diameter budget (4) + immutable origin.
    await coord.onLocalClientProducer('rQ', {} as never, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://parent', 4, 'ORIGIN-1');
    expect(upAnnounce).not.toHaveBeenCalled();
    // Bind the transport + drain (mirrors onPrimaryConnectParams after transport.connect()).
    coord.bindPipeTransportForTest('rQ', 'ws://parent', { consume: vi.fn().mockResolvedValue({ id: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED }) } as never);
    await coord.drainReverse('rQ', 'ws://parent');
    expect(upAnnounce).toHaveBeenCalledTimes(1);
    // 7-arg announce: (roomId, piped, producerPeerId, scopedPeer, rtpParameters, hopTtl, originProducerId)
    expect(upAnnounce).toHaveBeenCalledWith('rQ', { id: 'piped-up-1', kind: 'video' }, 'clientA', 'ws://parent', REMAPPED, 4, 'ORIGIN-1');
  });
});

describe('T7 N5 — cascade terminates: hop guard + per-room origin dedup (no double-consume) (REQ-RMS-044/046)', () => {
  it('a forwarded producer with hopTtl 1 fires onLocalProducer (fan-local) but the re-forward hop resolves to 0 → the <= 0 guard drops the tree re-forward', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'rN5', producerId: 'hop-last', kind: 'video', peerRelayId: 'ws://parent', rtpParameters: rtp(9), originProducerId: 'ORIGIN-1', hopTtl: 1 } as never);
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true, true);
    const r = makeMockRouter();
    await coord.ensure(makeStandbyTopology('rN5'), r.router as never, 40000, 'ws://parent');
    // fan-local STILL happens (the producer was minted + the callback fired) with hopTtl==1 ...
    expect(onLocalProducer).toHaveBeenCalledTimes(1);
    expect(onLocalProducer.mock.calls[0]![5]).toBe(1);
    // ... but the re-forward the callback drives is hop-guarded: seedOrDecrementHop(1, D) == 0 →
    // fanToTreeNeighbors' `<= 0` guard fires → NO re-forward to tree edges (cascade terminates).
    expect(seedOrDecrementHop(1, 3)).toBe(0);
  });
  it('an internal node re-forward of a MINTED producer does NOT double-consume: the same origin on two parent edges is minted EXACTLY once (per-room origin dedup)', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'rN5b', producerId: 'hop-A', kind: 'video', peerRelayId: 'ws://pA', rtpParameters: rtp(11), originProducerId: 'ORIGIN-1', hopTtl: 3 } as never);
    registry.record({ type: 'pipe-producer', roomId: 'rN5b', producerId: 'hop-B', kind: 'video', peerRelayId: 'ws://pB', rtpParameters: rtp(22), originProducerId: 'ORIGIN-1', hopTtl: 3 } as never);
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true, true);
    const rA = makeMockRouter();
    const rB = makeMockRouter();
    await coord.ensure(makeStandbyTopology('rN5b'), rA.router as never, 40000, 'ws://pA');
    await coord.ensure(makeStandbyTopology('rN5b'), rB.router as never, 40001, 'ws://pB');
    // ONE mint + ONE onLocalProducer → the DOWN re-forward runs once (no double-consume of the origin).
    expect(onLocalProducer).toHaveBeenCalledTimes(1);
  });
});

// ── T8 (REQ-RMS-046, §3.4) — make-before-break re-parent PRIMITIVE ──
//
// A SYNTHETIC layout diff (no real relay death, no live media path — that is T-C).
// The invariant: the NEW parent edge is opened + producing BEFORE the OLD parent
// edge is torn down, so local clients see continuous media (no gap). The per-hop
// FRESH local id (Task 5/T6) + per-room origin dedup (Task 5/B4) guarantee the
// transient double-parent during the overlap does NOT double-produce.

describe('make-before-break re-parent (T6, REQ-RMS-046)', () => {
  it('new parent edge produces BEFORE the old is closed (no gap)', async () => {
    const events: string[] = [];
    const h = makeReparentHarness({
      openEdge: (id: string) => events.push(`open:${id}`),
      produceOn: (id: string) => events.push(`produce:${id}`),
      closeEdge: (id: string) => events.push(`close:${id}`),
    });
    await h.reparent('room1', 'oldParent', 'newParent');
    expect(events).toEqual(['open:newParent', 'produce:newParent', 'close:oldParent']);
  });

  it('a node acquiring its FIRST parent (oldParentId=null) opens + produces but has NO old edge to close', async () => {
    const events: string[] = [];
    const h = makeReparentHarness({
      openEdge: (id: string) => events.push(`open:${id}`),
      produceOn: (id: string) => events.push(`produce:${id}`),
      closeEdge: (id: string) => events.push(`close:${id}`),
    });
    await h.reparent('room1', null, 'newParent');
    expect(events).toEqual(['open:newParent', 'produce:newParent']);
  });

  it('an UNCHANGED parent (old===new) is a complete no-op (never re-opens nor tears down the live edge)', async () => {
    const events: string[] = [];
    const h = makeReparentHarness({
      openEdge: (id: string) => events.push(`open:${id}`),
      produceOn: (id: string) => events.push(`produce:${id}`),
      closeEdge: (id: string) => events.push(`close:${id}`),
    });
    await h.reparent('room1', 'sameParent', 'sameParent');
    expect(events).toEqual([]);
  });

  it('AWAITS async effects sequentially — DESCENDING delays make forward order impossible unless each is awaited before the next is scheduled', async () => {
    const events: string[] = [];
    const defer = (label: string, ms: number) => new Promise<void>((resolve) => setTimeout(() => { events.push(label); resolve(); }, ms));
    // DESCENDING delays: open(30ms) > produce(20ms) > close(10ms). Same-delay timers
    // fire FIFO, so a broken "schedule all three up front, then await all" variant would
    // still land forward-order with equal delays — but with descending delays that variant
    // resolves close→produce→open (REVERSE). Forward order therefore holds ONLY if reparent
    // awaits each effect (so the next timer is not even scheduled until the prior resolved).
    const h = makeReparentHarness({
      openEdge: (id: string) => defer(`open:${id}`, 30),
      produceOn: (id: string) => defer(`produce:${id}`, 20),
      closeEdge: (id: string) => defer(`close:${id}`, 10),
    });
    await h.reparent('room1', 'oldParent', 'newParent');
    expect(events).toEqual(['open:newParent', 'produce:newParent', 'close:oldParent']);
  });
});
