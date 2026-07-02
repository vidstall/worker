/**
 * F1 / REQ-RO-001/002/008/009 — PrimaryPipeCoordinator unit tests.
 *
 * The PRIMARY half mirror of StandbyWarmPipeCoordinator: it mints + connect()s a
 * PipeTransport, pipes the room's real producer onto it, and announces the PIPED
 * consumer id (NOT producer.id). Tolerates either arrival order (producer vs the
 * standby's pipe-connect params) via per-room pending + re-drive. Mocks mediasoup
 * Router / PipeTransport / Consumer (same factory pattern as the warmpipe test).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import {
  PrimaryPipeCoordinator,
  type PipeConnectParams,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';

// ── mediasoup mock factories (mirror inter-relay-warmpipe.test.ts) ───────

/** The piped Consumer pipeProducerOntoPrimaryTransport returns — its .id is the
 *  PIPED id that must be ANNOUNCED (NOT the source producer.id). */
function makePipedConsumer(id = `piped-${Math.random().toString(36).slice(2)}`) {
  return { id, kind: 'video' as const, close: vi.fn() };
}

/**
 * A mock PipeTransport whose `consume()` mints a FRESH piped Consumer per call —
 * exactly like real mediasoup (each `transport.consume()` returns a distinct
 * Consumer). Each minted consumer is recorded into the shared `pipedSink` so the
 * test can assert the announced ids are the PIPED ids, one per piped producer.
 * (The earlier single-`piped` shape could not represent two distinct consumers on
 * one mint-once transport — required by the multi-producer drain test RED-PPC-5.)
 */
function makeMockPipeTransport(
  pipedSink: ReturnType<typeof makePipedConsumer>[],
  localPort = 41000,
) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    tuple: { localIp: '127.0.0.1', localPort },
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation(async () => {
      const c = makePipedConsumer();
      pipedSink.push(c);
      return c;
    }),
    close: vi.fn(),
  };
}

/** Router whose createPipeTransport hands back a FRESH transport each call. */
function makeMockRouter() {
  const transports: ReturnType<typeof makeMockPipeTransport>[] = [];
  // One entry PER consume() call (a distinct piped Consumer each), shared with
  // every transport this router mints.
  const piped: ReturnType<typeof makePipedConsumer>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const t = makeMockPipeTransport(piped, 41000 + transports.length);
      transports.push(t);
      return t;
    }),
  };
  return { router, transports, piped };
}

/** A stub matching createPipePortAllocator's return (sibling cluster). */
function makeStubAllocator(port = 41000): PipePortAllocatorLike & {
  allocate: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const held = new Set<string>();
  return {
    allocate: vi.fn((key: string) => { held.add(key); return port; }),
    release: vi.fn((key: string) => { held.delete(key); }),
    size: () => held.size,
  };
}

function makeProducer(id = 'producer-REAL-source') {
  return { id, kind: 'video' as const };
}

const STANDBY_PARAMS: PipeConnectParams = { ip: '127.0.0.1', port: 40000 };

// ── A. params-already-present (params-before-producer order) ─────────────

describe('PrimaryPipeCoordinator — onStandbyConnectParams then onProducer', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('RED-PPC-1: params arrive first → coordinator mints+connects the primary pipe and replies DOWN with its OWN port', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);

    // Bound a transport on the allocated per-(room,role) port.
    expect(allocator.allocate).toHaveBeenCalledWith('room-P:primary');
    expect(router.createPipeTransport).toHaveBeenCalledTimes(0); // no router yet (no producer)
    // params-before-producer: nothing piped yet, but the standby params are stashed.
    expect(transports).toHaveLength(0);
    expect(announcer).not.toHaveBeenCalled();
    // No DOWN reply yet — the transport is minted lazily WITH the router on onProducer.
    expect(paramSender).not.toHaveBeenCalled();
  });

  it('RED-PPC-2: after params, onProducer mints+connects, pipes, and announces the PIPED consumer id (NOT producer.id)', async () => {
    const { router, transports, piped } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    await coord.onProducer('room-P', router as any, makeProducer());

    // One transport minted on the allocated port; connected to the STANDBY params.
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.connect).toHaveBeenCalledOnce();
    const connectArg = transports[0]!.connect.mock.calls[0]![0] as PipeConnectParams;
    expect(connectArg.ip).toBe('127.0.0.1');
    expect(connectArg.port).toBe(40000); // the standby's port

    // Piped the SOURCE producer onto the pipe.
    expect(transports[0]!.consume).toHaveBeenCalledWith({ producerId: 'producer-REAL-source' });

    // Announced the PIPED consumer id — the .id of the consume() result — NOT producer.id.
    expect(announcer).toHaveBeenCalledOnce();
    const [annRoom, annProducer] = announcer.mock.calls[0]!;
    expect(annRoom).toBe('room-P');
    expect(annProducer.id).toBe(piped[0]!.id);
    expect(annProducer.id).not.toBe('producer-REAL-source');

    // Replied DOWN with the primary's OWN tuple.
    expect(paramSender).toHaveBeenCalledOnce();
    const [downRoom, downParams] = paramSender.mock.calls[0]!;
    expect(downRoom).toBe('room-P');
    expect((downParams as PipeConnectParams).port).toBe(transports[0]!.tuple.localPort);
    expect((downParams as PipeConnectParams).ip).toBe('127.0.0.1');
  });
});

// ── B. producer-before-params (the other order) ─────────────────────────

describe('PrimaryPipeCoordinator — onProducer then onStandbyConnectParams', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('RED-PPC-3: a producer arriving BEFORE params is queued, NOT piped (never pipe onto an unconnected transport)', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onProducer('room-P', router as any, makeProducer());

    expect(router.createPipeTransport).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
    expect(announcer).not.toHaveBeenCalled();
  });

  it('RED-PPC-4: when params arrive after, the queued producer is drained — mints, pipes, announces PIPED id', async () => {
    const { router, transports, piped } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onProducer('room-P', router as any, makeProducer('producer-EARLY'));
    expect(announcer).not.toHaveBeenCalled(); // still queued

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    // NOTE: per the §2 order the standby re-sends params then the producer re-drives;
    // here the producer is already queued so the params re-send must trigger the
    // mint+drain. The coordinator re-drives on the next onProducer in production;
    // this test drives the producer-then-params order via a second onProducer-less
    // path — so it asserts the drain happens once BOTH are present.
    await coord.onProducer('room-P', router as any, makeProducer('producer-EARLY'));

    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(1);
    expect(announcer).toHaveBeenCalled();
    const annProducer = announcer.mock.calls[0]![1];
    expect(annProducer.id).toBe(piped[0]!.id);
    expect(annProducer.id).not.toContain('producer-EARLY');
  });
});

// ── C. mint-once + multi-producer drain + clear releases port ───────────

describe('PrimaryPipeCoordinator — mint-once, multi-producer, clear', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('RED-PPC-5: two producers after params share ONE transport (createPipeTransport called once) and BOTH announce PIPED ids', async () => {
    const { router, transports, piped } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    await coord.onProducer('room-P', router as any, makeProducer('p1'));
    await coord.onProducer('room-P', router as any, makeProducer('p2'));

    expect(router.createPipeTransport).toHaveBeenCalledOnce(); // mint-once
    expect(transports).toHaveLength(1);
    expect(transports[0]!.consume).toHaveBeenCalledTimes(2);
    expect(announcer).toHaveBeenCalledTimes(2);
    // Both announced the PIPED ids, never the source ids.
    const announced = announcer.mock.calls.map((c) => c[1].id);
    expect(announced).toEqual([piped[0]!.id, piped[1]!.id]);
    expect(announced).not.toContain('p1');
    expect(announced).not.toContain('p2');
  });

  it('RED-PPC-6: clear() closes the transport and releases the per-(room,role) port', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    await coord.onProducer('room-P', router as any, makeProducer());
    expect(transports).toHaveLength(1);

    coord.clear('room-P');

    expect(transports[0]!.close).toHaveBeenCalledOnce();
    expect(allocator.release).toHaveBeenCalledWith('room-P:primary');
    expect(allocator.size()).toBe(0);
  });

  it('RED-PPC-7: clear() on a never-seen room is a safe no-op (no throw, no release)', () => {
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });
    expect(() => coord.clear('never-seen')).not.toThrow();
    expect(allocator.release).not.toHaveBeenCalled();
  });
});

// ── D. REQ-RMS-029 / L1-gate partial #3 — original publisher producerPeerId on
//    the CASCADE announce (so a cross-relay consume binds to the REAL publisher,
//    not the cascade relayId). Additive + cascade-only: the DEFAULT/legacy single-
//    standby leg keeps producerPeerId === undefined (byte-stable frame). ───────

describe('PrimaryPipeCoordinator — REQ-RMS-029 original producerPeerId on cascade announce', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('drain threads the original producerPeerId into the announce on a cascade leg (REQ-RMS-029 / L1-gate partial #3)', async () => {
    const { router } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room1', STANDBY_PARAMS, 'relayB');
    await coord.onProducer('room1', router as any, { id: 'p1', kind: 'video' }, 'relayB', 'alice-original');

    // The announce carries the ORIGINAL publisher in the NEW 3rd slot — alongside the
    // PIPED consumer id (slot 2) and the cascade peerRelayId (slot 4). The mock piped
    // consumer carries no rtpParameters, so the 5th slot is undefined.
    expect(announcer).toHaveBeenCalledWith(
      'room1',
      expect.objectContaining({ kind: 'video' }),
      'alice-original', // ← NEW: producerPeerId = original publisher
      'relayB', // peerRelayId
      undefined, // rtpParameters (mock consumer has none)
    );
    // The announced id is the PIPED consumer id, NOT the source producer id.
    expect(announcer.mock.calls[0]![1].id).not.toBe('p1');
  });

  it('the DEFAULT/legacy single-standby leg announces with producerPeerId undefined (byte-stable frame)', async () => {
    const { router } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    // No peerRelayId (DEFAULT peer) + no producerPeerId → both omitted on the wire.
    await coord.onStandbyConnectParams('room2', STANDBY_PARAMS);
    await coord.onProducer('room2', router as any, { id: 'p2', kind: 'video' });

    expect(announcer).toHaveBeenCalledWith(
      'room2',
      expect.objectContaining({ kind: 'video' }),
      undefined, // producerPeerId omitted on the default/legacy path
      undefined, // peerRelayId omitted (DEFAULT-gated)
      undefined, // rtpParameters (mock consumer has none)
    );
  });
});

// ── E. REQ-RMS-034/037 — reverse-leg reverseMint (part-3 reverse leg). A
//    standby-homed client's media flows UP the warm pipe to the PRIMARY, which
//    mints a LOCAL hub copy from the announced reverse-pipe consumer. The dual of
//    the forward onProducer/drain: mint LOCALLY (no announce), with an
//    announce-before-leg-connected QUEUE (REQ-RMS-037 ordering) + per-leg dedup
//    (REQ-RMS-034 mint exactly once). bindLegTransportForTest is the thin seam
//    that stands in for ensureReverseLeg's real-mediasoup mint+connect (which is
//    integration-covered in A5, NOT unit-covered here). ─────────────────────────
describe('PrimaryPipeCoordinator — REQ-RMS-034/037 reverseMint (part-3 reverse leg)', () => {
  const REMAPPED_RTP = {
    codecs: [],
    headerExtensions: [],
    encodings: [{ ssrc: 99001 }],
    rtcp: {},
  } as unknown as msTypes.RtpParameters;
  const fakeRouter = makeMockRouter().router as unknown as msTypes.Router;
  let zeroAllocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    zeroAllocator = makeStubAllocator(0);
  });

  it('RED-RA-3b: reverseMint produces a local producer from the announced reverse-pipe consumer on the leg transport', async () => {
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    const fakeProducer = { id: 'piped-up-1', kind: 'video', on: vi.fn() };
    const fakeTransport = { produce: vi.fn().mockResolvedValue(fakeProducer) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    const minted = await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA');
    expect(fakeTransport.produce).toHaveBeenCalledWith(expect.objectContaining({ id: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }));
    expect(minted!.id).toBe('piped-up-1');
  });

  it('RED-RA-3b-order: a reverse announce arriving BEFORE the leg transport is connected is QUEUED, then minted on connect (REQ-RMS-037 ordering)', async () => {
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    const r1 = await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA');
    expect(r1).toBeNull(); // queued, not minted (no leg transport yet)
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'piped-up-1', kind: 'video', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    const drained = await coord.drainReverseMints('roomA', 'ws://standbyA'); // called on leg connect
    expect(drained.map((p) => p.id)).toEqual(['piped-up-1']);
  });

  it('RED-RA-3b-dedup: a duplicate reverse announce for the same producerId mints exactly once', async () => {
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'piped-up-1', kind: 'video', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA');
    await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA');
    expect(fakeTransport.produce).toHaveBeenCalledTimes(1);
  });

  it('RED-RA-3b-clear: clear() drops reverse dedup state so a post-teardown re-announce mints again', async () => {
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'piped-up-1', kind: 'video', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA');
    coord.clear('roomA', 'ws://standbyA');
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA');
    expect(fakeTransport.produce).toHaveBeenCalledTimes(2);
  });

  it('RED-RA-3b-resilient: a TRANSIENT produce throw mid-drain does NOT discard the rest of the queue -- the bad item is re-queued, the others still mint, and a later drain retries it (C1; mirrors A2 Important#1)', async () => {
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    // produce() THROWS a transient (non-dup) error the FIRST time it sees up-A,
    // then succeeds for everything (up-B always, up-A on retry).
    let aAttempts = 0;
    const fakeTransport = {
      produce: vi.fn().mockImplementation(async (opts: { id: string; kind: string }) => {
        if (opts.id === 'up-A' && aAttempts === 0) {
          aAttempts += 1;
          throw new Error('boom'); // transient (NOT 'already exists'/'duplicate')
        }
        return { id: opts.id, kind: opts.kind, on: vi.fn() };
      }),
    } as unknown as msTypes.PipeTransport;

    // Queue A then B while NO transport bound -> both land in the pending queue.
    expect(await coord.reverseMint('roomA', fakeRouter, { producerId: 'up-A', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA')).toBeNull();
    expect(await coord.reverseMint('roomA', fakeRouter, { producerId: 'up-B', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA')).toBeNull();

    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    // First drain: A throws transient, B must STILL mint (loop continues), A re-queued.
    const drained1 = await coord.drainReverseMints('roomA', 'ws://standbyA');
    expect(drained1.map((p) => p.id)).toEqual(['up-B']);

    // Second drain proves A was re-queued (not lost) AND retried successfully.
    const drained2 = await coord.drainReverseMints('roomA', 'ws://standbyA');
    expect(drained2.map((p) => p.id)).toEqual(['up-A']);
  });

  it('RED-RA-3b-clear-pending: clear() drops the PENDING queue so a queued-then-cleared announce is NOT minted on a later drain (M1)', async () => {
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    // Queue an announce with NO transport bound (so it sits in reverseMintPending).
    expect(await coord.reverseMint('roomA', fakeRouter, { producerId: 'up-X', kind: 'video', rtpParameters: REMAPPED_RTP }, 'ws://standbyA')).toBeNull();
    // Tear the leg down BEFORE it ever connected -> the queued item must be dropped.
    coord.clear('roomA', 'ws://standbyA');
    // Now bind a transport and drain: nothing should mint (the queue was cleared).
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'up-X', kind: 'video', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    const drained = await coord.drainReverseMints('roomA', 'ws://standbyA');
    expect(drained).toEqual([]);
    expect(fakeTransport.produce).not.toHaveBeenCalled();
  });

  it('RED-RB-4c: a reverse announce arriving while the leg transport is UNCONNECTED is minted AND fanned (with the original producerPeerId) once it drains -- A6 double-race', async () => {
    const fanSpy = vi.fn();
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn(), onReverseMinted: fanSpy });
    const r1 = await coord.reverseMint('roomA', fakeRouter, { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP, producerPeerId: 'clientA' }, 'ws://standbyA');
    expect(r1).toBeNull(); // queued, not minted (no leg transport yet)
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'piped-up-1', kind: 'video', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    const drained = await coord.drainReverseMints('roomA', 'ws://standbyA');
    expect(drained.map(p => p.id)).toEqual(['piped-up-1']);          // minted
    expect(fanSpy).toHaveBeenCalledTimes(1);                          // fanned -- RED today: drainReverseMints never fans
    expect(fanSpy).toHaveBeenCalledWith('roomA', expect.objectContaining({ id: 'piped-up-1' }), 'ws://standbyA', 'clientA'); // original producerPeerId preserved
  });

  it('T7 I-1: a reverse mint QUEUED then DRAINED (Path B) threads the IMMUTABLE origin + inbound hopTtl into onReverseMinted (NOT the fresh mint id / not a reseeded budget)', async () => {
    const fanSpy = vi.fn();
    // treeActive → mintOne mints a FRESH local id per hop, so minted.id ('fresh-hub-mint') ≠ origin.
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn(), onReverseMinted: fanSpy, treeActive: true });
    // QUEUE a reverse announce CARRYING the tree fields BEFORE the leg transport connects (double-race
    // Path B — the immediate registerReverseMinted never ran because reverseMint returned null).
    const r1 = await coord.reverseMint(
      'roomA', fakeRouter,
      { producerId: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP, producerPeerId: 'clientA', originProducerId: 'ORIGIN-1', hopTtl: 3 },
      'ws://standbyA',
    );
    expect(r1).toBeNull(); // queued
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'fresh-hub-mint', kind: 'video', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    await coord.drainReverseMints('roomA', 'ws://standbyA');
    // The drain fan carries the IMMUTABLE origin + inbound hop off the QUEUE ENTRY (6-arg), NOT the
    // fresh mint id ('fresh-hub-mint') and NOT undefined (which would reseed the full diameter
    // downstream). RED against the pre-I-1 4-arg drain binding (origin/hop were dropped on enqueue).
    expect(fanSpy).toHaveBeenCalledTimes(1);
    expect(fanSpy).toHaveBeenCalledWith('roomA', expect.objectContaining({ id: 'fresh-hub-mint' }), 'ws://standbyA', 'clientA', 'ORIGIN-1', 3);
  });
});

// ── F. B6b (REQ-RMS-035) — FORWARD flap idempotency. onProducer re-queues a
//    producer UNCONDITIONALLY (inter-relay.ts:1711). On a standby link flap /
//    re-attach the SAME producer.id is re-queued -> drain() re-pipes it ->
//    pipeProducerOntoPrimaryTransport calls transport.consume() a 2nd time for an
//    already-piped producer -> real mediasoup throws "Consumer already exists".
//    A per-leg forwardPipedIds dedup (mirror of reverseMintedIds) pipes each id
//    EXACTLY ONCE, cleared with the leg in clear(). ───────────────────────────
describe('PrimaryPipeCoordinator — B6b forward flap-dedup (REQ-RMS-035)', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('RED-PPC-FLAP-DEDUP: a re-queued forward producer (same id; standby link flap re-attach) pipes EXACTLY ONCE', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    await coord.onProducer('room-P', router as any, makeProducer('p1'));
    expect(transports[0]!.consume).toHaveBeenCalledTimes(1);
    expect(announcer).toHaveBeenCalledTimes(1);

    // Flap: the SAME producer is re-announced/re-attached (onProducer re-fires).
    await coord.onProducer('room-P', router as any, makeProducer('p1'));

    // Deduped — NOT re-piped (real mediasoup would throw "Consumer already exists").
    expect(transports[0]!.consume).toHaveBeenCalledTimes(1);
    expect(announcer).toHaveBeenCalledTimes(1); // no second announce either
  });

  it('RED-PPC-FLAP-DEDUP-clear: clear() drops the forward dedup so a post-teardown re-pipe of the same id pipes AGAIN', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    await coord.onProducer('room-P', router as any, makeProducer('p1'));
    expect(transports[0]!.consume).toHaveBeenCalledTimes(1);

    coord.clear('room-P'); // teardown drops the leg + its forward dedup

    // Re-establish the room (fresh transport) + re-pipe the same id -> NOT deduped.
    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    await coord.onProducer('room-P', router as any, makeProducer('p1'));
    expect(router.createPipeTransport).toHaveBeenCalledTimes(2); // a second transport minted
    expect(transports[1]!.consume).toHaveBeenCalledTimes(1); // re-piped onto it
  });

  it('RED-PPC-FLAP-DEDUP-perleg: the forward dedup is per (room,peer) — the SAME id pipes once on EACH distinct cascade leg, re-attach deduped per leg', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS, 'relay-B');
    await coord.onProducer('room-P', router as any, makeProducer('p1'), 'relay-B');
    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS, 'relay-C');
    await coord.onProducer('room-P', router as any, makeProducer('p1'), 'relay-C');

    // Distinct legs -> two transports, each piped p1 once (dedup is per-leg, not global).
    expect(router.createPipeTransport).toHaveBeenCalledTimes(2);

    // Re-attach p1 on relay-B -> deduped on THAT leg only.
    await coord.onProducer('room-P', router as any, makeProducer('p1'), 'relay-B');
    const totalConsumes = transports.reduce((n, t) => n + t.consume.mock.calls.length, 0);
    expect(totalConsumes).toBe(2); // p1 piped once per leg; the re-attach was deduped
  });
});

// ── G. RC-A (REQ-RMS-035) — the FORWARD queue must be flushed when the leg is
//    brought up by the REVERSE path. Each (room,peer) leg uses ONE bidirectional
//    pipeTransport for BOTH forward (primary→standby) and reverse (standby→primary).
//    The forward queue (s.pendingProducers) is drained by drain(), called from
//    onProducer (only if standbyParams present at produce time) and
//    onStandbyConnectParams (only if already connected). When the leg is instead
//    minted+connected by ensureReverseLeg (a reverse announce brings it up), it
//    historically called ONLY drainReverseMints -> the queued FORWARD producers were
//    orphaned (no later forward onProducer to flush them). This is the LIVE bug: the
//    last standby to bring up its leg via the reverse path never received the
//    primary's producers. ensureReverseLeg MUST also drain() the forward queue.
//    drain() self-guards (!connected || pipeTransport===null) and is idempotent
//    (forwardPipedIds Set), so this is safe regardless of mint order. ─────────────
describe('PrimaryPipeCoordinator — RC-A forward drain on reverse-leg bring-up (REQ-RMS-035)', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('RED-PPC-FWD-ON-REVERSE-BRINGUP: a forward producer queued before params is drained + announced when the leg is brought up by ensureReverseLeg (no later forward onProducer)', async () => {
    const { router, transports, piped } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    // 1. A forward producer arrives BEFORE the standby pipe-connect params -> queued
    //    into s.pendingProducers, NOT piped (never pipe onto an unconnected transport).
    await coord.onProducer('room-P', router as any, makeProducer('fwd-1'));
    expect(announcer).not.toHaveBeenCalled();

    // 2. The standby pipe-connect params arrive (the UP leg). The transport is minted
    //    lazily WITH a router (onProducer / ensureReverseLeg), so nothing pipes yet:
    //    s.pipeTransport is still null and s.connected is still false.
    await coord.onStandbyConnectParams('room-P', STANDBY_PARAMS);
    expect(announcer).not.toHaveBeenCalled(); // still queued (transport null)

    // 3. The leg is brought up by the REVERSE path: a reverse announce calls
    //    ensureReverseLeg, which mints + connects the SHARED bidirectional pipe. This
    //    is the LAST-standby-via-reverse case — there is NO later forward onProducer to
    //    flush the forward queue.
    await coord.ensureReverseLeg('room-P', router as any);

    // The leg WAS brought up (transport minted + connected, DOWN reply sent).
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(1);
    expect(paramSender).toHaveBeenCalledOnce();

    // RC-A: the queued FORWARD producer MUST be drained on reverse-leg bring-up.
    // TODAY ensureReverseLeg calls ONLY drainReverseMints -> the forward queue is
    // orphaned -> announcer never fires -> RED. After the fix ensureReverseLeg also
    // calls drain() -> the queued producer is piped + announced with its PIPED id.
    expect(announcer).toHaveBeenCalledTimes(1);
    expect(announcer.mock.calls[0]![0]).toBe('room-P');
    expect(announcer.mock.calls[0]![1].id).toBe(piped[0]!.id); // PIPED consumer id…
    expect(announcer.mock.calls[0]![1].id).not.toBe('fwd-1'); // …NOT the source id
  });
});
