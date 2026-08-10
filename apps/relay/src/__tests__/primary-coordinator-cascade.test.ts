/**
 * PrimaryPipeCoordinator — REQ-RMS-034/037 reverseMint (part-3 reverse leg). A
 * standby-homed client's media flows UP the warm pipe to the PRIMARY, which
 * mints a LOCAL hub copy from the announced reverse-pipe consumer. The dual of
 * the forward onProducer/drain: mint LOCALLY (no announce), with an
 * announce-before-leg-connected QUEUE (REQ-RMS-037 ordering) + per-leg dedup
 * (REQ-RMS-034 mint exactly once). bindLegTransportForTest is the thin seam
 * that stands in for ensureReverseLeg's real-mediasoup mint+connect (which is
 * integration-covered in A5, NOT unit-covered here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import { PrimaryPipeCoordinator } from '@dvconf/inter-relay-client';
import { makeMockRouter, makeStubAllocator } from './inter-relay-primary-coordinator.testUtils.js';

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

  it('REQ-RMS-037 (D3 precondition): a DUPLICATE reverse announce for the same producerId mints exactly once (reverseMintedIds dedup)', async () => {
    // D3 re-delivery precondition (static-mesh-hardening, spec §2-D3.4): StandbyWarmPipeCoordinator
    // .resendReverseAnnounces (Task 2) RE-SENDS stored announce frames on link reopen, so the primary
    // MUST treat a duplicate announce for the same producerId as a no-op. Mechanism = mintOne's per-leg
    // reverseMintedIds Set (inter-relay.ts:2238-2244: `if (seen.has(announced.producerId)) return null`).
    // Sibling of RED-RA-3b-dedup, pinned explicitly to REQ-RMS-037 and driven with an AUDIO kind to prove
    // the dedup is kind-agnostic. GREEN today -> that pass IS the precondition proof (no receiver fix needed).
    const coord = new PrimaryPipeCoordinator({ announcer: vi.fn(), portAllocator: zeroAllocator, paramSender: vi.fn() });
    const fakeTransport = { produce: vi.fn().mockResolvedValue({ id: 'prod-dup-1', kind: 'audio', on: vi.fn() }) } as unknown as msTypes.PipeTransport;
    coord.bindLegTransportForTest('roomA', 'ws://standbyA', fakeTransport);
    const announce = { producerId: 'prod-dup-1', kind: 'audio' as const, rtpParameters: REMAPPED_RTP, producerPeerId: 'peer-A' };
    await coord.reverseMint('roomA', fakeRouter, announce, 'ws://standbyA'); // first announce
    await coord.reverseMint('roomA', fakeRouter, announce, 'ws://standbyA'); // EXACT duplicate -- the resend case
    expect(fakeTransport.produce).toHaveBeenCalledTimes(1); // minted exactly once
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
