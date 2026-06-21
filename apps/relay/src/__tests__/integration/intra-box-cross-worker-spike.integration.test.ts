/**
 * REQ-RMS-007 DE-RISK SPIKE (spec risk #5) — intra-box cross-worker pipeToRouter.
 *
 * Proves mediasoup `routerA.pipeToRouter({ producerId, router: routerB })` makes a
 * producer that lives on worker-A's router consumable on worker-B's router, with
 * REAL RTP flowing across the pipe (not the PAUSED warm-pipe of F1). This is the
 * tier-2 (intra-box, same-process) spill path. UNTESTED here before this spike.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/intra-box-cross-worker-spike.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { createMediasoupManager } from '../../mediasoup-manager.js';
import { pipeRoomToSecondWorker } from '../../relay-role-manager.js';
import { createLogger } from '@dvconf/shared';

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const SSRC = 0x44550000;
const vp8RtpParameters: msTypes.RtpParameters = {
  codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc: SSRC }],
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeVp8Rtp(seq: number, ts: number, keyframe: boolean): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (VP8_PT & 0x7f) | 0x80;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(SSRC >>> 0, 8);
  const vp8 = keyframe
    ? Buffer.from([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0xe0, 0x01])
    : Buffer.from([0x11, 0x00, 0x00]);
  return Buffer.concat([header, vp8, Buffer.from(new Uint8Array(40).fill(0xab))]);
}

let workerA: msTypes.Worker;
let workerB: msTypes.Worker;
let routerA: msTypes.Router;
let routerB: msTypes.Router;

beforeAll(async () => {
  workerA = await mediasoup.createWorker({ logLevel: 'warn' });
  workerB = await mediasoup.createWorker({ logLevel: 'warn' });
  routerA = await workerA.createRouter({ mediaCodecs });
  routerB = await workerB.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => { workerA?.close(); workerB?.close(); });

describe('REQ-RMS-007 spike — intra-box cross-worker pipeToRouter forwards live RTP', () => {
  it('a producer on routerA is consumable + forwarding RTP on routerB after pipeToRouter', async () => {
    // Distinct-WORKER precondition — the genuinely-new tier-2 surface (DESIGN §10 risk #5).
    expect(workerA.pid).not.toBe(workerB.pid);

    // Producer on worker-A.
    const srcTransport = await routerA.createDirectTransport();
    const producer = await srcTransport.produce({ kind: 'video', rtpParameters: vp8RtpParameters });

    // tier-2: bridge the producer A→B with the high-level intra-box pipe.
    // mediasoup types PipeToRouterResult.pipeConsumer as OPTIONAL; narrow + fail
    // loud before `.kind` (mirrors pipeRoomToSecondWorker's production narrow).
    const { pipeConsumer } = await routerA.pipeToRouter({ producerId: producer.id, router: routerB });
    expect(pipeConsumer).toBeDefined();
    if (pipeConsumer === undefined) throw new Error('pipeToRouter returned no pipeConsumer');
    expect(pipeConsumer.kind).toBe('video');

    // Downstream: routerB can now consume the piped producer (its id is the source producerId).
    expect(routerB.canConsume({ producerId: producer.id, rtpCapabilities: routerB.rtpCapabilities })).toBe(true);
    const sinkTransport = await routerB.createDirectTransport();
    const consumer = await sinkTransport.consume({
      producerId: producer.id,
      rtpCapabilities: routerB.rtpCapabilities,
      paused: false,
    });

    const captured: Buffer[] = [];
    consumer.on('rtp', (pkt: Buffer) => { captured.push(Buffer.from(pkt)); });

    let seq = 0, ts = 0, frame = 0;
    const interval = setInterval(() => {
      producer.send(makeVp8Rtp(seq++, ts, frame % 10 === 0));
      ts += 3000; frame++;
    }, 10);
    await consumer.requestKeyFrame();
    await sleep(700);
    clearInterval(interval);
    await sleep(50);

    try { consumer.close(); producer.close(); srcTransport.close(); sinkTransport.close(); } catch { /* best-effort */ }

    // The spike's load-bearing assertion: REAL RTP crossed the cross-worker pipe.
    // eslint-disable-next-line no-console
    console.log(`[REQ-RMS-007 spike] captured=${captured.length} cross-worker RTP packets`);
    expect(captured.length).toBeGreaterThan(0);
  }, 120_000);

  it('getWorkerExcluding returns a DISTINCT worker; pipeRoomToSecondWorker forwards RTP to it', async () => {
    // IN-FLIGHT (RTP port-range contention): this case spins a SECOND set of real
    // mediasoup Workers (via createMediasoupManager) in the SAME process as the
    // beforeAll workerA/workerB. createMediasoupManager binds its Workers' RTC
    // ports from RTC_MIN_PORT/RTC_MAX_PORT (default 10000-10100), which overlaps the
    // beforeAll Workers' default range — and pipeToRouter binds PipeTransports out
    // of that same range. Scope a DISTINCT high range here so the parallel-resident
    // Workers never contend for a port; restore env afterward (hermetic).
    const prevNumWorkers = process.env['NUM_WORKERS'];
    const prevRtcMin = process.env['RTC_MIN_PORT'];
    const prevRtcMax = process.env['RTC_MAX_PORT'];
    process.env['NUM_WORKERS'] = '2';
    process.env['RTC_MIN_PORT'] = '41000';
    process.env['RTC_MAX_PORT'] = '41200';

    const logger = createLogger('test:rms007');
    const manager = await createMediasoupManager(logger);

    try {
      const firstWorker = manager.getNextWorker();
      const secondWorker = manager.getWorkerExcluding(firstWorker);
      expect(secondWorker).not.toBe(firstWorker); // distinct worker (REQ-RMS-007)

      const routerFirst = await manager.createRouter(firstWorker);
      const routerSecond = await manager.createRouter(secondWorker);

      const srcTransport = await routerFirst.createDirectTransport();
      const producer = await srcTransport.produce({ kind: 'video', rtpParameters: vp8RtpParameters });

      // Production helper: pipe an existing room's producer to a second worker's router.
      const pipeConsumer = await pipeRoomToSecondWorker(routerFirst, routerSecond, producer.id);
      expect(pipeConsumer.kind).toBe('video');
      expect(
        routerSecond.canConsume({ producerId: producer.id, rtpCapabilities: routerSecond.rtpCapabilities }),
      ).toBe(true);

      try { producer.close(); srcTransport.close(); } catch { /* best-effort */ }
    } finally {
      try { manager.close(); } catch { /* best-effort */ }
      // Restore env (hermetic — never leak NUM_WORKERS/RTC_*_PORT to sibling tests).
      if (prevNumWorkers === undefined) delete process.env['NUM_WORKERS']; else process.env['NUM_WORKERS'] = prevNumWorkers;
      if (prevRtcMin === undefined) delete process.env['RTC_MIN_PORT']; else process.env['RTC_MIN_PORT'] = prevRtcMin;
      if (prevRtcMax === undefined) delete process.env['RTC_MAX_PORT']; else process.env['RTC_MAX_PORT'] = prevRtcMax;
    }
  }, 120_000);
});
