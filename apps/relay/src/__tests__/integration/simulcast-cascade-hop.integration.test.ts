/**
 * REQ-RMS-011 — simulcast full-ladder composition across the cascade pipe hop.
 *
 * A 3-layer (L1T1×3 SSRC) VP8 producer is piped cross-router; the downstream
 * consumer must expose all 3 spatial layers, and setPreferredLayers must work on
 * a consumer whose producer arrived over the pipe. No control composes layers at
 * the hop — each downstream relay layer-selects locally (REQ-RMS-011). Net-new:
 * no live two-relay simulcast test existed (inter-relay.ts:28-31 deferred).
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/simulcast-cascade-hop.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { pipeRoomToSecondWorker } from '../../relay-role-manager.js';

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
// 3-layer simulcast: 3 SSRCs (matches the client buildSimulcastEncodings ladder l/m/h).
const SSRCS = [0x51000001, 0x51000002, 0x51000003];
const simulcastRtpParameters: msTypes.RtpParameters = {
  codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
  encodings: SSRCS.map((ssrc, i) => ({ ssrc, scalabilityMode: 'L1T1', rid: ['l', 'm', 'h'][i] })),
};

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

describe('REQ-RMS-011 — piped simulcast producer carries the full 3-layer ladder downstream', () => {
  it('downstream consumer exposes 3 spatial layers + setPreferredLayers works on a piped producer', async () => {
    const srcTransport = await routerA.createDirectTransport();
    const producer = await srcTransport.produce({ kind: 'video', rtpParameters: simulcastRtpParameters });
    expect(producer.consumableRtpParameters.encodings?.length).toBe(3); // source has 3 layers

    // Pipe cross-router (the cascade hop) — the pipe must carry all 3 layers.
    // Capture the pipeToRouter result so the far producer can witness the ladder survived
    // (have pipeRoomToSecondWorker RETURN it — Task 3 adjustable, same milestone).
    const piped = await pipeRoomToSecondWorker(routerA, routerB, producer.id);
    expect(piped.pipeProducer.rtpParameters.encodings?.length).toBe(3); // 3-layer ladder survived the hop

    const sinkTransport = await routerB.createDirectTransport();
    const consumer = await sinkTransport.consume({
      producerId: producer.id,
      rtpCapabilities: routerB.rtpCapabilities,
      paused: false,
    });

    // The downstream consumer can actually SELECT the top spatial layer — layer 2 is
    // reachable ONLY if all 3 carried over the pipe. Read preferredLayers BACK; do not
    // just assert setPreferredLayers resolves void (M1 team-review must-fix #2: a `>=1`
    // length check + a discarded resolve is a tautology under a "3-layer" headline).
    await consumer.setPreferredLayers({ spatialLayer: 2 });
    expect(consumer.preferredLayers?.spatialLayer).toBe(2);
    await consumer.setPreferredLayers({ spatialLayer: 0 });
    expect(consumer.preferredLayers?.spatialLayer).toBe(0);
    // HONESTY FALLBACK: if real mediasoup consolidates the ladder below 3 over the pipe,
    // STOP and downgrade the REQ-RMS-011 claim text (here + File Structure + Done Criteria)
    // to the OBSERVED floor — never keep a 3-layer headline over a weaker assertion.

    try { consumer.close(); producer.close(); srcTransport.close(); sinkTransport.close(); } catch { /* best-effort */ }
  }, 120_000);
});
