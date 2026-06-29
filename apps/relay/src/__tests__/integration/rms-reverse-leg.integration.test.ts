/**
 * REQ-RMS-034 / 026 (part-3 REVERSE leg) -- R-A GREEN CHECKPOINT.
 *
 * The FIRST real-mediasoup end-to-end exercise of the reverse hop built in
 * A1-A4. The forward warm-pipe model (warmpipe-rtp / rms-active-forward) flows
 *   publisher -> PRIMARY router -> pipe -> STANDBY router -> local clients.
 * The REVERSE leg INVERTS the roles: a STANDBY-homed local client produces ->
 * the standby reverse-consumes it onto the warm pipe UP -> the PRIMARY mints a
 * LOCAL hub copy via produceLocalFromPipe so the primary's own clients (and the
 * rest of the mesh) can consume it.
 *
 * This is NOT a mock. It spawns TWO real mediasoup Workers (two child processes
 * = standby + primary daemons), wires two REAL connected PipeTransports, and
 * drives the REAL part-3 coordinators end-to-end:
 *
 *   - STANDBY side (A2): StandbyWarmPipeCoordinator.onLocalClientProducer ->
 *     reverseConsumeAndAnnounce -> pipeProducerOntoPrimaryTransport(standbyPipe)
 *     -> fires the reverse UP-announce carrying the pipe CONSUMER's REMAPPED
 *     rtpParameters (REQ-RMS-026).
 *   - PRIMARY side (A3b): PrimaryPipeCoordinator.ensureReverseLeg mints+connects
 *     the primary's reverse-leg PipeTransport on REAL mediasoup (the path the
 *     unit tests cannot cover -- inter-relay.ts:1809-1813) + replies DOWN with
 *     its own bound port; reverseMint -> produceLocalFromPipe(primaryPipe) mints
 *     the LOCAL hub producer.
 *
 * It asserts, on real media crossing the real reverse pipe:
 *   (a) SSRC remap (REQ-RMS-026): the reverse pipe consumer's announced
 *       rtpParameters SSRC != the publisher's SSRC (mediasoup remaps on pipe).
 *   (b) Mintable on the PRIMARY: the minted hub producer is canConsume(...) by
 *       the primary router -- a real local client on the primary COULD consume it.
 *   (c) Byte-identity across the reverse pipe: the media BODY is byte-identical
 *       end-to-end (byteIdentical === mediaPackets && mediaPackets > 0).
 *   (d) P10 RED hook: with P10_FORCE_TAMPER set, exactly one media body byte is
 *       flipped on the reverse hop so byteIdentical < mediaPackets -> the
 *       byte-identity assertion FAILS (the test's teeth). Unset -> PASS again.
 *
 * RTP source: a DirectTransport producer on the STANDBY router fed synthetic
 * Opus RTP via producer.send(buf) -- fully in-process, no ffmpeg/browser/UDP.
 * RTP sink: a DirectTransport consumer on the PRIMARY router whose 'rtp' event
 * proves the hub copy forwards real media.
 *
 * Run:
 *   pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *     apps/relay/src/__tests__/integration/rms-reverse-leg.integration.test.ts
 *
 * Requirements touched: REQ-RMS-034, REQ-RMS-026 (+ REQ-RMS-037 leg ordering).
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

// ── Shared codec set (mirrors mediasoup-manager.ts / rms-active-forward) ────

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

// ── Module-scoped real mediasoup workers (spawned once) ─────────────────────
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

describe('REQ-RMS-034 — part-3 REVERSE leg: standby local producer -> reverse pipe UP -> PRIMARY hub mint (real mediasoup)', () => {
  it('reverse-consumes a standby local producer onto the warm pipe UP, the PRIMARY mints a canConsume hub copy, media is byte-identical across the reverse pipe (P10 RED hook = teeth)', async () => {
    const roomId = 'rms-reverse-room';
    const ORIGINAL_PUBLISHER = 'standby-publisher-peer';

    // The standby-homed local client (NOT started yet -- RTP flows AFTER wiring).
    const publisher = await makeStandbyRtpSource();

    // ── STANDBY HALF: the warm-pipe PipeTransport the standby reverse-consumes onto. ──
    // port:0 => OS-assigned (rerun-safe).
    const standbyPipe = await createStandbyPipeTransport(standbyRouter, 0);

    // ── PRIMARY side (A3b): ensureReverseLeg mints+connects the primary's reverse
    //    leg on REAL mediasoup + replies DOWN with its OWN bound port. This is the
    //    real-mediasoup mint path the unit tests cannot cover (inter-relay.ts:1809). ──
    let primaryReply: PipeConnectParams | null = null;
    const primaryCoord = new PrimaryPipeCoordinator({
      announcer: () => {}, // forward announce -- never fired on the reverse flow
      portAllocator: zeroAllocator,
      paramSender: (_roomId, params) => {
        primaryReply = params; // the §2 DOWN-reply (primary's own pipe port)
      },
    });
    // Standby's pipe-connect params go UP first (the standby endpoint of the §2 handshake).
    await primaryCoord.onStandbyConnectParams(roomId, {
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    });
    // Primary mints + connects its reverse-leg pipe to the standby + replies DOWN.
    await primaryCoord.ensureReverseLeg(roomId, primaryRouter);
    expect(primaryReply).not.toBeNull();
    const reply: PipeConnectParams = primaryReply!;

    // ── STANDBY completes the handshake: connect the standby pipe to the primary's port. ──
    await standbyPipe.connect({
      ip: reply.ip,
      port: reply.port,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    // Both PipeTransports are now connected to each other (loopback).

    // ── STANDBY side (A2): drive the REAL StandbyWarmPipeCoordinator. ──
    const standbyCoord = new StandbyWarmPipeCoordinator(
      new InterRelayProducerRegistry(),
      undefined, // logger
      undefined, // onLocalProducer (forward active-forward callback) -- unused here
      false, // activeForward DEFAULT preserved (REQ-RO-005 paused-keepalive not regressed)
    );
    // Bind the connected standby pipe onto the leg (the documented test seam that
    // mirrors how onPrimaryConnectParams retains topology.pipeTransport).
    standbyCoord.bindPipeTransportForTest(roomId, DEFAULT_PEER_RELAY_ID, standbyPipe);

    // Capture the reverse UP-announce (the piped consumer id + REMAPPED rtpParameters).
    let reverseAnnounced:
      | { producerId: string; kind: msTypes.MediaKind; rtpParameters: msTypes.RtpParameters }
      | null = null;
    standbyCoord.setReverseAnnouncer((_roomId, piped, _producerPeerId, _peerRelayId, rtpParameters) => {
      reverseAnnounced = {
        producerId: piped.id,
        kind: piped.kind,
        rtpParameters: rtpParameters as msTypes.RtpParameters,
      };
    });

    // A2 UNDER TEST: a standby-homed local client produced -> reverse-consume onto
    // the warm pipe UP + announce the piped consumer.
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
    } = reverseAnnounced!;
    // The announce carries the PIPED consumer id, NOT the source producer id.
    expect(announced.producerId).not.toBe(publisher.producer.id);

    // ── ASSERTION (a) — SSRC remap (REQ-RMS-026). The pipe REMAPS the SSRC; the
    //    announce carries the REMAPPED ssrc (exactly why it carries rtpParameters). ──
    const remappedSsrc = announced.rtpParameters.encodings?.[0]?.ssrc;
    expect(remappedSsrc).toBeDefined();
    expect(remappedSsrc).not.toBe(OPUS_SSRC);

    // ── PRIMARY side (A3b): reverseMint -> produceLocalFromPipe mints the LOCAL hub. ──
    const hubProducer = await primaryCoord.reverseMint(roomId, primaryRouter, announced);
    expect(hubProducer).not.toBeNull();
    expect(hubProducer!.id).toBe(announced.producerId);

    // ── ASSERTION (b) — Mintable on the PRIMARY: a real local client on the
    //    primary COULD consume the hub copy. ──
    expect(
      primaryRouter.canConsume({
        producerId: hubProducer!.id,
        rtpCapabilities: primaryRouter.rtpCapabilities,
      }),
    ).toBe(true);

    // ── DOWNSTREAM SINK on the PRIMARY -- observes the hub copy forwards real media. ──
    const sinkTransport = await primaryRouter.createDirectTransport();
    const sink = await sinkTransport.consume({
      producerId: hubProducer!.id,
      rtpCapabilities: primaryRouter.rtpCapabilities,
      paused: false,
    });
    const captured: Buffer[] = [];
    sink.on('rtp', (pkt: Buffer) => {
      captured.push(Buffer.from(pkt));
      if (captured.length > 256) captured.shift();
    });

    // ── DRIVE real RTP up the reverse pipe: standby publisher -> standbyPipe ->
    //    primaryPipe -> hub producer -> primary sink. ──
    publisher.start();
    const deadline = Date.now() + 5000;
    while (captured.length === 0 && Date.now() < deadline) {
      await sleep(50);
    }
    await sleep(300);
    publisher.stop();

    // Real RTP forwarded end-to-end through the minted hub producer.
    expect(captured.length).toBeGreaterThan(0);
    const stats = await sink.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    // ── ASSERTION (c) — Byte-identity across the reverse pipe. The constant Opus
    //    payload rides the packet TAIL; the pipe remaps the header SSRC but never
    //    the body. (d) the P10 RED hook flips exactly one body byte so the tail no
    //    longer matches -> byteIdentical < mediaPackets -> this assertion FAILS. ──
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
      `[REQ-RMS-034 reverse-leg] captured=${captured.length} mediaPackets=${mediaPackets} ` +
        `byteIdentical=${byteIdentical} inboundPacketCount=${inbound?.packetCount} ` +
        `sourceSsrc=0x${OPUS_SSRC.toString(16)} remappedSsrc=0x${(remappedSsrc ?? 0).toString(16)}` +
        `${FORCE_TAMPER ? ' [P10 RED HOOK]' : ''}`,
    );
    expect(mediaPackets).toBeGreaterThan(0);
    // RED hook flips a body byte -> byteIdentical < mediaPackets -> FAIL (teeth).
    expect(byteIdentical).toBe(mediaPackets);

    // ── cleanup ──
    try {
      sink.close();
      sinkTransport.close();
      hubProducer!.close();
      publisher.producer.close();
      standbyPipe.close();
    } catch {
      /* best-effort */
    }
    primaryCoord.clear(roomId); // closes the primary reverse-leg pipe + releases the port
  }, 30_000);
});
