/**
 * D. StandbyWarmPipeCoordinator — ACTIVE forward (REQ-RMS-025)
 *
 * The integration test (rms-active-forward.integration.test.ts) proves the
 * produceLocalFromPipe PRIMITIVE on REAL mediasoup. These cover the COORDINATOR
 * wiring with mock mediasoup: forwardLocalProducers dedup, the onLocalProducer
 * callback arg tuple, the retryable-vs-duplicate produce-error split (Fix 1),
 * clear()'s dedup-set drop, the legacy no-rtpParameters skip, and the throwing-
 * callback guard (Fix 4).
 *
 * HARNESS NOTE: we drive the PUBLIC methods (ensure / onAnnounce / clear). The mock
 * router's createPipeTransport returns mock PipeTransports whose `produce` we control,
 * so the REAL ensureWarmPipe runs against the mock (it consumes a mock pipe consumer +
 * sets topology.pipeTransport), and forwardLocalProducers then produces over that same
 * mock transport — no real Worker/PipeTransport is bound.
 *
 * L1.4: RMS_ACTIVE_FORWARD gate — default-off preserves REQ-RO-005.
 *
 * Decision recorded at the L1 SHIP gate: active-forward fires for ANY warm-pipe
 * standby, including relay-overlap M1 2-relay failover rooms where the flag is
 * OFF. Gating it off must leave the paused keepalive consumer (REQ-RO-005)
 * UNTOUCHED — that is, ensureWarmPipe still runs; only forwardLocalProducers is
 * guarded.
 */

import { describe, it, expect, vi } from 'vitest';
import { InterRelayProducerRegistry, StandbyWarmPipeCoordinator } from '@dvconf/inter-relay-client';
import {
  makeMockRouter,
  makeMockLogger,
  makeMockProducer,
  makeStandbyTopology,
  rtpParams,
  type ProduceImpl,
} from './inter-relay-warmpipe.testUtils.js';

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
