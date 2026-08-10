/**
 * REAL-mediasoup warm-pipe RTP de-risk SPIKE (Phase 5.3, step 3a).
 *
 * (a) BASELINE -- router.pipeToRouter({producerId, router}). The mediasoup
 *     high-level helper, which only works for two routers in the SAME
 *     process. Confirms the opus codec + RTP path works AT ALL. This is the
 *     in-process shortcut, NOT what production uses.
 *
 * RTP source: a DirectTransport producer on the primary, fed synthetic Opus
 * RTP via producer.send(buf). Fully in-process -- no ffmpeg, no browser, no
 * UDP. RTP sink: a DirectTransport consumer on the standby whose 'rtp' event +
 * getStats() packetCount prove receipt.
 *
 * Requirements touched: REQ-RO-004, REQ-RO-005 (warm-pipe + paused standby).
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

/**
 * Attach a downstream RTP sink on the STANDBY router via a DirectTransport
 * consumer. DirectTransport consumers emit an 'rtp' event per received packet
 * (a plain WebRTC/Plain consumer does not), which is how we OBSERVE that real
 * RTP made it across the pipe. Created paused; the caller resumes to cut over.
 */
async function makeStandbySink(
  pipedProducerId: string,
): Promise<{
  consumer: msTypes.Consumer;
  rtpCount: () => number;
  firstRtpAt: () => number | null;
}> {
  const directTransport = await standbyRouter.createDirectTransport();
  const consumer = await directTransport.consume({
    producerId: pipedProducerId,
    rtpCapabilities: standbyRouter.rtpCapabilities,
    paused: true,
  });
  let count = 0;
  let firstAt: number | null = null;
  consumer.on('rtp', () => {
    count++;
    if (firstAt === null) firstAt = Date.now();
  });
  return {
    consumer,
    rtpCount: () => count,
    firstRtpAt: () => firstAt,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ----------------------------------------------------------------------
// (a) BASELINE -- pipeToRouter (in-process shortcut). Proves codec/RTP path.
// ----------------------------------------------------------------------

describe('warm-pipe RTP -- baseline (router.pipeToRouter, same-process)', () => {
  it('flows real Opus RTP primary->standby via pipeToRouter after resume', async () => {
    const src = await makePrimaryRtpSource();

    // High-level helper: builds + connects both PipeTransports automatically
    // and mints a piped producer on the standby with the SAME id.
    await primaryRouter.pipeToRouter({
      producerId: src.producer.id,
      router: standbyRouter,
    });

    const sink = await makeStandbySink(src.producer.id);
    src.start();

    // Paused consumer: nothing should arrive yet.
    await sleep(250);
    expect(sink.rtpCount()).toBe(0);

    // CUTOVER.
    await sink.consumer.resume();
    await sleep(400);
    src.stop();

    expect(sink.rtpCount()).toBeGreaterThan(0);
    const stats = await sink.consumer.getStats();
    const inbound = stats.find((s) => s.type === 'inbound-rtp') as
      | { packetCount?: number; byteCount?: number }
      | undefined;
    expect(inbound?.packetCount ?? 0).toBeGreaterThan(0);

    sink.consumer.close();
    src.producer.close();
  }, 20_000);
});
