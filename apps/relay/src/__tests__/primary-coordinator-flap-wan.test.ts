/**
 * PrimaryPipeCoordinator — B6b (REQ-RMS-035) FORWARD flap idempotency, RC-A
 * forward drain on reverse-leg bring-up, and PRODUCER-FIRST WAN ordering
 * (the LIVE deadlock).
 *
 * B6b: onProducer re-queues a producer UNCONDITIONALLY (inter-relay.ts:1711).
 * On a standby link flap / re-attach the SAME producer.id is re-queued ->
 * drain() re-pipes it -> pipeProducerOntoPrimaryTransport calls
 * transport.consume() a 2nd time for an already-piped producer -> real
 * mediasoup throws "Consumer already exists". A per-leg forwardPipedIds dedup
 * (mirror of reverseMintedIds) pipes each id EXACTLY ONCE, cleared with the
 * leg in clear().
 *
 * RC-A: the FORWARD queue must be flushed when the leg is brought up by the
 * REVERSE path. Each (room,peer) leg uses ONE bidirectional pipeTransport for
 * BOTH forward (primary→standby) and reverse (standby→primary). The forward
 * queue (s.pendingProducers) is drained by drain(), called from onProducer
 * (only if standbyParams present at produce time) and onStandbyConnectParams
 * (only if already connected). When the leg is instead minted+connected by
 * ensureReverseLeg (a reverse announce brings it up), it historically called
 * ONLY drainReverseMints -> the queued FORWARD producers were orphaned (no
 * later forward onProducer to flush them). This is the LIVE bug: the last
 * standby to bring up its leg via the reverse path never received the
 * primary's producers. ensureReverseLeg MUST also drain() the forward queue.
 * drain() self-guards (!connected || pipeTransport===null) and is idempotent
 * (forwardPipedIds Set), so this is safe regardless of mint order.
 *
 * PRODUCER-FIRST WAN ordering: on a real WAN the PRODUCER is all-local on the
 * primary so it arrives FIRST, and the standby's cross-WAN pipe-connect params
 * land a few ms LATER. onProducer(standbyParams===null) QUEUES the producer
 * and returns early (the mint block lives only in the params-present branch),
 * and onStandbyConnectParams historically had NO router so it could not mint
 * — it only drained if ALREADY connected. So neither handler ever minted the
 * pipe: the producer stayed queued forever, pipe_bytes stayed 0, and the
 * consumer got "no producer appeared within 30000ms". This is DETERMINISTIC
 * on WAN (which is why the localhost/same-relay params-first tests never
 * caught it). The fix threads the room router into onStandbyConnectParams so
 * it can mint+connect+reply-DOWN+drain the queued producer (the symmetric
 * dual of ensureReverseLeg's forward drain).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrimaryPipeCoordinator, type PipeConnectParams } from '@dvconf/inter-relay-client';
import {
  makeMockRouter,
  makeStubAllocator,
  makeProducer,
  STANDBY_PARAMS,
} from './inter-relay-primary-coordinator.testUtils.js';

// ── F. B6b (REQ-RMS-035) — FORWARD flap idempotency. ─────────────────────

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

// ── G. RC-A (REQ-RMS-035) — forward queue flushed on reverse-leg bring-up. ─

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

// ── H. PRODUCER-FIRST WAN ordering (the LIVE deadlock). ───────────────────

describe('PrimaryPipeCoordinator — PRODUCER-FIRST WAN ordering mints on standby params (LIVE deadlock)', () => {
  let announcer: ReturnType<typeof vi.fn>;
  let paramSender: ReturnType<typeof vi.fn>;
  let allocator: ReturnType<typeof makeStubAllocator>;

  beforeEach(() => {
    announcer = vi.fn();
    paramSender = vi.fn();
    allocator = makeStubAllocator(41000);
  });

  it('RED-PPC-WAN-PRODUCER-FIRST: producer arrives first (queued, standbyParams null); when the standby params arrive WITH the room router, the pipe is minted+connected, replies DOWN, and the queued producer is drained+announced', async () => {
    const { router, transports, piped } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    // 1. WAN order: the ALL-LOCAL producer lands FIRST, before the cross-WAN params.
    //    standbyParams is null → the producer is QUEUED, nothing minted/piped yet.
    await coord.onProducer('room-WAN', router as any, makeProducer('producer-WAN'));
    expect(router.createPipeTransport).not.toHaveBeenCalled();
    expect(transports).toHaveLength(0);
    expect(announcer).not.toHaveBeenCalled();

    // 2. A few ms later the standby's cross-WAN pipe-connect params arrive — carrying
    //    the room ROUTER (the production wiring reads it via signalingRef.getRoom(roomId)
    //    .router). With a producer already queued and the pipe not built, this MUST now
    //    mint+connect the primary pipe and drain the queued producer.
    await coord.onStandbyConnectParams('room-WAN', STANDBY_PARAMS, undefined, router as any);

    // The pipe was minted ONCE, connected to the standby's params.
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.connect).toHaveBeenCalledOnce();
    const connectArg = transports[0]!.connect.mock.calls[0]![0] as PipeConnectParams;
    expect(connectArg.ip).toBe('127.0.0.1');
    expect(connectArg.port).toBe(40000); // the standby's port

    // The queued SOURCE producer was piped onto the pipe.
    expect(transports[0]!.consume).toHaveBeenCalledWith({ producerId: 'producer-WAN' });

    // Replied DOWN with the primary's OWN bound port (the §2 handshake reply).
    expect(paramSender).toHaveBeenCalledOnce();
    const [downRoom, downParams] = paramSender.mock.calls[0]!;
    expect(downRoom).toBe('room-WAN');
    expect((downParams as PipeConnectParams).port).toBe(transports[0]!.tuple.localPort);

    // The queued producer was served: the PIPED consumer id is announced (NOT source id).
    expect(announcer).toHaveBeenCalledOnce();
    expect(announcer.mock.calls[0]![1].id).toBe(piped[0]!.id);
    expect(announcer.mock.calls[0]![1].id).not.toBe('producer-WAN');
  });

  it('RED-PPC-WAN-mint-once: after the WAN mint, a LATER forward onProducer reuses the SAME transport (createPipeTransport still called once) and announces its PIPED id', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new PrimaryPipeCoordinator({ announcer, portAllocator: allocator, paramSender });

    await coord.onProducer('room-WAN', router as any, makeProducer('producer-WAN-1'));
    await coord.onStandbyConnectParams('room-WAN', STANDBY_PARAMS, undefined, router as any);
    expect(router.createPipeTransport).toHaveBeenCalledOnce();
    expect(announcer).toHaveBeenCalledOnce();

    // A second producer after the WAN pipe is up drains onto the SAME transport.
    await coord.onProducer('room-WAN', router as any, makeProducer('producer-WAN-2'));
    expect(router.createPipeTransport).toHaveBeenCalledOnce(); // still mint-once
    expect(transports).toHaveLength(1);
    expect(transports[0]!.consume).toHaveBeenCalledTimes(2);
    expect(announcer).toHaveBeenCalledTimes(2);
  });
});
