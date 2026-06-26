/**
 * BENCH-2 / G1 tests — wire the PRIMARY's REAL pipe-producer ID across the
 * inter-relay warm-pipe so the STANDBY consumes the real producer (replacing
 * the `pipe-producer-pending-<roomId>` placeholder).
 *
 * Covers the two gaps the bench needs closed:
 *
 *   A. STANDBY warm-pipe orchestration (StandbyWarmPipeCoordinator):
 *      - registry HAS the primary's producerId  → ensureWarmPipe is called with
 *        that REAL id (not the placeholder).
 *      - NOT-READY path: registry returns null  → placeholder used + a later
 *        announce triggers a RE-RUN that resets topology.pipeConsumer and
 *        re-consumes with the real id (the L143-146 not-ready re-run contract).
 *      - REQ-RO-005 paused invariant preserved on both the placeholder consume
 *        and the real re-run consume.
 *
 *   B. PRIMARY announce link actually TRANSMITS (createWsInterRelaySender):
 *      - the sink wired in index.ts must put bytes on the wire when a live
 *        socket is attached (the prior index.ts sink was a no-op log stub —
 *        the announce never left the process). Best-effort: no socket / a
 *        throwing socket must not crash the produce path.
 *
 * Mocks mediasoup Router / PipeTransport / Consumer with the same factory
 * pattern as relay-role-manager.test.ts.
 *
 * Requirements: REQ-RO-004 (G1 warm-pipe producerId wiring), REQ-RO-005 (paused).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InterRelayProducerRegistry,
  StandbyWarmPipeCoordinator,
  createWsInterRelaySender,
  createInterRelayAnnouncer,
} from '@dvconf/inter-relay-client';
import type { RoomTopology } from '@dvconf/inter-relay-client';

// ── mediasoup mock factories (mirror relay-role-manager.test.ts) ─────────

function makeMockConsumer() {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused: false,
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

/** REQ-RMS-025 — a minted LOCAL producer (mock) the active-forward callback receives. */
function makeMockProducer(id: string, kind: string) {
  return { id, kind, close: vi.fn() };
}

/** The shape produceLocalFromPipe passes to transport.produce. */
type ProduceOpts = { id: string; kind: string };
/** Per-transport produce behaviour (default echoes a mock producer; tests inject throws). */
type ProduceImpl = (opts: ProduceOpts) => Promise<unknown>;

function makeMockPipeTransport(
  consumer: ReturnType<typeof makeMockConsumer>,
  produceImpl?: ProduceImpl,
) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    consume: vi.fn().mockResolvedValue(consumer),
    connect: vi.fn().mockResolvedValue(undefined),
    // REQ-RMS-025: produceLocalFromPipe calls transport.produce({id,kind,rtpParameters}).
    // Default echoes a mock producer (id+kind preserved); error tests inject a throw.
    produce: vi.fn(
      produceImpl ?? (async (opts: ProduceOpts) => makeMockProducer(opts.id, opts.kind)),
    ),
    tuple: { localIp: '127.0.0.1', localPort: 40000 },
    close: vi.fn(),
  };
}

/** A router whose createPipeTransport hands back a FRESH transport+consumer
 *  on every call (so a re-run consumes a distinct, real producer id). An optional
 *  produceImpl is applied to every created transport's produce (REQ-RMS-025 error tests). */
function makeMockRouter(produceImpl?: ProduceImpl) {
  const consumers: ReturnType<typeof makeMockConsumer>[] = [];
  const transports: ReturnType<typeof makeMockPipeTransport>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const consumer = makeMockConsumer();
      const transport = makeMockPipeTransport(consumer, produceImpl);
      consumers.push(consumer);
      transports.push(transport);
      return transport;
    }),
    rtpCapabilities: {} as any,
  };
  return { router, consumers, transports };
}

/** Mock structured logger — asserts the debug-vs-warn split (REQ-RMS-025 Fix 1). */
function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
}

/** Minimal valid-ish RtpParameters for a recorded announce (REQ-RMS-026). */
const rtpParams = (ssrc: number): any => ({
  codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc }],
});

function makeStandbyTopology(roomId = 'room-g1'): RoomTopology {
  return {
    roomId,
    role: 'standby',
    primaryEndpoint: 'ws://primary:4000',
    standbyEndpoint: 'ws://standby:4000',
    pipePort: 40000,
    pipeConsumer: null,
    pipeTransport: null,
  };
}

// ── A. StandbyWarmPipeCoordinator — resolve + pass real producerId ───────

describe('StandbyWarmPipeCoordinator — registry HAS producer (ready path)', () => {
  let registry: InterRelayProducerRegistry;
  let topology: RoomTopology;

  beforeEach(() => {
    registry = new InterRelayProducerRegistry();
    topology = makeStandbyTopology();
  });

  it('RED-BENCH2-1: ensureWarmPipe is called with the REAL producerId from the registry (not the placeholder)', async () => {
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-from-primary',
      kind: 'audio',
    });
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    const consumer = await coord.ensure(topology, router as any, 40000);

    expect(consumer).not.toBeNull();
    expect(transports).toHaveLength(1);
    const consumeArg = transports[0]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(consumeArg.producerId).toBe('producer-REAL-from-primary');
    // NOT the placeholder
    expect(consumeArg.producerId).not.toContain('pipe-producer-pending');
  });

  it('RED-BENCH2-2: ready path still pauses the consumer (REQ-RO-005 preserved)', async () => {
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL',
      kind: 'video',
    });
    const { router, consumers } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000);

    expect(consumers[0]!.pause).toHaveBeenCalledOnce();
  });
});

// ── B. NOT-READY path: placeholder then re-run on announce ──────────────

describe('StandbyWarmPipeCoordinator — NOT-READY path + announce re-run', () => {
  let registry: InterRelayProducerRegistry;
  let topology: RoomTopology;

  beforeEach(() => {
    registry = new InterRelayProducerRegistry();
    topology = makeStandbyTopology();
  });

  it('RED-BENCH2-3: when registry has NO producer yet, the placeholder is used', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000);

    const consumeArg = transports[0]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(consumeArg.producerId).toBe('pipe-producer-pending-room-g1');
  });

  it('RED-BENCH2-4: a later announce triggers a RE-RUN that resets pipeConsumer and re-consumes with the REAL id', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    // First join: not ready → placeholder + remembered for re-run.
    const firstConsumer = await coord.ensure(topology, router as any, 40000);
    expect(transports[0]!.consume.mock.calls[0]![0]).toMatchObject({
      producerId: 'pipe-producer-pending-room-g1',
    });
    expect(topology.pipeConsumer).toBe(firstConsumer);

    // Announce arrives (primary piped its real producer).
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // A second pipe was opened and consumed the REAL id.
    expect(reran).toBe(true);
    expect(transports).toHaveLength(2);
    const reconsumeArg = transports[1]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(reconsumeArg.producerId).toBe('producer-REAL-late');
    // topology now points at the fresh real consumer (was reset + re-set).
    expect(topology.pipeConsumer).not.toBe(firstConsumer);
    expect(topology.pipeConsumer).not.toBeNull();
  });

  it('RED-BENCH2-5: the re-run consumer is paused (REQ-RO-005 preserved across cutover)', async () => {
    const { router, consumers } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000); // placeholder
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // Both the placeholder consumer and the real re-run consumer were paused.
    expect(consumers[0]!.pause).toHaveBeenCalledOnce();
    expect(consumers[1]!.pause).toHaveBeenCalledOnce();
  });

  it('RED-BENCH2-6: announce re-run is a NO-OP once the real id is already consumed (no double-pipe)', async () => {
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL',
      kind: 'audio',
    });
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000); // already real
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    expect(reran).toBe(false);
    expect(transports).toHaveLength(1); // no second pipe
  });

  it('RED-BENCH2-7: onAnnounce for a room with no prior ensure() does nothing (no topology tracked)', async () => {
    const { router } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);
    registry.record({
      type: 'pipe-producer',
      roomId: 'never-ensured',
      producerId: 'p',
      kind: 'audio',
    });

    const reran = await coord.onAnnounce('never-ensured', topology, router as any, 40000);
    expect(reran).toBe(false);
  });
});

// ── C. createWsInterRelaySender — the announce actually transmits ────────

describe('createWsInterRelaySender — primary announce reaches the wire', () => {
  it('RED-BENCH2-8: with a live socket attached, send() puts the announce bytes on the wire', () => {
    const sent: string[] = [];
    const sock = {
      readyState: 1, // OPEN
      send: vi.fn((data: string) => sent.push(data)),
    };
    const sender = createWsInterRelaySender(() => sock as any);

    const announce = createInterRelayAnnouncer(sender);
    announce('room-A', { id: 'producer-PRIMARY-REAL', kind: 'audio' });

    expect(sock.send).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame['type']).toBe('pipe-producer');
    expect(frame['roomId']).toBe('room-A');
    expect(frame['producerId']).toBe('producer-PRIMARY-REAL');
  });

  it('RED-BENCH2-9: with NO socket attached yet, send() does not throw (best-effort queue/drop)', () => {
    const sender = createWsInterRelaySender(() => null);
    expect(() => sender.send('{"type":"pipe-producer"}')).not.toThrow();
  });

  it('RED-BENCH2-10: a socket that is not OPEN is treated as down (no send, no throw)', () => {
    const sock = { readyState: 3 /* CLOSED */, send: vi.fn() };
    const sender = createWsInterRelaySender(() => sock as any);
    expect(() => sender.send('frame')).not.toThrow();
    expect(sock.send).not.toHaveBeenCalled();
  });

  it('RED-BENCH2-11: a throwing socket is swallowed by the announcer (produce path never crashes)', () => {
    const sock = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('socket exploded');
      }),
    };
    const sender = createWsInterRelaySender(() => sock as any);
    const announce = createInterRelayAnnouncer(sender);
    expect(() =>
      announce('room-A', { id: 'p', kind: 'audio' }),
    ).not.toThrow();
  });
});

// ── D. StandbyWarmPipeCoordinator — ACTIVE forward (REQ-RMS-025) ──────────
//
// The integration test (rms-active-forward.integration.test.ts) proves the
// produceLocalFromPipe PRIMITIVE on REAL mediasoup. These cover the COORDINATOR
// wiring with mock mediasoup: forwardLocalProducers dedup, the onLocalProducer
// callback arg tuple, the retryable-vs-duplicate produce-error split (Fix 1),
// clear()'s dedup-set drop, the legacy no-rtpParameters skip, and the throwing-
// callback guard (Fix 4).
//
// HARNESS NOTE: we drive the PUBLIC methods (ensure / onAnnounce / clear). The mock
// router's createPipeTransport returns mock PipeTransports whose `produce` we control,
// so the REAL ensureWarmPipe runs against the mock (it consumes a mock pipe consumer +
// sets topology.pipeTransport), and forwardLocalProducers then produces over that same
// mock transport — no real Worker/PipeTransport is bound.

describe('StandbyWarmPipeCoordinator — REQ-RMS-025 ACTIVE forward (produceLocalFromPipe wiring)', () => {
  const PEER = 'relay-B';

  it('REQ-RMS-025 (a): ensure mints a LOCAL producer per announced rtpParameters + fires onLocalProducer with (roomId, producer, producerPeerId, peerRelayId)', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-af', producerId: 'pA', kind: 'video',
      producerPeerId: 'pub-A', peerRelayId: PEER, rtpParameters: rtpParams(11),
    });
    registry.record({
      type: 'pipe-producer', roomId: 'room-af', producerId: 'pB', kind: 'audio',
      producerPeerId: 'pub-B', peerRelayId: PEER, rtpParameters: rtpParams(22),
    });
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    const topology = makeStandbyTopology('room-af');

    await coord.ensure(topology, router as any, 40000, PEER);

    // One produce per announced id, on the standby's bound pipe transport.
    expect(transports).toHaveLength(1);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(2);
    const producedIds = transports[0]!.produce.mock.calls
      .map((c) => (c[0] as { id: string }).id)
      .sort();
    expect(producedIds).toEqual(['pA', 'pB']);

    // onLocalProducer fired once per minted producer with the EXACT arg tuple.
    expect(onLocalProducer).toHaveBeenCalledTimes(2);
    expect(onLocalProducer).toHaveBeenNthCalledWith(
      1, 'room-af', expect.objectContaining({ id: 'pA', kind: 'video' }), 'pub-A', PEER,
    );
    expect(onLocalProducer).toHaveBeenNthCalledWith(
      2, 'room-af', expect.objectContaining({ id: 'pB', kind: 'audio' }), 'pub-B', PEER,
    );
  });

  it('REQ-RMS-025 (b): dedup — the same id is NOT double-produced across ensure(not-ready)→onAnnounce→ensure(repeat)', async () => {
    const registry = new InterRelayProducerRegistry();
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    const topology = makeStandbyTopology('room-dd');

    // Not-ready first join: nothing announced yet → placeholder, NO produce.
    await coord.ensure(topology, router as any, 40000, PEER);
    const totalProduceAfterEnsure = transports.reduce((n, t) => n + t.produce.mock.calls.length, 0);
    expect(totalProduceAfterEnsure).toBe(0);

    // Announce arrives WITH rtpParameters → onAnnounce re-run mints the producer.
    registry.record({
      type: 'pipe-producer', roomId: 'room-dd', producerId: 'pX', kind: 'video',
      producerPeerId: 'pub-X', peerRelayId: PEER, rtpParameters: rtpParams(7),
    });
    const reran = await coord.onAnnounce('room-dd', topology, router as any, 40000, PEER);
    expect(reran).toBe(true);

    // Repeat drive: a 2nd ensure for the same (room,peer) must NOT re-produce pX.
    await coord.ensure(topology, router as any, 40000, PEER);

    const totalProduce = transports.reduce((n, t) => n + t.produce.mock.calls.length, 0);
    expect(totalProduce).toBe(1);              // pX minted exactly once
    expect(onLocalProducer).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).toHaveBeenCalledWith(
      'room-dd', expect.objectContaining({ id: 'pX' }), 'pub-X', PEER,
    );
  });

  it('REQ-RMS-025 (c): a DUPLICATE-id produce throw is caught (no reject), marked + debug-logged, and NOT retried on the next drive', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-dup', producerId: 'pDup', kind: 'video',
      producerPeerId: 'pub-D', peerRelayId: PEER, rtpParameters: rtpParams(9),
    });
    const dup: ProduceImpl = async () => {
      throw new Error('a Producer with same id "pDup" already exists [method=transport.produce]');
    };
    const { router, transports } = makeMockRouter(dup);
    const logger = makeMockLogger();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, logger as any, onLocalProducer, true);
    const topology = makeStandbyTopology('room-dup');

    // Must NOT reject (the rejection here would fail the test).
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();   // benign idempotency → debug
    expect(logger.warn).not.toHaveBeenCalled();

    // Marked → a 2nd drive does NOT retry the known-minted id.
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(1); // still 1, no retry
  });

  it('REQ-RMS-025 (d): a NON-duplicate produce throw is caught (no reject), warn-logged, and IS retried on the next drive (self-heal)', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-err', producerId: 'pErr', kind: 'video',
      producerPeerId: 'pub-E', peerRelayId: PEER, rtpParameters: rtpParams(13),
    });
    let attempts = 0;
    const flaky: ProduceImpl = async (opts) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient worker hiccup — connect not settled');
      return makeMockProducer(opts.id, opts.kind);
    };
    const { router, transports } = makeMockRouter(flaky);
    const logger = makeMockLogger();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, logger as any, onLocalProducer, true);
    const topology = makeStandbyTopology('room-err');

    // Attempt 1 throws (non-dup) → caught, left UNMARKED, warn-logged.
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();    // real fault → warn (not debug)

    // 2nd drive: id was left unmarked → retried → succeeds this time (self-heal).
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(2); // retried
    expect(onLocalProducer).toHaveBeenCalledTimes(1);        // succeeded on retry
    expect(onLocalProducer).toHaveBeenCalledWith(
      'room-err', expect.objectContaining({ id: 'pErr' }), 'pub-E', PEER,
    );
  });

  it('REQ-RMS-025 (e): clear(roomId, peerRelayId) drops the dedup set so a later drive RE-MINTS', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-clr', producerId: 'pC', kind: 'video',
      producerPeerId: 'pub-C', peerRelayId: PEER, rtpParameters: rtpParams(5),
    });
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    const topology = makeStandbyTopology('room-clr');

    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).toHaveBeenCalledTimes(1);

    // Drop the (room,peer) state + dedup set.
    coord.clear('room-clr', PEER);

    // A later drive re-mints (fresh dedup set → pC no longer remembered).
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).toHaveBeenCalledTimes(2);
    expect(onLocalProducer).toHaveBeenCalledTimes(2);
  });

  it('REQ-RMS-025 (f): a legacy announce WITHOUT rtpParameters drives NO produce (the real skip path through the coordinator)', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-lg', producerId: 'pLegacy', kind: 'video',
      peerRelayId: PEER, // NO rtpParameters (pre-REQ-RMS-026 primary)
    });
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    const topology = makeStandbyTopology('room-lg');

    // Drives ensure end-to-end: the warm pipe still opens (keepalive consumer), but
    // the active-forward loop SKIPS the legacy entry — no produce, no throw.
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports[0]!.produce).not.toHaveBeenCalled();
    expect(onLocalProducer).not.toHaveBeenCalled();
    expect(transports[0]!.consume).toHaveBeenCalled(); // keepalive consumer intact
  });

  it('REQ-RMS-025 (Fix 4): a THROWING onLocalProducer callback does not abort the loop — the remaining producers are still minted', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-cb', producerId: 'p1', kind: 'video',
      producerPeerId: 'pub-1', peerRelayId: PEER, rtpParameters: rtpParams(31),
    });
    registry.record({
      type: 'pipe-producer', roomId: 'room-cb', producerId: 'p2', kind: 'audio',
      producerPeerId: 'pub-2', peerRelayId: PEER, rtpParameters: rtpParams(32),
    });
    const { router, transports } = makeMockRouter();
    const logger = makeMockLogger();
    const onLocalProducer = vi.fn((_roomId: string, producer: { id: string }) => {
      if (producer.id === 'p1') throw new Error('L1.3 callback blew up on p1');
    });
    const coord = new StandbyWarmPipeCoordinator(registry, logger as any, onLocalProducer, true);
    const topology = makeStandbyTopology('room-cb');

    // Must NOT reject even though the p1 callback throws.
    await coord.ensure(topology, router as any, 40000, PEER);

    // BOTH producers minted (the throw on p1 did not skip p2).
    expect(transports[0]!.produce).toHaveBeenCalledTimes(2);
    expect(onLocalProducer).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled(); // the bad callback was warn-logged
  });
});

// ── L1.4: RMS_ACTIVE_FORWARD gate — default-off preserves REQ-RO-005 ───────
//
// Decision recorded at the L1 SHIP gate: active-forward fires for ANY warm-pipe
// standby, including relay-overlap M1 2-relay failover rooms where the flag is
// OFF.  Gating it off must leave the paused keepalive consumer (REQ-RO-005)
// UNTOUCHED — that is, ensureWarmPipe still runs; only forwardLocalProducers is
// guarded.

describe('StandbyWarmPipeCoordinator — activeForward gate (L1.4, RMS_ACTIVE_FORWARD)', () => {
  const PEER = 'relay-gate-test';

  it('gate OFF (default false): standby with rtpParameters + bound transport — onLocalProducer NOT fired, NO produce minted; keepalive consumer (REQ-RO-005) is preserved', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-gate', producerId: 'pGate', kind: 'video',
      producerPeerId: 'pub-gate', peerRelayId: PEER, rtpParameters: rtpParams(99),
    });
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    // 4th arg omitted → default false (fail-safe, M1 / relay-overlap paused-keepalive path)
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer);
    const topology = makeStandbyTopology('room-gate');

    await coord.ensure(topology, router as any, 40000, PEER);

    // Gate OFF → active-forward is skipped: no produce, no callback.
    expect(transports[0]!.produce).not.toHaveBeenCalled();
    expect(onLocalProducer).not.toHaveBeenCalled();
    // ensureWarmPipe still ran → the paused keepalive consumer (REQ-RO-005) exists.
    expect(transports[0]!.consume).toHaveBeenCalled();
  });

  it('gate ON (true): same setup — produce IS minted and onLocalProducer IS fired', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer', roomId: 'room-gate-on', producerId: 'pGateOn', kind: 'audio',
      producerPeerId: 'pub-gate-on', peerRelayId: PEER, rtpParameters: rtpParams(100),
    });
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    const topology = makeStandbyTopology('room-gate-on');

    await coord.ensure(topology, router as any, 40000, PEER);

    expect(transports[0]!.produce).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).toHaveBeenCalledWith(
      'room-gate-on', expect.objectContaining({ id: 'pGateOn', kind: 'audio' }), 'pub-gate-on', PEER,
    );
  });
});
