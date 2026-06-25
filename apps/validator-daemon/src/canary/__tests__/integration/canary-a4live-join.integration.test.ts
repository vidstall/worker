/**
 * M2b-live-WAN Sub-lane B — Task 2 (A4-live), REQ-MLW-B-03. The LOAD-BEARING leg: the REAL
 * headless-Chromium canary now does a REAL signaling JOIN against the PRODUCTION relay signaling
 * server (`createSignalingServer`, covert no-password path) + a REAL WebRtcTransport/DTLS PRODUCE
 * onto a REAL relay router — instead of the Sub-lane A "A3b" mock-ingest WS that produced onto an
 * injected router. This absorbs the deferred A-11 leg: the canary now traverses the real forward
 * path (real signaling admission → real produce → evil-relay tap → real router→router F1 pipe →
 * validator sink capture).
 *
 * THE ROUTER-HANDLE BRIDGE (Task-0 finding): the test OWNS the relay router the browser produces
 * onto, so `startEvilRelayForward` + `createPrimaryPipeTransport` can tap it. `startRealSignaling`
 * injects a `MediasoupManager`-shaped object whose `getNextWorker()`/`createRouter(...)` hand back
 * THAT exact `relayRouter`, so the browser's real produce lands on the test-owned router (the prod
 * `mediasoup-manager.ts` does not expose created routers, hence the injected manager).
 *
 * NO cap-token / NO password (Task-0): the relay media-plane `createSignalingServer` has no
 * authHook; the admission gate engages ONLY when the join carries `roomPassword`. The canary page
 * sends a bare `{type:'join',roomId}` → the legacy/covert path admits it + mints the room router.
 *
 * EVERYTHING from the producer DOWN mirrors the GREEN `canary-m2b-capture-core` in-process sink
 * pattern (INV-A/B/C preserved): the byzantine tamper is the demo-only `startEvilRelayForward`
 * (reused, NOT edited; the prod relay binary stays content-blind), the REAL router→router F1
 * PipeTransport hop, and an UNPAUSED DirectTransport validator sink (`attachValidatorSink`).
 *
 * NO chain here — the on-chain slash is the Task-4 walkthrough. This task PROVES the canary is
 * forwarded off the REAL relay and CAPTURED (>0 packets) on BOTH the byzantine and honest paths.
 *
 * Run: cd dvconf-daemons && npx vitest run --config vitest.canary.config.ts canary-a4live-join
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  createPrimaryPipeTransport,
  createStandbyPipeTransport,
  pipeProducerOntoPrimaryTransport,
} from '@dvconf/inter-relay-client';
import { startBrowserCanaryProducer } from '../../test-support/browser-canary-producer.js';
import { startRealSignaling } from '../../test-support/real-signaling-harness.js';
import { startEvilRelayForward } from '../../test-support/evil-relay-forward.js';
import { attachValidatorSink } from '../../pipe-tap.js';

// INLINE (as the A3b/capture-core tests do — these are NOT exported consts).
const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'm2b-a4live-room';
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: 101 },
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('A4-live: real browser join → real relay forward → captured (REQ-MLW-B-03)', () => {
  const cleanup: Array<() => void | Promise<void>> = [];
  afterAll(async () => {
    for (const c of cleanup.reverse()) {
      try {
        await c();
      } catch {
        /* best-effort teardown */
      }
    }
  });

  async function run(byzantine: boolean): Promise<Buffer[]> {
    // DELTA vs capture-core: TWO workers (relay router + validator router on distinct workers) so
    // the validator re-produce of the piped id does not collide in a single worker.
    const relayWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    const validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' });
    cleanup.push(() => relayWorker.close());
    cleanup.push(() => validatorWorker.close());
    const relayRouter = await relayWorker.createRouter({ mediaCodecs });

    // REAL production signaling server (covert no-password path) over the test-owned relayRouter.
    const signaling = await startRealSignaling({ relayRouter, roomId: ROOM_ID });
    cleanup.push(() => signaling.stop());

    // REAL headless browser canary: real signaling JOIN + real WebRtcTransport/DTLS PRODUCE.
    const producer = await startBrowserCanaryProducer({
      signalingUrl: signaling.wsUrl, // A4-live live mode (no injected relayRouter)
      roomId: ROOM_ID,
      kRoom: K_ROOM,
      cellSecret: CELL_SECRET,
      canaryKid: CANARY_KID,
      ctrs: CTRS,
    });
    cleanup.push(() => producer.close());

    const validatorRouter = await validatorWorker.createRouter({ mediaCodecs });

    // REAL router→router F1 PipeTransport hop (extracted warm-pipe primitives).
    const primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
    const standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
    await primaryPipe.connect({
      ip: '127.0.0.1',
      port: standbyPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);
    await standbyPipe.connect({
      ip: '127.0.0.1',
      port: primaryPipe.tuple.localPort,
    } as Parameters<msTypes.PipeTransport['connect']>[0]);

    // Demo-only byzantine evil-relay taps the browser's real producer on relayRouter, (maybe)
    // corrupts one ciphertext byte, re-produces, and pipes onto the primary pipe (INV-B: prod
    // relay path is untouched; the tamper is this reused test-support module).
    const evil = await startEvilRelayForward({
      relayRouter,
      sourceProducerId: producer.producerId,
      byzantine,
      pipeTransport: primaryPipe,
    });
    cleanup.push(() => evil.close());

    const piped = await standbyPipe.produce({
      id: evil.pipedProducerId,
      kind: evil.kind,
      rtpParameters: evil.rtpParameters,
      paused: evil.producerPaused,
    } as Parameters<msTypes.PipeTransport['produce']>[0]);

    // UNPAUSED DirectTransport validator sink — the only consumer kind that emits 'rtp'.
    const sink = await attachValidatorSink(validatorRouter, piped.id);
    cleanup.push(() => sink.close());
    const captured: Buffer[] = [];
    sink.consumer.on('rtp', (pkt: Buffer) => captured.push(Buffer.from(pkt)));
    await sink.consumer.requestKeyFrame();

    producer.start();
    await sleep(4500);
    producer.stop();
    return captured;
  }

  it('byzantine tamper → captured bytes present off the real relay forward', async () => {
    const captured = await run(true);
    expect(captured.length).toBeGreaterThan(0);
  }, 180_000);

  it('honest forward → captured bytes present (no false positive)', async () => {
    const captured = await run(false);
    expect(captured.length).toBeGreaterThan(0);
  }, 180_000);
});
