/**
 * M2b capture-core — REQ-MCC-01..10. HERMETIC, single-process.
 *
 * NET-NEW canary producer (DirectTransport on the relay router) -> REAL router->router
 * PipeTransport hop (the EXTRACTED @dvconf/inter-relay-client F1 warm-pipe primitives) ->
 * validator re-produce -> 2 UNPAUSED DirectTransport SINK consumers (attachValidatorSink) ->
 * hardened PipeTapCollector -> createPipeTapCapture -> UNCHANGED runCanaryVerifyRound.
 *
 * Honesty (on record): the byzantine tamper is applied HARNESS-SIDE to the captured forwarded
 * Buffer (INV-B / ADR-0022: the relay forward path is untouched). The media is REALLY forwarded
 * by real mediasoup over a REAL PipeTransport and REALLY captured via consumer.on('rtp'). The
 * live covert-join transport (WebRtcTransport) + cross-process wiring + WAN are M2b-live / slice-1b.
 *
 * Run: pnpm exec vitest run --config vitest.canary.config.ts canary-m2b-capture-core
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  createPrimaryPipeTransport,
  pipeProducerOntoPrimaryTransport,
  createStandbyPipeTransport,
} from '@dvconf/inter-relay-client';
import { recomputeCanaryFrame, deriveCanarySeed, type VerifyInput } from '../../verifier.js';
import { runCanaryVerifyRound, type CanaryVerifyDeps } from '../../verify-loop.js';
import { type CanaryValidator, type RelayRoomScope } from '../../cell.js';
import { type DivergenceProof, distinctAttesterCount } from '../../proof.js';
import { InMemoryClaimBoard } from '../../claim-board.js';
import { PipeTapCollector, createPipeTapCapture } from '../../pipe-tap-capture.js';
import { attachValidatorSink } from '../../pipe-tap.js';
import { makeVp8RtpWithBody, makeRtcpSenderReport, VP8_PT } from '../../test-support/vp8-rtp.js';

// DELTA #3: inline the byte-frozen M3 partial-SFrame trailer length (=14) rather than import it
// cross-repo. It IS exported from dvconf-client/src/lib/webrtc/sframe-transform.ts, but a cross-repo
// import under vitest-in-daemons is fragile; slice-1 imported it, capture-core inlines it to stay
// hermetic within dvconf-daemons (mirrors dvconf-client/src/lib/webrtc/sframe-transform.ts).
const SFRAME_TRAILER_LEN = 14; // byte-frozen M3 partial-SFrame trailer (mirrors dvconf-client/src/lib/webrtc/sframe-transform.ts)

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'm2b-capture-room';
const CANARY_KID = 7;
const RELAY_R = 'relay-under-audit-R';
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];
const SELF: CanaryValidator = { minerId: 'val-self', sessionWallet: 's-self' };
const PEER: CanaryValidator = { minerId: 'val-peer', sessionWallet: 's-peer' };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const rtpParameters: msTypes.RtpParameters = {
  codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc: 0x4000_0000, scalabilityMode: 'L1T1' }],
};

// DELTA #2: TWO mediasoup workers. A single worker collides the produce-id when the validator
// re-produces the piped producer (same producerId on two routers in the same worker). relayRouter
// lives on relayWorker, validatorRouter on validatorWorker; the router->router PipeTransport
// connects over 127.0.0.1 localPorts (real cross-worker UDP).
let relayWorker: msTypes.Worker;
let validatorWorker: msTypes.Worker;
beforeAll(async () => {
  relayWorker = await mediasoup.createWorker({ logLevel: 'warn' });
  validatorWorker = await mediasoup.createWorker({ logLevel: 'warn' });
}, 60_000);
afterAll(() => {
  relayWorker?.close();
  validatorWorker?.close();
});

/** Build the canonical canary SFrame stream for ctr 0..N-1 from cellSecret only. */
async function buildCanaryStream(): Promise<Uint8Array[]> {
  const seed = deriveCanarySeed(CELL_SECRET);
  const base: Omit<VerifyInput, 'expectedCtrs'> = {
    kRoom: K_ROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID,
  };
  const bodies: Uint8Array[] = [];
  for (const ctr of CTRS) bodies.push(await recomputeCanaryFrame(base, seed, ctr));
  return bodies;
}

/**
 * Forward the canary stream over a REAL router->router PipeTransport, re-produce on the
 * validator router, and tap TWO UNPAUSED DirectTransport sinks. Returns the captured Buffers.
 * `byzantine` flips the byte just before the 14-byte trailer on EVERY captured packet of BOTH
 * sinks (harness-side; relay path untouched — INV-B) -> a TAMPER (p=1) the verifier detects.
 */
async function forwardOverPipe(byzantine: boolean): Promise<{ capturedA: Buffer[]; capturedB: Buffer[] }> {
  const relayRouter = await relayWorker.createRouter({ mediaCodecs });
  const validatorRouter = await validatorWorker.createRouter({ mediaCodecs });
  const bodies = await buildCanaryStream();

  // NET-NEW producer on the relay router (the byte-source; canary bodies at the TAIL).
  const src = await relayRouter.createDirectTransport();
  const producer = await src.produce({ kind: 'video', rtpParameters });

  // REAL router->router PipeTransport hop (extracted F1 warm-pipe primitives).
  const primaryPipe = await createPrimaryPipeTransport(relayRouter, 0);
  const standbyPipe = await createStandbyPipeTransport(validatorRouter, 0);
  await primaryPipe.connect({ ip: '127.0.0.1', port: standbyPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
  await standbyPipe.connect({ ip: '127.0.0.1', port: primaryPipe.tuple.localPort } as Parameters<msTypes.PipeTransport['connect']>[0]);
  const pipedConsumer = await pipeProducerOntoPrimaryTransport(primaryPipe, producer.id);
  const pipedProducer = await standbyPipe.produce({
    id: pipedConsumer.id, kind: pipedConsumer.kind,
    rtpParameters: pipedConsumer.rtpParameters, paused: pipedConsumer.producerPaused,
  } as Parameters<msTypes.PipeTransport['produce']>[0]);

  // TWO UNPAUSED DirectTransport sinks off the ONE piped producer = 2 receiverMinerId buckets.
  const sinkA = await attachValidatorSink(validatorRouter, pipedProducer.id);
  const sinkB = await attachValidatorSink(validatorRouter, pipedProducer.id);
  const capturedA: Buffer[] = [];
  const capturedB: Buffer[] = [];
  const tamper = (copy: Buffer): Buffer => {
    if (byzantine) {
      const ti = copy.length - SFRAME_TRAILER_LEN - 1;
      if (ti >= 0) copy[ti] = (copy[ti]! ^ 0xff) & 0xff;
    }
    return copy;
  };
  sinkA.consumer.on('rtp', (p: Buffer) => { capturedA.push(tamper(Buffer.from(p))); });
  sinkB.consumer.on('rtp', (p: Buffer) => { capturedB.push(tamper(Buffer.from(p))); });
  await sinkA.consumer.requestKeyFrame();
  await sinkB.consumer.requestKeyFrame();

  // Drive real RTP, THEN stop, THEN return (sequencing sidesteps the microtask race).
  let seq = 0, pic = 0, ts = 0, frame = 0, pkt = 0, oct = 0;
  const interval = setInterval(() => {
    const body = bodies[frame % bodies.length]!;
    const packet = makeVp8RtpWithBody({ ssrc: 0x4000_0000, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe: frame % 10 === 0 });
    producer.send(packet);
    pkt++; oct += packet.length;
    if (frame % 10 === 0) src.sendRtcp(makeRtcpSenderReport(0x4000_0000, ts, pkt, oct));
    ts += 3000; frame++;
  }, 10);
  await sleep(1200);
  clearInterval(interval);
  await sleep(50);
  try { sinkA.close(); sinkB.close(); producer.close(); src.close(); relayRouter.close(); validatorRouter.close(); } catch { /* best-effort */ }
  return { capturedA, capturedB };
}

function makeDeps(capturedA: Buffer[], capturedB: Buffer[], board: InMemoryClaimBoard, submitted: DivergenceProof[], self: Ed25519Keypair): CanaryVerifyDeps {
  // Long-lived collector seeded by replaying the already-captured real forwarded bytes
  // (the real pipe forward already happened in forwardOverPipe). Synchronous replay after
  // listener attach = deterministic snapshot, no race vs runCanaryVerifyRound's first await.
  const emA = new EventEmitter();
  const emB = new EventEmitter();
  const collector = new PipeTapCollector([
    { receiverMinerId: SELF.minerId, consumer: emA },
    { receiverMinerId: PEER.minerId, consumer: emB },
  ]);
  for (const p of capturedA) emA.emit('rtp', p);
  for (const p of capturedB) emB.emit('rtp', p);
  return {
    getRelayRoomScopes: (): RelayRoomScope[] => [{ relayId: RELAY_R, roomId: ROOM_ID }],
    getValidators: () => [SELF, PEER],
    getStunLossBps: () => 0n,
    capture: createPipeTapCapture(collector, { canaryKid: CANARY_KID, expectedCtrs: CTRS, kRoom: K_ROOM, cellSecret: CELL_SECRET }),
    localBoard: board,
    selfSessionKeypair: self,
    submit: async (proof) => { submitted.push(proof); },
    config: { k: 2, deltaBps: 0n, sendRate: CTRS.length },
  };
}

async function runQuorum(capturedA: Buffer[], capturedB: Buffer[]): Promise<DivergenceProof[]> {
  const board = new InMemoryClaimBoard({ wCorr: 100 });
  const submitted: DivergenceProof[] = [];
  const a = makeDeps(capturedA, capturedB, board, submitted, new Ed25519Keypair());
  const b = makeDeps(capturedA, capturedB, board, submitted, new Ed25519Keypair());
  let accA: unknown = undefined; let accB: unknown = undefined;
  for (let r = 0; r < 7; r++) {
    const ra = await runCanaryVerifyRound(a, accA as never, r); accA = ra.accumulator;
    const rb = await runCanaryVerifyRound(b, accB as never, r); accB = rb.accumulator;
  }
  return submitted;
}

describe('REQ-MCC-01/02/03 — honest forward over a REAL PipeTransport: real media flows, 0 divergence', () => {
  it('captures real piped RTP and submits NO slash on the honest path (INV-A)', async () => {
    const { capturedA, capturedB } = await forwardOverPipe(false);
    expect(capturedA.length).toBeGreaterThan(0); // REQ-MCC-01: real RTP crossed the pipe hop (sink A)
    expect(capturedB.length).toBeGreaterThan(0); // sink B
    const submitted = await runQuorum(capturedA, capturedB);
    expect(submitted.length).toBe(0); // REQ-MCC-03: no false positive
  }, 40_000);
});

describe('REQ-MCC-04/05/06/10 — byzantine forward: detected -> real >=2-distinct proof', () => {
  it('a harness-side tamper on the FORWARDED bytes is detected by both validators -> a 2-distinct proof', async () => {
    const { capturedA, capturedB } = await forwardOverPipe(true);
    expect(capturedA.length).toBeGreaterThan(0);
    const submitted = await runQuorum(capturedA, capturedB);
    expect(submitted.length).toBeGreaterThan(0);          // REQ-MCC-04: TAMPER detected from captured bytes
    const proof = submitted[0]!;
    // Attestations are {sessionPublicKey, signature} (Wallet-B only; NO minerId on the attestation —
    // distinctness is by sessionPublicKey, deduped via the exported distinctAttesterCount).
    expect(distinctAttesterCount(proof.attestations)).toBeGreaterThanOrEqual(2); // REQ-MCC-05/06: >=2 distinct
  }, 40_000);

  it('REQ-MCC-10 non-vacuity — honest stays GREEN while byzantine goes RED (same harness)', async () => {
    const honest = await forwardOverPipe(false);
    const tampered = await forwardOverPipe(true);
    expect((await runQuorum(honest.capturedA, honest.capturedB)).length).toBe(0);
    expect((await runQuorum(tampered.capturedA, tampered.capturedB)).length).toBeGreaterThan(0);
  }, 60_000);
});
