/**
 * E. StandbyWarmPipeCoordinator — REVERSE leg (REQ-RMS-034 / 026, part-3)
 *
 * part-3 reverse leg (Task A2): a STANDBY-homed local client's producer is
 * consumed onto the warm pipe UP toward the primary and announced UP carrying
 * the pipe-CONSUMER's REMAPPED rtpParameters (REQ-RMS-026, symmetric to the
 * forward leg). Ordering (REQ-RMS-037): a producer arriving BEFORE the pipe is
 * connected is QUEUED and drained on connect. Idempotent per (room,peer): the
 * same producerId is consumed at most once onto a given transport; the dedup is
 * cleared when the leg's transport is replaced so a fresh pipe re-consumes.
 *
 * E2. REQ-RMS-037 D3 (static-mesh-hardening) — reverse-announce frame-arg
 * store + resend.
 *
 * The standby link send is fire-and-forget: frames are silently dropped while the WS is not
 * OPEN (inter-relay-link.ts:172-183). To recover announces lost during a down window, the
 * coordinator records the ARGS of every SENT reverse announce (the PIPED consumer id +
 * remapped rtpParameters — EXACTLY what reverseConsumeAndAnnounce puts on the wire, not the
 * source producer's), keyed per (leg + origin/producer id). On link RE-open the wiring layer
 * (Task 4) calls resendReverseAnnounces(roomId): each stored frame is re-announced VERBATIM and
 * the primary's reverseMintedIds dedup (Task 1 precondition) makes the re-delivery idempotent.
 * The store NEVER re-consumes the pipe (reverseConsumedIds untouched) and is dropped with the
 * leg in clear()/clearRoom (same lifecycle as reverseConsumedIds).
 *
 * F. REQ-RMS-036: Loop/echo prevention — minted producer never re-announces UP.
 *
 * The reverse UP-announcer (setReverseAnnouncer) fires ONLY from
 * onLocalClientProducer (handleProduce — a real local-client produce).
 * It MUST NEVER fire from the forward mint path (forwardLocalProducers /
 * produceLocalFromPipe), otherwise a hub-fanned producer would re-announce UP,
 * loop back to the primary, and cause an echo/loop in the mesh.
 *
 * This is the teeth-bearing regression guard for §9 risk #1 (highest risk).
 * The invariant holds STRUCTURALLY (forwardLocalProducers does not touch
 * reverseAnnouncer), but this wire-output assertion catches any future
 * accidental wiring. Drive: clone REQ-RMS-025 (a) arrange exactly so the
 * test proves a REAL mint happened, not a vacuous no-op.
 */

import { describe, it, expect, vi } from 'vitest';
import { InterRelayProducerRegistry, StandbyWarmPipeCoordinator } from '@dvconf/inter-relay-client';
import type { types as msTypes } from 'mediasoup';
import { makeMockRouter, makeMockLogger, makeStandbyTopology, rtpParams } from './inter-relay-warmpipe.testUtils.js';

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
