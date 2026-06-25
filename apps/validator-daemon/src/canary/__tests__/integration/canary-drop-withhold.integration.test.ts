/**
 * B-18 (REQ-MLW-B-18) — deterministic withholding/DROP induction in the demo-only evil-relay.
 * Mirrors the proven canary-m2b-live-evilrelay forward harness (producer -> real DirectTransport
 * evil-relay consume -> re-produce -> F1 pipe -> validator sink), but exercises the ADDITIVE
 * `dropEveryN` knob: with dropEveryN=2 strictly FEWER forwarded canary packets reach the sink
 * than the no-drop baseline (ground-truth withholding exists on the wire, NOT a harness flip).
 * The TAMPER (byzantine) path is unaffected — this run is byzantine:false.
 *
 * Run: pnpm exec vitest run --config vitest.canary.config.ts canary-drop-withhold
 */
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPrimaryPipeTransport, createStandbyPipeTransport } from '@dvconf/inter-relay-client';
import { attachValidatorSink } from '../../pipe-tap.js';
import { startNodeCanaryProducer } from '../../test-support/node-canary-producer.js';
import { startEvilRelayForward } from '../../test-support/evil-relay-forward.js';

const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'm2b-drop-withhold-room';
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];

let relayWorker: msTypes.Worker;
let validatorWorker: msTypes.Worker;
beforeAll(async () => {
  relayWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' });
}, 60_000);
afterAll(() => { relayWorker?.close(); validatorWorker?.close(); });

// Producer -> EVIL-RELAY (drop every Nth | passthrough) -> pipe -> validator sink -> captured count.
// Copied from canary-m2b-live-evilrelay.integration.test.ts::forwardViaEvilRelay, adapted to (a)
// accept `dropEveryN` and thread it into startEvilRelayForward, (b) return the sink frame count.
async function countCaptured(opts: { byzantine: boolean; dropEveryN?: number }): Promise<number> {
  const relayRouter = await relayWorker.createRouter({ mediaCodecs });
  const validatorRouter = await validatorWorker.createRouter({ mediaCodecs });

  const producer = await startNodeCanaryProducer({ relayRouter, kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID, ctrs: CTRS });

  const primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
  const standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
  await primaryPipe.connect({ ip: '127.0.0.1', port: standbyPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
  await standbyPipe.connect({ ip: '127.0.0.1', port: primaryPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);

  const evil = await startEvilRelayForward({
    relayRouter,
    sourceProducerId: producer.producerId,
    byzantine: opts.byzantine,
    pipeTransport: primaryPipe,
    dropEveryN: opts.dropEveryN,
  });
  const pipedProducer = await standbyPipe.produce({
    id: evil.pipedProducerId, kind: evil.kind,
    rtpParameters: evil.rtpParameters, paused: evil.producerPaused,
  } as Parameters<msTypes.PipeTransport['produce']>[0]);

  const sink = await attachValidatorSink(validatorRouter, pipedProducer.id);
  const captured: Buffer[] = [];
  sink.consumer.on('rtp', (p: Buffer) => captured.push(Buffer.from(p)));
  await sink.consumer.requestKeyFrame();

  producer.start();
  await sleep(1200);
  producer.stop();
  await sleep(50);
  try { sink.close(); evil.close(); producer.close(); relayRouter.close(); validatorRouter.close(); } catch { /* */ }
  return captured.length;
}

describe('B-18 deterministic withholding (REQ-MLW-B-18)', () => {
  const cleanup: Array<() => void> = [];
  afterAll(() => { for (const c of cleanup.reverse()) c(); });

  it('dropEveryN=2 withholds ~half the forwarded packets (vs no-drop baseline)', async () => {
    const baseline = await countCaptured({ byzantine: false /*, dropEveryN: undefined */ });
    const dropped = await countCaptured({ byzantine: false, dropEveryN: 2 });
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThan(baseline);   // strictly fewer frames reach the sink
  }, 180_000);
});
