/**
 * REQ-RMS-037 (part-3 REVERSE leg) -- R-B Task B6a: the DRAINED-FAN tail on REAL
 * mediasoup.
 *
 * Sibling of rms-reverse-leg.integration.test.ts. That test drives the IMMEDIATE
 * reverse path: ensureReverseLeg binds the primary leg FIRST, then reverseMint
 * mints inline (returns the producer). This test proves the OTHER half -- the A6
 * double-race tail (commit bb72639): a reverse announce that arrives while the
 * primary's reverse leg is NOT yet established is QUEUED (reverseMint returns
 * null), and is minted LATER by drainReverseMints when ensureReverseLeg runs. The
 * drain branch -- and ONLY the drain branch -- fires the optional onReverseMinted
 * ctor callback so the queued-then-drained hub producer is STILL fanned (the
 * immediate path's handler-level registerReverseMinted never ran, because
 * reverseMint returned null when it queued).
 *
 * The unit suite proves the queue/dedup bookkeeping with a bound mock transport;
 * the existing integration test proves the IMMEDIATE mint on real mediasoup. The
 * QUEUED-then-DRAINED mint on real mediasoup -- the producer the drain tail hands
 * to onReverseMinted is a REAL, working hub producer that forwards real media --
 * was UNPROVEN. That is exactly B6a's gap.
 *
 * This is NOT a mock. It spawns TWO real mediasoup Workers (standby + primary
 * daemons), wires two REAL connected PipeTransports, and drives the REAL part-3
 * coordinators. It is COORDINATOR-level (the spy IS the fan seam); the live-WS
 * registerReverseMinted hub-fan DOWN + exclude-origin is B6b, NOT covered here.
 *
 * It asserts, on real media crossing the real reverse pipe:
 *   1. Ordering (REQ-RMS-037): reverseMint called while the primary leg is NOT
 *      bound returns null (the QUEUE path) -- the producer announced BEFORE the
 *      primary leg was ready. A green immediate-path mint would NOT exercise the
 *      drain tail.
 *   2. Drained-fan tail: ensureReverseLeg -> drainReverseMints fires the
 *      onReverseMinted spy EXACTLY ONCE with (roomId, a REAL minted Producer, the
 *      peerRelayId, the ORIGINAL publisher's producerPeerId).
 *   3. The drained mint is a REAL working producer: a primary-side sink consumes
 *      it and the media BODY is byte-identical end-to-end (byteIdentical ===
 *      mediaPackets && mediaPackets > 0).
 *   4. P10 RED hook: with P10_FORCE_TAMPER=1 one media body byte is flipped on the
 *      reverse hop so byteIdentical < mediaPackets -> the byte-identity assertion
 *      FAILS (the test's teeth). Unset -> PASS again.
 *
 * RTP source: a DirectTransport producer on the STANDBY router fed synthetic Opus
 * RTP via producer.send(buf) -- fully in-process, no ffmpeg/browser/UDP.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-reverse-fan.integration.test.ts
 *
 * Requirements touched: REQ-RMS-037 (drained-fan ordering + tail), REQ-RMS-034 /
 * REQ-RMS-026 (mint-once + SSRC remap, inherited from the reverse leg).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  StandbyWarmPipeCoordinator,
  PrimaryPipeCoordinator,
  InterRelayProducerRegistry,
  createStandbyPipeTransport,
  DEFAULT_PEER_RELAY_ID,
  type PipeConnectParams,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';

// -- Shared codec set (mirrors mediasoup-manager.ts / rms-active-forward) ------

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
  },
];

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;
/** Constant Opus payload -- its bytes ride the TAIL of every RTP packet. */
const OPUS_PAYLOAD = Buffer.from([0xfc, 0xff, 0xfe]);

/** RED hook: with P10_FORCE_TAMPER=1, flip one media body byte on the reverse hop. */
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';

/** A minimal well-formed Opus RTP packet (12-byte header + constant payload). */
function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2, no padding/ext/cc
  header[1] = OPUS_PT & 0x7f; // marker 0 + payload type
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, OPUS_PAYLOAD]);
}

const pipeProducerRtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: OPUS_PT,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: OPUS_SSRC }],
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- Module-scoped real mediasoup workers (spawned once) ----------------------
// Two workers => two child processes simulating the standby + primary daemons.

let standbyWorker: msTypes.Worker;
let primaryWorker: msTypes.Worker;
let standbyRouter: msTypes.Router;
let primaryRouter: msTypes.Router;

beforeAll(async () => {
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  standbyWorker?.close();
  primaryWorker?.close();
});

/** A standby-homed local client: synthetic real-RTP Opus producer on the STANDBY router. */
async function makeStandbyRtpSource(): Promise<{
  producer: msTypes.Producer;
  start: () => void;
  stop: () => void;
}> {
  const directTransport = await standbyRouter.createDirectTransport();
  const producer = await directTransport.produce({
    kind: 'audio',
    rtpParameters: pipeProducerRtpParameters,
  });
  let seq = 0;
  let ts = 0;
  let interval: NodeJS.Timeout | null = null;
  return {
    producer,
    start: () => {
      interval = setInterval(() => {
        producer.send(makeRtpPacket(seq++, ts));
        ts += 960; // 20 ms @ 48 kHz
      }, 10);
    },
    stop: () => {
      if (interval !== null) clearInterval(interval);
    },
  };
}

/** OS-assigned-port allocator (allocate => 0): rerun-safe, no EADDRINUSE. */
const zeroAllocator: PipePortAllocatorLike = {
  allocate: () => 0,
  release: () => {},
  size: () => 0,
};

describe('REQ-RMS-037 -- part-3 REVERSE drained-fan tail: queued-then-drained reverse mint fires onReverseMinted with a REAL hub producer (real mediasoup)', () => {
  it('reverseMint QUEUES (returns null) while the primary leg is not bound, then ensureReverseLeg drains it -> onReverseMinted fires EXACTLY ONCE with a real working hub producer, byte-identical media (P10 RED hook = teeth)', async () => {
    const roomId = 'rms-reverse-fan-room';
    const ORIGINAL_PUBLISHER = 'standby-publisher-peer';

    // The standby-homed local client (NOT started yet -- RTP flows AFTER wiring).
    const publisher = await makeStandbyRtpSource();

    // -- STANDBY HALF: the warm-pipe PipeTransport the standby reverse-consumes onto. --
    // port:0 => OS-assigned (rerun-safe). NOT yet connected to the primary.
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);

    // -- PRIMARY coordinator WITH an onReverseMinted spy (the B6a delta). The spy
    //    IS the drained-fan seam: in the daemon this is wired to registerReverseMinted
    //    so a queued-then-drained hub producer is STILL fanned (B6b proves the
    //    live-WS hub-fan DOWN; here we assert the COORDINATOR fires the callback). --
    let primaryReply: PipeConnectParams | null = null;
    const reverseMintedCalls: Array<{
      roomId: string;
      minted: msTypes.Producer;
      originRelayId: string;
      producerPeerId?: string;
    }> = [];
    const primaryCoord = new PrimaryPipeCoordinator({
      announcer: () => {}, // forward announce -- never fired on the reverse flow
      portAllocator: zeroAllocator,
      paramSender: (_roomId, params) => {
        primaryReply = params; // the S2 DOWN-reply (primary's own pipe port)
      },
      onReverseMinted: (rId, minted, originRelayId, producerPeerId) => {
        reverseMintedCalls.push({ roomId: rId, minted, originRelayId, producerPeerId });
      },
    });

    // -- S2 handshake UP leg: the standby's pipe-connect params arrive at the primary.
    //    This RECORDS the params but does NOT mint the primary's pipe transport
    //    (minting needs a router, which only ensureReverseLeg/onProducer carries) --
    //    so the primary leg is NOT yet bound: a reverseMint NOW must QUEUE. --
    await primaryCoord.onStandbyConnectParams(roomId, {
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    });

    // -- STANDBY side (A2): drive the REAL StandbyWarmPipeCoordinator to produce the
    //    reverse UP-announce. We bind the (still-unconnected) standby pipe via the
    //    documented test seam; reverseConsumeAndAnnounce consumes the local producer
    //    onto it (mediasoup TOLERATES consume-before-connect, inter-relay.ts:1218-1223)
    //    so the announce -- carrying the pipe consumer's REMAPPED rtpParameters -- is
    //    available BEFORE the primary leg is bound. That is what lets us drive the
    //    QUEUE-before-drain order (REQ-RMS-037). --
    const standbyCoord = new StandbyWarmPipeCoordinator(
      new InterRelayProducerRegistry(),
      undefined, // logger
      undefined, // onLocalProducer (forward active-forward callback) -- unused here
      false, // activeForward DEFAULT preserved (REQ-RO-005 paused-keepalive not regressed)
    );
    standbyCoord.bindPipeTransportForTest(roomId, DEFAULT_PEER_RELAY_ID, standbyPipe);

    let reverseAnnounced:
      | {
          producerId: string;
          kind: msTypes.MediaKind;
          rtpParameters: msTypes.RtpParameters;
          producerPeerId?: string;
        }
      | null = null;
    standbyCoord.setReverseAnnouncer((_roomId, piped, producerPeerId, _peerRelayId, rtpParameters) => {
      reverseAnnounced = {
        producerId: piped.id,
        kind: piped.kind,
        rtpParameters: rtpParameters as msTypes.RtpParameters,
        producerPeerId,
      };
    });

    // A2: a standby-homed local client produced -> reverse-consume onto the warm
    // pipe UP + announce the piped consumer (threading the ORIGINAL publisher id).
    await standbyCoord.onLocalClientProducer(
      roomId,
      standbyRouter,
      publisher.producer,
      ORIGINAL_PUBLISHER,
    );

    expect(reverseAnnounced).not.toBeNull();
    const announced: {
      producerId: string;
      kind: msTypes.MediaKind;
      rtpParameters: msTypes.RtpParameters;
      producerPeerId?: string;
    } = reverseAnnounced!;
    // The announce carries the PIPED consumer id, NOT the source producer id.
    expect(announced.producerId).not.toBe(publisher.producer.id);
    // The pipe REMAPS the SSRC (REQ-RMS-026); the announce carries the REMAPPED ssrc.
    const remappedSsrc = announced.rtpParameters.encodings?.[0]?.ssrc;
    expect(remappedSsrc).toBeDefined();
    expect(remappedSsrc).not.toBe(OPUS_SSRC);
    // The ORIGINAL publisher id rode the announce so the queue entry carries it.
    expect(announced.producerPeerId).toBe(ORIGINAL_PUBLISHER);

    // -- ASSERTION 1 (REQ-RMS-037 ORDERING) -- reverseMint while the primary leg is
    //    NOT bound returns null = the QUEUE path. Proves the producer announced
    //    BEFORE the primary leg was ready; a non-null (immediate-path) mint would
    //    NOT exercise the drain tail. The spy must NOT have fired yet. --
    const queued = await primaryCoord.reverseMint(roomId, primaryRouter, announced);
    expect(queued).toBeNull();
    expect(reverseMintedCalls.length).toBe(0);

    // -- ASSERTION 2 (DRAINED-FAN TAIL) -- ensureReverseLeg mints + connects the
    //    primary's reverse-leg pipe on REAL mediasoup, replies DOWN, THEN drains the
    //    queued mint -> drainReverseMints fires onReverseMinted EXACTLY ONCE. This is
    //    the A6 double-race tail (bb72639) proven on real mediasoup. --
    await primaryCoord.ensureReverseLeg(roomId, primaryRouter);
    expect(primaryReply).not.toBeNull();
    const reply: PipeConnectParams = primaryReply!;

    expect(reverseMintedCalls.length).toBe(1);
    const fanCall = reverseMintedCalls[0]!;
    expect(fanCall.roomId).toBe(roomId);
    // 3rd arg is the peerRelayId of the draining leg -- DEFAULT here (single standby).
    expect(fanCall.originRelayId).toBe(DEFAULT_PEER_RELAY_ID);
    // 4th arg is the ORIGINAL publisher id threaded on the queue entry (REQ-RMS-029).
    expect(fanCall.producerPeerId).toBe(ORIGINAL_PUBLISHER);
    // The fanned object is a REAL minted Producer (not a stub): non-empty id + kind.
    const hubProducer = fanCall.minted;
    expect(typeof hubProducer.id).toBe('string');
    expect(hubProducer.id.length).toBeGreaterThan(0);
    expect(hubProducer.id).toBe(announced.producerId); // produceLocalFromPipe id == announced id
    expect(hubProducer.kind).toBe(announced.kind);
    expect(hubProducer.kind).toBe('audio');

    // A real local client on the primary COULD consume the drained hub copy.
    expect(
      primaryRouter.canConsume({
        producerId: hubProducer.id,
        rtpCapabilities: primaryRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // -- STANDBY completes the handshake: connect the standby pipe to the primary's
    //    bound port. Both PipeTransports are now connected to each other (loopback). --
    await standbyPipe.connect({
      ip: reply.ip,
      port: reply.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // -- DOWNSTREAM SINK on the PRIMARY -- observes the drained hub copy forwards real media. --
    const sinkTransport = await primaryRouter.createDirectTransport();
    const sink = await sinkTransport.consume({
      producerId: hubProducer.id,
      rtpCapabilities: primaryRouter.rtpCapabilities,
      paused: false,
    });
    const captured: Buffer[] = [];
    sink.on('rtp', (pkt: Buffer) => {
      captured.push(Buffer.from(pkt));
      if (captured.length > 256) captured.shift();
    });

    // -- DRIVE real RTP up the reverse pipe: standby publisher -> standbyPipe ->
    //    primaryPipe -> DRAINED hub producer -> primary sink. --
    publisher.start();
    const deadline = Date.now() + 5000;
    while (captured.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    await sleep(300);
    publisher.stop();

    // Real RTP forwarded end-to-end through the DRAINED hub producer.
    expect(captured.length).toBeGreaterThan(0);
    const stats = await sink.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    // -- ASSERTION 3 (BYTE-IDENTITY) -- the constant Opus payload rides the packet
    //    TAIL; the pipe remaps the header SSRC but never the body. ASSERTION 4 (the
    //    P10 RED hook) flips exactly one body byte so the tail no longer matches ->
    //    byteIdentical < mediaPackets -> this assertion FAILS (the teeth). --
    let mediaPackets = 0;
    let byteIdentical = 0;
    for (const pkt of captured) {
      if (pkt.length < 12 + OPUS_PAYLOAD.length) continue; // sanity gate (real media)
      mediaPackets++;
      if (FORCE_TAMPER) {
        // Flip exactly ONE media body byte (the last payload byte) on the reverse hop.
        const ti = pkt.length - 1;
        pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff;
      }
      if (pkt.subarray(pkt.length - OPUS_PAYLOAD.length).equals(OPUS_PAYLOAD)) {
        byteIdentical++;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-RMS-037 drained-fan] reverseMintQueued=${queued === null} ` +
        `onReverseMintedCalls=${reverseMintedCalls.length} ` +
        `mintedId=${hubProducer.id} mintedKind=${hubProducer.kind} ` +
        `originRelayId=${fanCall.originRelayId} producerPeerId=${fanCall.producerPeerId} ` +
        `captured=${captured.length} mediaPackets=${mediaPackets} byteIdentical=${byteIdentical} ` +
        `inboundPacketCount=${inbound?.packetCount} ` +
        `sourceSsrc=0x${OPUS_SSRC.toString(16)} remappedSsrc=0x${(remappedSsrc ?? 0).toString(16)}` +
        `${FORCE_TAMPER ? ' [P10 RED HOOK]' : ''}`,
    );
    expect(mediaPackets).toBeGreaterThan(0);
    // RED hook flips a body byte -> byteIdentical < mediaPackets -> FAIL (teeth).
    expect(byteIdentical).toBe(mediaPackets);

    // -- cleanup --
    try {
      sink.close();
      sinkTransport.close();
      hubProducer.close();
      publisher.producer.close();
      standbyPipe.close();
    } catch {
      /* best-effort */
    }
    primaryCoord.clear(roomId); // closes the primary reverse-leg pipe + releases the port
  }, 30_000);
});
