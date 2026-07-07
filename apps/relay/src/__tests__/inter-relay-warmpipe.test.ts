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
import type { types as msTypes } from 'mediasoup';

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

// ── B. NOT-READY path: DEFER (no consume) then re-run on announce (C1/C3) ─

describe('StandbyWarmPipeCoordinator — NOT-READY path + announce re-run', () => {
  let registry: InterRelayProducerRegistry;
  let topology: RoomTopology;

  beforeEach(() => {
    registry = new InterRelayProducerRegistry();
    topology = makeStandbyTopology();
  });

  it('RED-BENCH2-3: when registry has NO producer yet, ensure DEFERS — binds the pipe transport but does NOT consume a placeholder (C1)', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    const consumer = await coord.ensure(topology, router as any, 40000);

    // C1 (cross-relay DEADLOCK fix): no real producer announced yet → DEFER. The
    // transport is bound (so the UP {ip,port} announce can read its port) but
    // NOTHING is consumed — consuming a `pipe-producer-pending-<roomId>` sentinel
    // throws "Producer not found" on real mediasoup. onAnnounce re-runs with the
    // real id once it arrives.
    expect(consumer).toBeNull();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.consume).not.toHaveBeenCalled();
    expect(topology.pipeConsumer).toBeNull();
    expect(topology.pipeTransport).toBe(transports[0]);
  });

  it('RED-BENCH2-4: a later announce triggers a RE-RUN that consumes the REAL id on the SAME (reused) bound transport (C3)', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    // First join: not ready → DEFER (C1). Transport bound, nothing consumed yet.
    const firstConsumer = await coord.ensure(topology, router as any, 40000);
    expect(firstConsumer).toBeNull();
    expect(transports[0]!.consume).not.toHaveBeenCalled();
    expect(topology.pipeConsumer).toBeNull();

    // Announce arrives (primary piped its real producer).
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // C3 (cross-relay DEADLOCK fix): the EXISTING bound transport is REUSED (NOT
    // closed+rebuilt — that would tear down the connected pipe) and consumes the
    // REAL id — so still ONE transport, now carrying the real warm-pipe consumer.
    expect(reran).toBe(true);
    expect(transports).toHaveLength(1);
    const reconsumeArg = transports[0]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(reconsumeArg.producerId).toBe('producer-REAL-late');
    expect(topology.pipeConsumer).not.toBeNull();
    expect(topology.pipeTransport).toBe(transports[0]);
  });

  it('RED-BENCH2-5: the re-run consumer is paused (REQ-RO-005 preserved across cutover)', async () => {
    const { router, consumers } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000); // defer — no consume/pause yet
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // The single warm-pipe consumer minted on the cutover is paused (RTCP keepalive).
    expect(consumers[0]!.pause).toHaveBeenCalledOnce();
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

  // RC-B (REQ-RMS-035) — a forward producer announced AFTER the FIRST announce
  // cutover must still be minted. onAnnounce flips state.pending=false on the first
  // announce (placeholder→real consumer swap). Historically every SUBSEQUENT forward
  // announce then hit the `!state.pending` short-circuit and returned BEFORE
  // forwardLocalProducers -> a producer announced post-cutover was record()'d in the
  // registry yet NEVER minted on the standby router -> the local client saw "0
  // inbound video". The fix re-drives the idempotent forward mint on the live
  // state.topology when already cut over (producedIds dedups already-minted ids).
  it('RED-WP-POSTCUTOVER-MINT (REQ-RMS-035): a producer announced AFTER the first cutover is still minted on the standby router (not dropped by the !pending short-circuit)', async () => {
    const registry = new InterRelayProducerRegistry();
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    const topology = makeStandbyTopology('room-pc');

    // 1. ensure() with NOTHING announced yet -> pending=true (placeholder, no produce).
    await coord.ensure(topology, router as any, 40000, PEER);
    expect(transports.reduce((n, t) => n + t.produce.mock.calls.length, 0)).toBe(0);

    // 2. FIRST announce: producer #1 announced -> onAnnounce does the placeholder
    //    cutover AND mints #1 (pending flips to false).
    registry.record({
      type: 'pipe-producer', roomId: 'room-pc', producerId: 'p1', kind: 'audio',
      producerPeerId: 'pub-1', peerRelayId: PEER, rtpParameters: rtpParams(11),
    });
    const reran = await coord.onAnnounce('room-pc', topology, router as any, 40000, PEER);
    expect(reran).toBe(true); // cutover happened
    expect(transports.reduce((n, t) => n + t.produce.mock.calls.length, 0)).toBe(1); // #1 minted
    expect(onLocalProducer).toHaveBeenCalledTimes(1);

    // 3. A SECOND producer is announced AFTER the cutover (a peer's 2nd track produced
    //    once this leg already cut over). record() it, then re-announce.
    registry.record({
      type: 'pipe-producer', roomId: 'room-pc', producerId: 'p2', kind: 'video',
      producerPeerId: 'pub-1', peerRelayId: PEER, rtpParameters: rtpParams(22),
    });
    await coord.onAnnounce('room-pc', topology, router as any, 40000, PEER);

    // RC-B: the post-cutover announce MUST mint #2. TODAY the `!state.pending`
    // short-circuit returns before forwardLocalProducers -> #2 dropped -> RED.
    // After the fix forwardLocalProducers re-drives (idempotent) -> #2 minted -> GREEN.
    expect(transports.reduce((n, t) => n + t.produce.mock.calls.length, 0)).toBe(2);
    const mintedIds = transports
      .flatMap((t) => t.produce.mock.calls.map((c) => (c[0] as { id: string }).id))
      .sort();
    expect(mintedIds).toEqual(['p1', 'p2']);
    expect(onLocalProducer).toHaveBeenCalledTimes(2);
    expect(onLocalProducer).toHaveBeenLastCalledWith(
      'room-pc', expect.objectContaining({ id: 'p2', kind: 'video' }), 'pub-1', PEER,
    );
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

// ── E. StandbyWarmPipeCoordinator — REVERSE leg (REQ-RMS-034 / 026, part-3) ──
//
// part-3 reverse leg (Task A2): a STANDBY-homed local client's producer is
// consumed onto the warm pipe UP toward the primary and announced UP carrying
// the pipe-CONSUMER's REMAPPED rtpParameters (REQ-RMS-026, symmetric to the
// forward leg). Ordering (REQ-RMS-037): a producer arriving BEFORE the pipe is
// connected is QUEUED and drained on connect. Idempotent per (room,peer): the
// same producerId is consumed at most once onto a given transport; the dedup is
// cleared when the leg's transport is replaced so a fresh pipe re-consumes.

describe('StandbyWarmPipeCoordinator — REQ-RMS-034 REVERSE leg (onLocalClientProducer)', () => {
  /** A distinct rtpParameters object — proves the announce carries the pipe
   *  CONSUMER's REMAPPED params (REQ-RMS-026), not the source producer's. */
  const REMAPPED_RTP = rtpParams(987654) as msTypes.RtpParameters;
  /** onLocalClientProducer ignores the router arg (the standby consumes onto its
   *  retained pipeTransport, not a fresh router transport) — a mock is enough. */
  const fakeRouter = makeMockRouter().router as unknown as msTypes.Router;

  it('RED-RA-2: onLocalClientProducer consumes the local producer onto the warm pipe and announces UP with the CONSUMER rtpParameters', async () => {
    const upAnnounce = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    const fakeConsumer = { id: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP };
    const fakeTransport = { consume: vi.fn().mockResolvedValue(fakeConsumer) } as unknown as msTypes.PipeTransport;
    coord.setReverseAnnouncer(upAnnounce);
    coord.bindPipeTransportForTest('roomA', 'ws://primary', fakeTransport); // thin test seam mirroring currentPipeTransport
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    expect(fakeTransport.consume).toHaveBeenCalledWith(expect.objectContaining({ producerId: 'local-1' }));
    expect(upAnnounce).toHaveBeenCalledWith('roomA', { id: 'piped-up-1', kind: 'video' }, 'clientA', 'ws://primary', REMAPPED_RTP);
  });

  it('RED-RA-2b: a local producer arriving BEFORE the pipe is connected is QUEUED, then drained on connect (never consumes onto an unconnected transport)', async () => {
    const upAnnounce = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    coord.setReverseAnnouncer(upAnnounce);
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    expect(upAnnounce).not.toHaveBeenCalled();
    coord.bindPipeTransportForTest('roomA', 'ws://primary', { consume: vi.fn().mockResolvedValue({ id: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP }) } as unknown as msTypes.PipeTransport);
    await coord.drainReverse('roomA', 'ws://primary'); // the method onPrimaryConnectParams calls after transport.connect succeeds
    expect(upAnnounce).toHaveBeenCalledTimes(1);
  });

  it('RED-RA-2c: the same local producer is not consumed twice (idempotency); dedup is cleared when the pipe transport is replaced', async () => {
    const upAnnounce = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    coord.setReverseAnnouncer(upAnnounce);
    const t1 = { consume: vi.fn().mockResolvedValue({ id: 'p1', kind: 'video', rtpParameters: REMAPPED_RTP }) } as unknown as msTypes.PipeTransport;
    coord.bindPipeTransportForTest('roomA', 'ws://primary', t1);
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    expect(t1.consume).toHaveBeenCalledTimes(1); // deduped on same transport
    coord.onPipeTransportReplacedForTest('roomA', 'ws://primary'); // clears reverseConsumedIds for the leg
    const t2 = { consume: vi.fn().mockResolvedValue({ id: 'p2', kind: 'video', rtpParameters: REMAPPED_RTP }) } as unknown as msTypes.PipeTransport;
    coord.bindPipeTransportForTest('roomA', 'ws://primary', t2);
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    expect(t2.consume).toHaveBeenCalledTimes(1); // re-consumes after replacement
  });

  it('RED-RA-2d: a TRANSIENT consume failure leaves the id UN-marked + warn-logged (no reject), so a later drive RE-CONSUMES and announces (self-heal, mirror forward Fix 1)', async () => {
    const upAnnounce = vi.fn();
    const logger = makeMockLogger();
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), logger as any, vi.fn(), true);
    coord.setReverseAnnouncer(upAnnounce);
    let calls = 0;
    const consume = vi.fn().mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient worker hiccup — pipe connect not settled');
      return { id: 'piped-up-1', kind: 'video', rtpParameters: REMAPPED_RTP };
    });
    coord.bindPipeTransportForTest('roomA', 'ws://primary', { consume } as unknown as msTypes.PipeTransport);

    // Attempt 1: consume REJECTS (transient) → must NOT reject out of onLocalClientProducer,
    // must NOT announce, must warn-log, and must leave the id UN-marked.
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    expect(consume).toHaveBeenCalledTimes(1);
    expect(upAnnounce).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled(); // real fault → warn (not debug)

    // Attempt 2 (same id): id was left un-marked → RETRY → consume resolves → announce fires.
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'ws://primary');
    expect(consume).toHaveBeenCalledTimes(2); // retried (self-heal)
    expect(upAnnounce).toHaveBeenCalledTimes(1);
    expect(upAnnounce).toHaveBeenCalledWith('roomA', { id: 'piped-up-1', kind: 'video' }, 'clientA', 'ws://primary', REMAPPED_RTP);
  });

  it('RED-RA-2d-drain: a transient failure on ONE queued producer does NOT discard the rest of the drained queue (the second is still announced)', async () => {
    const upAnnounce = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    coord.setReverseAnnouncer(upAnnounce);

    // Two producers QUEUE before the pipe is connected (no transport bound yet).
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'q1', kind: 'video' }, 'pubQ1', 'ws://primary');
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'q2', kind: 'video' }, 'pubQ2', 'ws://primary');
    expect(upAnnounce).not.toHaveBeenCalled();

    // On connect, the FIRST queued consume (q1) rejects (transient); the SECOND (q2) resolves.
    const consume = vi.fn().mockImplementation(async (arg: { producerId: string }) => {
      if (arg.producerId === 'q1') throw new Error('transient on q1');
      return { id: `piped-${arg.producerId}`, kind: 'video', rtpParameters: REMAPPED_RTP };
    });
    coord.bindPipeTransportForTest('roomA', 'ws://primary', { consume } as unknown as msTypes.PipeTransport);
    await coord.drainReverse('roomA', 'ws://primary'); // must NOT reject; must not lose q2

    // q1 failed transiently, but q2 was STILL drained + announced (no queue loss).
    expect(consume).toHaveBeenCalledTimes(2);
    expect(upAnnounce).toHaveBeenCalledTimes(1);
    expect(upAnnounce).toHaveBeenCalledWith('roomA', { id: 'piped-q2', kind: 'video' }, 'pubQ2', 'ws://primary', REMAPPED_RTP);
  });
});

// ── E2. REQ-RMS-037 D3 (static-mesh-hardening) — reverse-announce frame-arg store + resend ──
//
// The standby link send is fire-and-forget: frames are silently dropped while the WS is not
// OPEN (inter-relay-link.ts:172-183). To recover announces lost during a down window, the
// coordinator records the ARGS of every SENT reverse announce (the PIPED consumer id +
// remapped rtpParameters — EXACTLY what reverseConsumeAndAnnounce puts on the wire, not the
// source producer's), keyed per (leg + origin/producer id). On link RE-open the wiring layer
// (Task 4) calls resendReverseAnnounces(roomId): each stored frame is re-announced VERBATIM and
// the primary's reverseMintedIds dedup (Task 1 precondition) makes the re-delivery idempotent.
// The store NEVER re-consumes the pipe (reverseConsumedIds untouched) and is dropped with the
// leg in clear()/clearRoom (same lifecycle as reverseConsumedIds).

describe('StandbyWarmPipeCoordinator — REQ-RMS-037 D3 reverse-announce frame-arg store + resend', () => {
  const REMAPPED_RTP = rtpParams(555111) as msTypes.RtpParameters;
  const fakeRouter = makeMockRouter().router as unknown as msTypes.Router;
  const PRIMARY = 'ws://primary';

  /** Bind a connected leg then drive one local-client producer through
   *  reverseConsumeAndAnnounce (the path that records the store entry). */
  async function driveLocalClientProducer(
    coord: StandbyWarmPipeCoordinator,
    roomId: string,
    producerId: string,
    pipedId = `piped-${producerId}`,
  ): Promise<void> {
    coord.bindPipeTransportForTest(roomId, PRIMARY, {
      consume: vi.fn().mockResolvedValue({ id: pipedId, kind: 'video', rtpParameters: REMAPPED_RTP }),
    } as unknown as msTypes.PipeTransport);
    await coord.onLocalClientProducer(roomId, fakeRouter, { id: producerId, kind: 'video' }, 'clientA', PRIMARY);
  }

  it('records announce args at announce time and resends them verbatim', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    const announced: unknown[][] = [];
    coord.setReverseAnnouncer((...args) => { announced.push(args); });
    await driveLocalClientProducer(coord, 'roomA', 'local-1');
    expect(announced).toHaveLength(1); // the live announce
    coord.resendReverseAnnounces('roomA');
    expect(announced).toHaveLength(2); // re-delivered on reopen
    expect(announced[1]).toEqual(announced[0]); // identical args -> identical frame downstream
  });

  it('resend is a no-op for a room with nothing stored', () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    const announced: unknown[][] = [];
    coord.setReverseAnnouncer((...args) => { announced.push(args); });
    coord.resendReverseAnnounces('0xno-such-room');
    expect(announced).toHaveLength(0);
  });

  it('clearRoom drops the leg\'s stored announces so a later resend is a no-op', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    // Drive with the announcer UNSET: the live announce is a no-op but the store still records.
    await driveLocalClientProducer(coord, 'roomA', 'local-1');
    coord.clearRoom('roomA');
    const announced: unknown[][] = [];
    coord.setReverseAnnouncer((...args) => { announced.push(args); });
    coord.resendReverseAnnounces('roomA');
    expect(announced).toHaveLength(0);
  });

  it('roomsWithStoredAnnounces lists exactly the rooms holding entries', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    await driveLocalClientProducer(coord, 'roomA', 'local-1');
    expect(coord.roomsWithStoredAnnounces()).toEqual(['roomA']);
  });

  // Task-2 review fold (item 2): the e.peerRelayId per-leg filter in clear() was only proven
  // single-leg. Two distinct legs of ONE room -> clear(room, legA) drops ONLY legA's stored
  // entries; legB's still resends.
  it('clear(roomId, legA) drops only legA\'s stored announces; legB still resends (per-leg filter)', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    const LEG_A = 'ws://relayA';
    const LEG_B = 'ws://relayB';
    coord.bindPipeTransportForTest('roomA', LEG_A, {
      consume: vi.fn().mockResolvedValue({ id: 'piped-A', kind: 'video', rtpParameters: REMAPPED_RTP }),
    } as unknown as msTypes.PipeTransport);
    coord.bindPipeTransportForTest('roomA', LEG_B, {
      consume: vi.fn().mockResolvedValue({ id: 'piped-B', kind: 'video', rtpParameters: REMAPPED_RTP }),
    } as unknown as msTypes.PipeTransport);
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'srcA', kind: 'video' }, 'clientA', LEG_A);
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'srcB', kind: 'video' }, 'clientB', LEG_B);

    coord.clear('roomA', LEG_A); // drop legA only

    const announced: unknown[][] = [];
    coord.setReverseAnnouncer((...args) => { announced.push(args); });
    coord.resendReverseAnnounces('roomA');
    // Exactly one resend — legB's — carrying piped-B / LEG_B (legA's entry is gone).
    expect(announced).toHaveLength(1);
    expect(announced[0]).toEqual(['roomA', { id: 'piped-B', kind: 'video' }, 'clientB', LEG_B, REMAPPED_RTP]);
  });

  // Task-2 review fold (item 3): the tree branch of the resend arity split (7-arg, hopTtl +
  // originProducerId) was untested. Drive with the tree fields set -> the store + resend both
  // take the 7-arg path and the re-delivered frame is byte-identical to the live announce.
  it('records + resends the 7-arg tree frame (hopTtl + originProducerId) via the tree arity branch', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    coord.bindPipeTransportForTest('roomA', PRIMARY, {
      consume: vi.fn().mockResolvedValue({ id: 'piped-tree', kind: 'video', rtpParameters: REMAPPED_RTP }),
    } as unknown as msTypes.PipeTransport);
    const announced: unknown[][] = [];
    coord.setReverseAnnouncer((...args) => { announced.push(args); });
    // onLocalClientProducer(roomId, router, producer, producerPeerId, peerRelayId, hopTtl, originProducerId)
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'src-tree', kind: 'video' }, 'clientT', PRIMARY, 3, 'ORIGIN-1');
    expect(announced).toHaveLength(1);
    expect(announced[0]).toEqual(['roomA', { id: 'piped-tree', kind: 'video' }, 'clientT', PRIMARY, REMAPPED_RTP, 3, 'ORIGIN-1']);
    coord.resendReverseAnnounces('roomA');
    expect(announced).toHaveLength(2);
    expect(announced[1]).toEqual(announced[0]); // tree branch re-sends the 7-arg frame verbatim
  });

  // Task 4 end-to-end (spec §3.3): the LOAD-BEARING flap case — a producer created DURING the
  // down window is consumed onto the live pipe but its announce is silently DROPPED; on reopen
  // the wiring layer's onOpen(isReopen=true) calls resendReverseAnnounces and it is recovered.
  it('REQ-RMS-037 D3 end-to-end: a producer announced while the link is DOWN is re-delivered on reopen', async () => {
    const coord = new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry(), makeMockLogger() as any, vi.fn(), true);
    // Announcer models the link: DROPS while linkUp=false (mirrors the standby link's silent
    // drop when the WS is not OPEN, inter-relay-link.ts:172-183).
    let linkUp = true;
    const delivered: unknown[][] = [];
    coord.setReverseAnnouncer((...args) => { if (linkUp) delivered.push(args); });

    linkUp = false; // flap window opens
    await driveLocalClientProducer(coord, 'roomA', 'during-window'); // consumed onto the live pipe, announce DROPPED
    expect(delivered).toHaveLength(0);

    linkUp = true; // reopen
    coord.resendReverseAnnounces('roomA'); // what index.ts onOpen(isReopen=true) calls
    expect(delivered).toHaveLength(1); // the during-window producer is recovered
  });
});

// ── F. REQ-RMS-036: Loop/echo prevention — minted producer never re-announces UP ──
//
// The reverse UP-announcer (setReverseAnnouncer) fires ONLY from
// onLocalClientProducer (handleProduce — a real local-client produce).
// It MUST NEVER fire from the forward mint path (forwardLocalProducers /
// produceLocalFromPipe), otherwise a hub-fanned producer would re-announce UP,
// loop back to the primary, and cause an echo/loop in the mesh.
//
// This is the teeth-bearing regression guard for §9 risk #1 (highest risk).
// The invariant holds STRUCTURALLY (forwardLocalProducers does not touch
// reverseAnnouncer), but this wire-output assertion catches any future
// accidental wiring. Drive: clone REQ-RMS-025 (a) arrange exactly so the
// test proves a REAL mint happened, not a vacuous no-op.

describe('StandbyWarmPipeCoordinator — REQ-RMS-036 loop/echo prevention', () => {
  const PEER = 'relay-loop-guard';

  it('RED-RB-2: a standby that MINTS a hub-fanned producer (produceLocalFromPipe) never invokes the reverse UP-announcer (no loop)', async () => {
    // Arrange: clone REQ-RMS-025 (a) exactly — single producer with rtpParameters,
    // activeForward=true so forwardLocalProducers mints via produceLocalFromPipe.
    const registry = new InterRelayProducerRegistry();
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-rb2',
      producerId: 'pRB2',
      kind: 'video',
      producerPeerId: 'pub-RB2',
      peerRelayId: PEER,
      rtpParameters: rtpParams(77),
    });
    const { router, transports } = makeMockRouter();
    const onLocalProducer = vi.fn();
    const upAnnounce = vi.fn();
    const coord = new StandbyWarmPipeCoordinator(registry, undefined, onLocalProducer, true);
    coord.setReverseAnnouncer(upAnnounce);
    const topology = makeStandbyTopology('room-rb2');

    // Drive the forward hub-fan mint seam (same as REQ-RMS-025 a).
    await coord.ensure(topology, router as any, 40000, PEER);

    // Positive assertion: the forward mint DID happen (not a vacuous no-op).
    expect(transports[0]!.produce).toHaveBeenCalledTimes(1);
    expect(onLocalProducer).toHaveBeenCalledWith(
      'room-rb2',
      expect.objectContaining({ id: 'pRB2', kind: 'video' }),
      'pub-RB2',
      PEER,
    );

    // REQ-RMS-036: a MINTED producer NEVER re-announces UP (loop-safe).
    // The reverse UP-announcer fires strictly from onLocalClientProducer
    // (handleProduce) -- never from forwardLocalProducers / produceLocalFromPipe.
    expect(upAnnounce).not.toHaveBeenCalled();
  });
});
