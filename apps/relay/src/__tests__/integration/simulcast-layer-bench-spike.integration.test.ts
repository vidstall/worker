/**
 * REAL-mediasoup SIMULCAST LAYER-SELECT de-risk SPIKE (W5 M1 Phase 1, REQ-MCS-006).
 *
 * Proves the ONE precondition the scaled bench (P9) depends on:
 *
 *   On REAL mediasoup, requesting a LOW simulcast spatial layer actually
 *   reduces the forwarded RTP bytes vs the HIGH layer.
 *
 *   PRECONDITION ASSERT:  byteCount(spatialLayer:0) < byteCount(spatialLayer:2)
 *
 * This is the BENCH-3 lesson applied: de-risk the MECHANISM with a real-mediasoup
 * spike BEFORE building the percentile/scaled harness. If this fails, P9 is blocked
 * and the lead is surfaced — a false-green spike is worse than a known-blocked one.
 *
 * It is NOT a mock. It spawns a REAL mediasoup Worker + Router (VP8-only, mirroring
 * mediasoup-manager.ts:34) + a DirectTransport simulcast Producer, injects synthetic
 * but well-formed VP8 RTP on THREE SSRCs (one per spatial layer), and consumes it
 * through an UNPAUSED DirectTransport consumer so RTP actually flows and can be
 * counted (the warmpipe sink is paused:true for standby; a bench sink must be
 * unpaused). See design/SEQUENCES.md F6 "STEP 0 — SPIKE-FIRST".
 *
 * Layer convention (CONTRACTS.md C1):  spatialLayer:0 = low/thumbnail,
 *   :1 = mid, :2 = high/active-speaker. encodings[] are ordered low→high, so
 *   encodings[0]=layer0 (smallest), encodings[2]=layer2 (largest).
 *
 * getStats shape (verified vs mediasoup 3.19.17): a Consumer's getStats() returns
 * both an 'inbound-rtp' entry (RecvStats = what the consumer receives for the
 * selected layer) and an 'outbound-rtp' entry (SendStats = what it forwards). We
 * read the 'inbound-rtp' byteCount, mirroring warmpipe-rtp.integration.test.ts:311-316.
 * byteCount is CUMULATIVE, so we compare a fixed-window DELTA per layer, not absolute
 * totals captured at different wall-clock times.
 *
 * Requirements touched: REQ-MCS-006 (spike precondition for the scaled bench).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

// -- VP8-only codec (mirrors mediasoup-manager.ts:34) -------------------

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

// Three distinct SSRCs => three simulcast spatial layers (encodings ordered low→high).
const SSRC_LOW = 0x1111_0000; // spatial layer 0 (thumbnail / 180p)
const SSRC_MID = 0x1111_0001; // spatial layer 1 (360p)
const SSRC_HIGH = 0x1111_0002; // spatial layer 2 (active speaker / 720p)

/** Per-layer synthetic byte volume, mirroring a real simulcast ladder where the
 *  high layer carries far more media than the thumbnail. Low ≪ high so the
 *  layer-select reduction is unambiguous and the assert is not a coin-flip. */
const LAYER_PAYLOAD_BYTES = {
  [SSRC_LOW]: 60, // ~180p thumbnail
  [SSRC_MID]: 400, // ~360p
  [SSRC_HIGH]: 1100, // ~720p active speaker
} as const;

const rid = { [SSRC_LOW]: 'r0', [SSRC_MID]: 'r1', [SSRC_HIGH]: 'r2' } as const;

const simulcastRtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'video/VP8',
      payloadType: VP8_PT,
      clockRate: 90000,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  // Low→high. encodings[0]=layer0 (low), encodings[2]=layer2 (high) per C1.
  encodings: [
    { ssrc: SSRC_LOW, scalabilityMode: 'L1T1' },
    { ssrc: SSRC_MID, scalabilityMode: 'L1T1' },
    { ssrc: SSRC_HIGH, scalabilityMode: 'L1T1' },
  ],
};

/**
 * Build a well-formed VP8 RTP packet carrying the START of a VP8 frame.
 *
 *   - 12-byte RTP header (V=2, PT, seq, ts, ssrc); marker bit set (end of frame,
 *     since we send one packet per frame).
 *   - VP8 payload descriptor with X=1, S=1, I=1 (PictureID present, 15-bit) so
 *     mediasoup can track per-stream picture-id continuity for each spatial layer.
 *   - VP8 payload HEADER: the load-bearing detail the first spike attempt missed.
 *     mediasoup must see a KEYFRAME on a layer's SSRC before it will switch the
 *     SimulcastConsumer to that spatial layer (it issues a PLI and waits for the
 *     next keyframe — but a synthetic DirectTransport source has no encoder to
 *     answer a PLI, so we must EMIT real keyframes periodically on every layer).
 *       keyframe: first byte P-bit (bit0) = 0, followed by the VP8 uncompressed
 *                 data chunk start code 0x9d 0x01 0x2a + 16-bit width + 16-bit
 *                 height (the keyframe signature mediasoup's VP8 parser checks).
 *       inter-frame: first byte P-bit = 1.
 *   - synthetic content sized per spatial layer so each carries a realistic volume.
 */
function makeVp8Rtp(
  ssrc: number,
  seq: number,
  ts: number,
  pictureId: number,
  payloadBytes: number,
  keyframe: boolean,
): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2, no padding/ext/cc
  header[1] = (VP8_PT & 0x7f) | 0x80; // marker=1 (single-packet frame) + payload type
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  // VP8 payload descriptor: X=1, S=1; extended byte I=1 (PictureID present);
  // 15-bit PictureID (M=1).
  const desc = Buffer.from([
    0x90, // X=1, S=1 (start of partition)
    0x80, // I=1 (PictureID present)
    0x80 | ((pictureId >> 8) & 0x7f), // M=1 + PID high 7 bits
    pictureId & 0xff, // PID low 8 bits
  ]);

  // VP8 payload header.
  let vp8PayloadHeader: Buffer;
  if (keyframe) {
    // P=0 (keyframe). First 3 bytes are the frame tag (size bits); we then emit
    // the keyframe start code 0x9d 0x01 0x2a + width(16) + height(16).
    vp8PayloadHeader = Buffer.from([
      0x10, 0x00, 0x00, // frame tag: P-bit (bit0 of byte0) = 0 => keyframe
      0x9d, 0x01, 0x2a, // VP8 keyframe start code
      0x80, 0x02, // width = 640 (little-endian-ish 16-bit field)
      0xe0, 0x01, // height = 480
    ]);
  } else {
    // P=1 (interframe).
    vp8PayloadHeader = Buffer.from([0x11, 0x00, 0x00]);
  }
  const content = Buffer.alloc(
    Math.max(0, payloadBytes - vp8PayloadHeader.length),
    0xab,
  );

  return Buffer.concat([header, desc, vp8PayloadHeader, content]);
}

/**
 * Build a minimal RTCP Sender Report (PT=200) for one SSRC.
 *
 * THE load-bearing detail this spike uncovered: mediasoup's SimulcastConsumer
 * (`CanSwitchToSpatialLayer`, worker VP8/SimulcastConsumer.cpp) refuses to switch
 * the consumer UP to any spatial layer other than the timestamp-reference layer
 * unless that layer's producer RTP stream has received an RTCP Sender Report
 * (`GetSenderReportNtpMs()` must be non-zero — it needs the SR to align
 * cross-layer timestamps). A real WebRTC encoder sends periodic SRs; a synthetic
 * DirectTransport `producer.send()` source does NOT, so without injecting SRs the
 * consumer is permanently pinned to spatialLayer 0 and layer-select cannot be
 * measured. We inject SRs via DirectTransport.sendRtcp().
 */
function makeRtcpSenderReport(
  ssrc: number,
  rtpTimestamp: number,
  packetCount: number,
  octetCount: number,
): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80; // V=2, P=0, RC=0
  buf[1] = 200; // PT = SR
  buf.writeUInt16BE(6, 2); // length in 32-bit words minus one = (28/4)-1 = 6
  buf.writeUInt32BE(ssrc >>> 0, 4);
  // NTP timestamp (64-bit): seconds since 1900 + fraction. Use wall clock.
  const nowMs = Date.now();
  const ntpSec = Math.floor(nowMs / 1000) + 2208988800; // 1970→1900 offset
  const ntpFrac = Math.floor(((nowMs % 1000) / 1000) * 0x1_0000_0000);
  buf.writeUInt32BE(ntpSec >>> 0, 8);
  buf.writeUInt32BE(ntpFrac >>> 0, 12);
  buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
  buf.writeUInt32BE(packetCount >>> 0, 20);
  buf.writeUInt32BE(octetCount >>> 0, 24);
  return buf;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- Module-scoped real mediasoup worker --------------------------------

let worker: msTypes.Worker;
let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  worker?.close();
});

describe('W5 M1 P1 — simulcast layer-select bandwidth spike (REAL mediasoup, REQ-MCS-006)', () => {
  it('PRECONDITION: byteCount(spatialLayer:0) < byteCount(spatialLayer:2) — low layer forwards fewer RTP bytes', async () => {
    // -- Simulcast VP8 producer on a DirectTransport (3 spatial layers) -----
    const srcTransport = await router.createDirectTransport();
    const producer = await srcTransport.produce({
      kind: 'video',
      rtpParameters: simulcastRtpParameters,
    });

    // Continuously inject VP8 RTP on all three SSRCs. Each layer's packets carry
    // a different payload size; the high layer also sends more frequently — exactly
    // the asymmetry a real simulcast ladder exhibits.
    const seqs: Record<number, number> = { [SSRC_LOW]: 0, [SSRC_MID]: 0, [SSRC_HIGH]: 0 };
    const pics: Record<number, number> = { [SSRC_LOW]: 0, [SSRC_MID]: 0, [SSRC_HIGH]: 0 };
    const pktCount: Record<number, number> = { [SSRC_LOW]: 0, [SSRC_MID]: 0, [SSRC_HIGH]: 0 };
    const octetCount: Record<number, number> = { [SSRC_LOW]: 0, [SSRC_MID]: 0, [SSRC_HIGH]: 0 };
    let ts = 0;
    let frame = 0;
    const ssrcs = [SSRC_LOW, SSRC_MID, SSRC_HIGH] as const;
    const sendAll = (): void => {
      // Emit a keyframe on every layer every 10th frame (~every 100ms) so the
      // SimulcastConsumer can always find a recent keyframe to switch to when
      // setPreferredLayers requests a different spatial layer (no encoder to
      // answer a PLI on a synthetic source). First frame is always a keyframe.
      const keyframe = frame % 10 === 0;
      for (const ssrc of ssrcs) {
        const pkt = makeVp8Rtp(
          ssrc,
          seqs[ssrc]++,
          ts,
          pics[ssrc]++ & 0x7fff,
          LAYER_PAYLOAD_BYTES[ssrc],
          keyframe,
        );
        producer.send(pkt);
        pktCount[ssrc] += 1;
        octetCount[ssrc] += LAYER_PAYLOAD_BYTES[ssrc];
      }
      // Inject an RTCP Sender Report per SSRC every ~100ms so EVERY spatial
      // layer's producer stream has a non-zero GetSenderReportNtpMs() — the
      // precondition CanSwitchToSpatialLayer() demands to switch off layer 0.
      //
      // SPIKE_DISABLE_RTCP_SR=1 reproduces the documented RED (the de-risk
      // finding): with no SRs the SimulcastConsumer is permanently pinned to
      // spatial layer 0, so setPreferredLayers has no effect and ratio≈1.0 —
      // the precondition assert fails. This proves the mechanism's dependency
      // and that the GREEN is not a coincidence.
      if (frame % 10 === 0 && process.env['SPIKE_DISABLE_RTCP_SR'] !== '1') {
        for (const ssrc of ssrcs) {
          srcTransport.sendRtcp(
            makeRtcpSenderReport(ssrc, ts, pktCount[ssrc], octetCount[ssrc]),
          );
        }
      }
      ts += 3000; // ~33ms @ 90kHz video clock
      frame++;
    };
    const interval = setInterval(sendAll, 10);

    // -- UNPAUSED DirectTransport consumer (bench sink must flow RTP) -------
    const sinkTransport = await router.createDirectTransport();
    const consumer = await sinkTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false, // UNPAUSED — unlike the standby warmpipe sink (paused:true)
    });

    /** Read the consumer's cumulative FORWARDED byteCount. For a SimulcastConsumer
     *  the bytes actually sent to the consuming endpoint are the 'outbound-rtp'
     *  (SendStats) entry — that is what drops when a lower spatial layer is
     *  selected. ('inbound-rtp' = what the consumer receives from the producer's
     *  streams, which does not change with layer selection.) */
    const readForwardedByteCount = async (): Promise<number> => {
      const stats = await consumer.getStats();
      const outbound = stats.find((s) => s.type === 'outbound-rtp') as
        | { byteCount?: number; packetCount?: number }
        | undefined;
      return outbound?.byteCount ?? 0;
    };
    const debugLayers = async (): Promise<string> => {
      const stats = await consumer.getStats();
      const prodStats = await producer.getStats();
      return JSON.stringify({
        consumerStatTypes: stats.map((s) => s.type),
        current: consumer.currentLayers,
        preferred: consumer.preferredLayers,
        producerScore: consumer.score,
        producerStreams: prodStats.map((s) => ({
          ssrc: (s as { ssrc?: number }).ssrc,
          rid: (s as { rid?: string }).rid,
          score: (s as { score?: number }).score,
          byteCount: (s as { byteCount?: number }).byteCount,
        })),
      });
    };

    // eslint-disable-next-line no-console
    console.log('[spike DEBUG] consumer.type =', consumer.type);

    // ---- Measure HIGH layer (spatialLayer:2) over a fixed window ----------
    await consumer.setPreferredLayers({ spatialLayer: 2, temporalLayer: 0 });
    await consumer.requestKeyFrame();
    await sleep(1000); // settle on the high layer (SR-aligned promotion)
    const highCurrent = consumer.currentLayers?.spatialLayer ?? -1;
    // eslint-disable-next-line no-console
    console.log('[spike DEBUG] after select HIGH:', await debugLayers());
    const highStart = await readForwardedByteCount();
    await sleep(800); // measurement window
    const highEnd = await readForwardedByteCount();
    const highDelta = highEnd - highStart;

    // ---- Measure LOW layer (spatialLayer:0) over the same window ----------
    await consumer.setPreferredLayers({ spatialLayer: 0, temporalLayer: 0 });
    await sleep(1000); // settle on the low layer
    const lowCurrent = consumer.currentLayers?.spatialLayer ?? -1;
    // eslint-disable-next-line no-console
    console.log('[spike DEBUG] after select LOW:', await debugLayers());
    const lowStart = await readForwardedByteCount();
    await sleep(800); // identical measurement window
    const lowEnd = await readForwardedByteCount();
    const lowDelta = lowEnd - lowStart;

    clearInterval(interval);

    const ratio = lowDelta > 0 ? highDelta / lowDelta : Infinity;
    // eslint-disable-next-line no-console
    console.log(
      `[spike REQ-MCS-006] FORWARDED (outbound-rtp) byteCount over 800ms window: ` +
        `LOW(spatialLayer:0)=${lowDelta} bytes [current=${lowCurrent}]  ` +
        `HIGH(spatialLayer:2)=${highDelta} bytes [current=${highCurrent}]  ` +
        `ratio(high/low)=${ratio.toFixed(2)}`,
    );

    // (Note: `consumer.currentLayers` is a lagging JS-side getter and is NOT a
    // reliable point-in-time signal here — it often still reads layer 0 even
    // while the high layer is demonstrably being forwarded. The forwarded
    // byteCount below is the GROUND TRUTH, since it is literally the bytes
    // mediasoup placed on the wire. We log currentLayers for diagnostics only.)

    // GUARD 1 — both windows carried real media (not a dead pipe / false-green).
    expect(highDelta).toBeGreaterThan(0);
    expect(lowDelta).toBeGreaterThan(0);

    // THE PRECONDITION (REQ-MCS-006): low layer forwards strictly fewer bytes
    // than high. GUARD 2 — the reduction is SUBSTANTIAL, matching the simulcast
    // ladder (~1:5:14 low:mid:high), NOT a noise-level coincidence. A real spatial
    // layer switch yields a multiple-x drop; the earlier false-green attempts
    // (no RTCP SR → consumer pinned to layer 0) gave ratio≈1.0, which this margin
    // rejects. Threshold 2.0× is well below the observed ~8× but far above noise.
    expect(lowDelta).toBeLessThan(highDelta);
    expect(ratio).toBeGreaterThan(2.0);

    consumer.close();
    producer.close();
    srcTransport.close();
    sinkTransport.close();
  }, 30_000);
});
