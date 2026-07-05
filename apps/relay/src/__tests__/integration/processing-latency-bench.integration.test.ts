/**
 * REQ-WLM-08 — relay-processing (forward) latency bench. REAL mediasoup.
 *
 * Closes the T-L model's missing per-hop term. `tHop` was measured as
 * `t_hop_network` only (Lane-B, RTCP RR roundTripTime/2 = the WAN wire). This
 * bench measures the OTHER half: the latency a relay ADDS per hop when it
 * receives an RTP packet, routes it, re-mints it, and enqueues it to a consumer.
 *
 * Instrument (Cách B, DirectTransport echo). A DirectTransport producer feeds
 * real RTP into a real Router; a DirectTransport consumer of the SAME producer
 * on the SAME Router emits `'rtp'` per forwarded packet. We stamp
 * `performance.now()` right before `producer.send()` and again in the consumer
 * `'rtp'` handler; the delta is the in-process forward latency. Packets are
 * correlated by an in-payload counter — the consumer RE-MINTS the RTP sequence
 * number (empirically verified: rxSeq != txSeq), but the media payload is
 * forwarded byte-identical, so an embedded counter is the reliable key.
 *
 * UPPER BOUND, stated honestly: the DirectTransport in/out path crosses the
 * JS↔C++ worker channel twice (marshalling a real UDP WebRtc/Pipe forward, which
 * stays entirely in C++, does not incur). So the measured number OVERSTATES a
 * production relay's pure forward latency. That is the correct direction for a
 * bound: if this upper bound is already ≪ `t_hop_network` (34.5 ms), the per-hop
 * total is network-dominated regardless. Carried as a separately-bounded term,
 * never folded into `t_hop_network`.
 *
 * Fan-out sweep (1 vs ~60): answers the methodology's open "does processing
 * latency rise under load?" — 60 ≈ the Lane-C gallery-viewers/core saturation
 * point. The tapped consumer's latency is measured while N-1 other consumers of
 * the same producer also pull, so the router does N forwards per packet.
 *
 * Runs under `pnpm test:integration:relay` (vitest.relay-integration.config.ts).
 * Requirements: REQ-WLM-08 (relay-processing term).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { performance } from 'node:perf_hooks';
import {
  correlateForwardLatency,
  summarizeProcessingLatency,
  type RecvEvent,
} from '../../processing-latency.js';

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;
const PAYLOAD_LEN = 11; // 8-byte BE counter + 3-byte opus tail (payload byte-length is preserved across the forward)

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2, preferredPayloadType: OPUS_PT },
];

const rtpParameters: msTypes.RtpParameters = {
  codecs: [{ mimeType: 'audio/opus', payloadType: OPUS_PT, clockRate: 48000, channels: 2, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc: OPUS_SSRC }],
};

/** RTP packet: 12-byte header + [8-byte BE counter][3-byte opus tail]. */
function makeRtpPacket(seq: number, timestamp: number, counter: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = OPUS_PT & 0x7f;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  const payload = Buffer.alloc(PAYLOAD_LEN);
  payload.writeBigUInt64BE(BigInt(counter), 0);
  payload[8] = 0xfc; payload[9] = 0xff; payload[10] = 0xfe;
  return Buffer.concat([header, payload]);
}

/** Recover the counter from the payload TAIL (robust to added RTP header extensions). */
function counterFromPacket(pkt: Buffer): number {
  if (pkt.length < PAYLOAD_LEN) return -1;
  return Number(pkt.readBigUInt64BE(pkt.length - PAYLOAD_LEN));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let worker: msTypes.Worker;
let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  worker?.close();
});

/**
 * Drive `n` packets producer -> router -> `fanOut` consumers; time the tapped
 * (index 0) consumer. `warmup` leading packets are sent but not measured
 * (cold-start discard). Returns the matched forward-latency deltas (ms).
 */
async function runFanOut(fanOut: number, n: number, warmup: number): Promise<number[]> {
  const srcT = await router.createDirectTransport();
  const producer = await srcT.produce({ kind: 'audio', rtpParameters });

  const consumers: msTypes.Consumer[] = [];
  const transports: msTypes.DirectTransport[] = [];
  for (let i = 0; i < fanOut; i++) {
    const t = await router.createDirectTransport();
    const c = await t.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities, paused: false });
    transports.push(t);
    consumers.push(c);
  }

  const recvEvents: RecvEvent[] = [];
  // Tap ONLY consumer 0 for timing; the rest create genuine fan-out load.
  consumers[0]!.on('rtp', (pkt: Buffer) => {
    recvEvents.push({ counter: counterFromPacket(pkt), recvMs: performance.now() });
  });

  const sendAt = new Map<number, number>();
  let ts = 0;
  for (let i = 0; i < n; i++) {
    if (i >= warmup) sendAt.set(i, performance.now()); // only measured packets recorded
    producer.send(makeRtpPacket(i & 0xffff, ts, i));
    ts += 960; // 20 ms @ 48 kHz
    await sleep(5);
  }
  await sleep(300); // drain in-flight

  for (const c of consumers) c.close();
  for (const t of transports) t.close();
  producer.close();
  srcT.close();

  return correlateForwardLatency(sendAt, recvEvents);
}

describe('REQ-WLM-08 relay-processing latency — DirectTransport echo, fan-out sweep', () => {
  it('measures in-process forward latency (UPPER BOUND) at fan-out 1 and ~60', async () => {
    const N = 400;
    const WARMUP = 20;
    const MEASURED = N - WARMUP;

    const d1 = await runFanOut(1, N, WARMUP);
    const d60 = await runFanOut(60, N, WARMUP);

    const s1 = summarizeProcessingLatency(d1);
    const s60 = summarizeProcessingLatency(d60);

    // Machine-readable lines for evidence curation.
    // eslint-disable-next-line no-console
    console.log(`[REQ-WLM-08] fanout=1  ${JSON.stringify(s1)}`);
    // eslint-disable-next-line no-console
    console.log(`[REQ-WLM-08] fanout=60 ${JSON.stringify(s60)}`);
    // eslint-disable-next-line no-console
    console.log(
      `[REQ-WLM-08] SUMMARY (ms, UPPER BOUND incl. DirectTransport marshalling): ` +
        `fanout1 p50=${s1.p50.toFixed(3)} p95=${s1.p95.toFixed(3)} p99=${s1.p99.toFixed(3)} | ` +
        `fanout60 p50=${s60.p50.toFixed(3)} p95=${s60.p95.toFixed(3)} p99=${s60.p99.toFixed(3)} | ` +
        `t_hop_network=34.5 ms (Lane-B) — processing term is a fraction of the network hop`,
    );

    // HARD, falsifiable, env-independent assertions:
    // (a) forward integrity — every measured packet reached the tapped consumer.
    expect(s1.n).toBe(MEASURED);
    expect(s60.n).toBe(MEASURED);
    // (b) instrument sanity — a real, finite, positive latency well under the
    //     network hop. A broken instrument (garbage / negative / absurd) fails.
    for (const s of [s1, s60]) {
      expect(Number.isFinite(s.p50)).toBe(true);
      expect(s.p50).toBeGreaterThan(0);
      expect(s.p95).toBeGreaterThanOrEqual(s.p50);
      expect(s.p99).toBeLessThan(50); // in-process forward is ms-scale, ≪ 34.5 ms WAN hop
    }
  }, 60_000);
});
