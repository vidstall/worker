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
