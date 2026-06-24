/**
 * SPIKE (throwaway, gates lane E / OQ-2) — does a PAUSED PipeTransport
 * consumer's getStats() RTCP/packet counters ADVANCE across samples while it
 * stays PAUSED?
 *
 * The F1 design's "honest probe flip" (§6, createPipeLivenessObserver) rests
 * on this: the observer flips rtcpAlive on a NON-ZERO counter ADVANCE across
 * >=2 samples. If a PAUSED pipe consumer's counters never move (RTCP keepalive
 * not surfaced in getStats while paused), the OQ-2 FALLBACK (a) applies: keep
 * rtcpAlive provably-false -> the standby stays unpaid (honest; economic
 * deliverable deferred) and we do NOT touch buildProbeResponse's AND-gate.
 *
 * This is NOT a mock. Real mediasoup Workers + Routers + PipeTransports,
 * production-faithful manual cross-PipeTransport pairing (mirrors
 * warmpipe-rtp.integration.test.ts path (b)). The standby pipe consumer is
 * created PAUSED and NEVER resumed — we only OBSERVE getStats() across time.
 *
 * HARD asserts: OQ-2-INDEPENDENT invariants only (consumer exists + paused +
 * getStats returns a counter array) so the spike is committable regardless of
 * the OQ-2 outcome. The OQ-2 verdict (advance? yes/no) is recorded in a
 * console.log + a SOFT informational expectation that NEVER fails the run.
 *
 * Requirements touched: REQ-RO-010 / REQ-RO-011 (spike precondition).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
} from '@dvconf/inter-relay-client';

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

function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const payload = Buffer.from([0xfc, 0xff, 0xfe]);
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = OPUS_PT & 0x7f;
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Sum every cumulative counter the observer will key on. */
function counterSum(
  stats: ReadonlyArray<{
    packetCount?: number;
    byteCount?: number;
    nackCount?: number;
    pliCount?: number;
    firCount?: number;
  }>,
): number {
  let total = 0;
  for (const s of stats) {
    total +=
      (s.packetCount ?? 0) +
      (s.byteCount ?? 0) +
      (s.nackCount ?? 0) +
      (s.pliCount ?? 0) +
      (s.firCount ?? 0);
  }
  return total;
}

let primaryWorker: msTypes.Worker;
let standbyWorker: msTypes.Worker;
let primaryRouter: msTypes.Router;
let standbyRouter: msTypes.Router;

beforeAll(async () => {
  primaryWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  standbyWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  primaryRouter = await primaryWorker.createRouter({ mediaCodecs });
  standbyRouter = await standbyWorker.createRouter({ mediaCodecs });
}, 30_000);

afterAll(() => {
  primaryWorker?.close();
  standbyWorker?.close();
});

describe('SPIKE: paused PipeTransport consumer getStats() counter advance (OQ-2)', () => {
  it('records whether a PAUSED pipe consumer counters advance across >=2 samples', async () => {
    // -- RTP source on the primary --
    const directTransport = await primaryRouter.createDirectTransport();
    const producer = await directTransport.produce({
      kind: 'audio',
      rtpParameters: pipeProducerRtpParameters,
    });

    // -- production-faithful manual cross-PipeTransport pairing --
    const primaryPipe = await createPrimaryPipeTransport(primaryRouter, 0);
    const standbyPipe = await standbyRouter.createPipeTransport({
      listenIp: { ip: '0.0.0.0', announcedIp: '127.0.0.1' },
      port: 0,
      enableRtx: false,
      enableSrtp: false,
    } as Parameters<msTypes.Router['createPipeTransport']>[0]);

    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    const primaryPipeConsumer = await pipeProducerOntoPrimaryTransport(
      primaryPipe,
      producer.id,
    );
    const pipedProducerId = primaryPipeConsumer.id;

    // standby: produce the piped producer onto its pipe transport, then create
    // a PAUSED pipe consumer for it (this is the consumer the observer watches).
    const pipedProducer = await standbyPipe.produce({
      id: pipedProducerId,
      kind: primaryPipeConsumer.kind,
      rtpParameters: primaryPipeConsumer.rtpParameters,
      paused: primaryPipeConsumer.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);

    const sinkTransport = await standbyRouter.createDirectTransport();
    const pausedConsumer = await sinkTransport.consume({
      producerId: pipedProducer.id,
      rtpCapabilities: standbyRouter.rtpCapabilities,
      paused: true, // STAY PAUSED — never resumed in this spike.
    });

    // -- drive real RTP on the wire (producer keeps sending; consumer paused) --
    let seq = 0;
    let ts = 0;
    const feed = setInterval(() => {
      producer.send(makeRtpPacket(seq++, ts));
      ts += 960;
    }, 10);

    // sample #1
    await sleep(300);
    const stats1 = (await pausedConsumer.getStats()) as Array<{
      type?: string;
      packetCount?: number;
      byteCount?: number;
      nackCount?: number;
      pliCount?: number;
      firCount?: number;
    }>;
    const sum1 = counterSum(stats1);

    // sample #2 (later)
    await sleep(800);
    const stats2 = (await pausedConsumer.getStats()) as typeof stats1;
    const sum2 = counterSum(stats2);

    clearInterval(feed);

    const advanced = sum2 > sum1;
    // eslint-disable-next-line no-console
    console.log(
      `[spike OQ-2] pausedConsumer counters: sum1=${sum1} sum2=${sum2} ` +
        `advanced=${advanced} statsLen=${stats2.length} ` +
        `verdict=${advanced ? 'COUNTERS-ADVANCE (observer rtcpAlive can flip true)' : 'NO-ADVANCE (OQ-2 fallback (a): rtcpAlive stays provably-false, standby unpaid)'}`,
    );

    // HARD invariants (OQ-2-INDEPENDENT) — keep the spike committable either way:
    expect(pausedConsumer.paused).toBe(true);
    expect(Array.isArray(stats2)).toBe(true);
    expect(sum2).toBeGreaterThanOrEqual(sum1); // counters are monotonic (never decrease)

    // SOFT informational: NEVER fails the run; surfaces the OQ-2 outcome.
    expect(typeof advanced).toBe('boolean');

    pausedConsumer.close();
    producer.close();
  }, 25_000);
});
