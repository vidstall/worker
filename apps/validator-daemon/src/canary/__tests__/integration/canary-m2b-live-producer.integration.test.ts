import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { attachValidatorSink } from '../../pipe-tap.js';
import { startNodeCanaryProducer } from '../../test-support/node-canary-producer.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];
let worker: msTypes.Worker;
beforeAll(async () => { worker = await mediasoup.createWorker({ logLevel: 'warn' }); }, 60_000);
afterAll(() => { worker?.close(); });

describe('REQ-MLL — node-canary-producer emits real RTP carrying the canonical canary', () => {
  it('a same-router DirectTransport sink captures the produced canary RTP', async () => {
    const router = await worker.createRouter({ mediaCodecs });
    const producer = await startNodeCanaryProducer({
      relayRouter: router, kRoom: new Uint8Array(32).fill(0x5c), roomId: 'p-room',
      cellSecret: new Uint8Array(32).fill(0xab), canaryKid: 7, ctrs: [0, 1, 2, 3],
    });
    const sink = await attachValidatorSink(router, producer.producerId);
    const got: Buffer[] = [];
    sink.consumer.on('rtp', (p: Buffer) => got.push(Buffer.from(p)));
    await sink.consumer.requestKeyFrame();
    producer.start(); await sleep(400); producer.stop();
    expect(got.length).toBeGreaterThan(0);
    try { sink.close(); producer.close(); router.close(); } catch { /* */ }
  }, 30_000);
});
