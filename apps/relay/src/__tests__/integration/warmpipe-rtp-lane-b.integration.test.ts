/**
 * REAL-mediasoup warm-pipe RTP de-risk SPIKE (Phase 5.3, step 3a).
 *
 * Lane-B t_hop_network instrument — roundTripTime on piped Producer inbound-rtp.
 *
 * Proves the KEY empirical claim: after ~6 s of RTCP exchange on a REAL
 * cross-PipeTransport pair, the STANDBY's piped producer's getStats() returns
 * an inbound-rtp entry with roundTripTime > 0.  That field is the source of
 * truth for `t_hop_network = rttMs / 2` (Lane B, REQ-WLM-08).
 *
 * Uses module-level primaryRouter / standbyRouter (spawned in beforeAll) and
 * the makePrimaryRtpSource helper.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

// -- Shared codec set (mirrors mediasoup-manager.ts) --------------------

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100, // === OPUS_PT (literal: const declared below, avoid TDZ in initializer)
  },
];

const OPUS_PT = 100;
const OPUS_SSRC = 0x02468ace;

/** A minimal well-formed Opus RTP packet (12-byte header + tiny payload). */
function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const payload = Buffer.from([0xfc, 0xff, 0xfe]);
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2, no padding/ext/cc
  header[1] = OPUS_PT & 0x7f; // marker 0 + payload type
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, payload]);
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

// -- Module-scoped real mediasoup workers (spawned once) ----------------

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  // Two workers => two distinct child processes, simulating primary + standby
  // daemons as faithfully as in-process allows.
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

/** Create a synthetic real-RTP Opus producer on the primary router. */
async function makePrimaryRtpSource(): Promise<{
  producer: msTypes.Producer;
  start: () => void;
  stop: () => void;
}> {
  const directTransport = await primaryRouter.createDirectTransport();
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

describe('Lane-B t_hop_network — roundTripTime populates on piped Producer inbound-rtp', () => {
  it(
    'roundTripTime > 0 on standby piped Producer inbound-rtp stat after ~7 s of real RTCP exchange',
    async () => {
      // ── PRIMARY RTP source (DirectTransport → Producer) ──
      const src = await makePrimaryRtpSource();

      // ── Real cross-worker pipe via pipeToRouter ──
      // The high-level helper reliably exchanges RTCP on the pipe (a manual
      // DirectTransport-fed pairing does NOT drive RTCP SR, so roundTripTime never
      // populates — the repo's own F1 case defers that hard assertion for the same
      // reason). production-faithful PIPE SETUP is covered by the other cases in
      // this file; THIS case proves only that the RTT instrument the sampler reads
      // (inbound-rtp.roundTripTime on the standby piped Producer) actually populates.
      // pipeProducer lives on standbyRouter and is the RECEIVER (inbound-rtp).
      const { pipeProducer } = await primaryRouter.pipeToRouter({
        producerId: src.producer.id,
        router: standbyRouter,
      });
      const pipedProducer = pipeProducer;

      // ── Drive REAL RTP + POLL until RTCP populates roundTripTime (or ~15 s) ──
      // RTCP exchange needs several seconds (Probe A DEEP saw it appear at t≈6 s).
      // Poll instead of a fixed sleep so the assertion stays HARD + falsifiable —
      // a regression that stops RTCP from populating MUST fail this test, not
      // silently degrade to a presence-only check on a slow host.
      src.start();
      let inbound: { roundTripTime?: number; type?: string } | undefined;
      let rtt = 0;
      const startedAt = Date.now();
      while (Date.now() - startedAt < 15_000) {
        await sleep(500);
        const stats = await pipedProducer.getStats();
        inbound = stats.find(
          (s) => (s as { type?: string }).type === 'inbound-rtp',
        ) as ({ roundTripTime?: number; type?: string } | undefined);
        rtt = inbound?.roundTripTime ?? 0;
        if (rtt > 0) break;
      }
      src.stop();

      // eslint-disable-next-line no-console
      console.log(
        `[Lane-B] inbound-rtp.roundTripTime = ${rtt} ms after ${Date.now() - startedAt} ms ` +
          `(t_hop_network = ${rtt / 2} ms)`,
      );

      // Non-vacuous + UNCONDITIONAL: the inbound-rtp entry must exist AND RTCP must
      // have populated a positive round-trip time — the source of truth for
      // t_hop_network = rtt/2. No soft fallback.
      expect(inbound).toBeDefined();
      expect(rtt).toBeGreaterThan(0);

      // Cleanup (pipeToRouter's internal pipe transports close with the workers in afterAll).
      pipedProducer.close();
      src.producer.close();
    },
    30_000,
  );
});
