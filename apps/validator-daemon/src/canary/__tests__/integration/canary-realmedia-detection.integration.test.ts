/**
 * M2 slice-1 — REQ-RMD-01..10. HERMETIC real-media canary DETECTION.
 *
 * A REAL mediasoup Router forwards real canary RTP; TWO validator consumers capture
 * the forwarded packets (consumer.on('rtp')). The UNCHANGED runCanaryVerifyRound
 * pipeline recomputes the canonical canary ciphertext from cellSecret + byte-compares
 * (NO decrypt). A byzantine relay (HARNESS-SIDE byte-flip — INV-B: the production relay
 * forward path is untouched, identical honesty to canary-forward.integration.test.ts)
 * is DETECTED by both validators -> a real >=2-distinct Wallet-B proof -> slash.
 *
 * Honesty (on record): the tamper is applied harness-side to the captured forwarded
 * Buffer (modelling a relay that mutated bytes in transit). The media is REALLY
 * forwarded by real mediasoup and REALLY captured via consumer.on('rtp'). The live
 * covert-join transport (WebRtcTransport) + WAN are M2b.
 *
 * Run: pnpm exec vitest run --config vitest.canary.config.ts \
 *   apps/validator-daemon/src/canary/__tests__/integration/canary-realmedia-detection.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

import {
  recomputeCanaryFrame,
  deriveCanarySeed,
  CANARY_FRAME_LEN,
  type VerifyInput,
} from '../../verifier.js';
import { SFRAME_TRAILER_LEN } from '../../../../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';
import { runCanaryVerifyRound, type CanaryVerifyDeps } from '../../verify-loop.js';
import { type CanaryValidator, type RelayRoomScope } from '../../cell.js';
import { type DivergenceProof } from '../../proof.js';
import { InMemoryClaimBoard } from '../../claim-board.js';
import { PipeTapCollector, createPipeTapCapture } from '../../pipe-tap-capture.js';

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── fixed per-cell canary inputs (NOT roster keying) ───────────────────────────
const K_ROOM = new Uint8Array(32).fill(0x5c);
const CELL_SECRET = new Uint8Array(32).fill(0xab);
const ROOM_ID = 'rmd-realmedia-room';
const CANARY_KID = 7;
const RELAY_R = 'relay-under-audit-R';
const CTRS = [0, 1, 2, 3, 4, 5, 6, 7];

const SELF: CanaryValidator = { minerId: 'val-self', sessionWallet: 's-self' };
const PEER: CanaryValidator = { minerId: 'val-peer', sessionWallet: 's-peer' };

// ── VERBATIM helpers from apps/relay/src/__tests__/integration/canary-forward.integration.test.ts ──
/** Minimal RTCP Sender Report (PT=200) so each SSRC has a non-zero GetSenderReportNtpMs(). */
function makeRtcpSenderReport(
  ssrc: number,
  rtpTimestamp: number,
  packetCount: number,
  octetCount: number,
): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80;
  buf[1] = 200;
  buf.writeUInt16BE(6, 2);
  buf.writeUInt32BE(ssrc >>> 0, 4);
  const nowMs = Date.now();
  const ntpSec = Math.floor(nowMs / 1000) + 2208988800;
  const ntpFrac = Math.floor(((nowMs % 1000) / 1000) * 0x1_0000_0000);
  buf.writeUInt32BE(ntpSec >>> 0, 8);
  buf.writeUInt32BE(ntpFrac >>> 0, 12);
  buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
  buf.writeUInt32BE(packetCount >>> 0, 20);
  buf.writeUInt32BE(octetCount >>> 0, 24);
  return buf;
}

/** Build a VP8 RTP packet carrying an opaque BODY (the canary SFrame) after a real-VP8 header. */
function makeVp8RtpWithBody(args: {
  ssrc: number;
  seq: number;
  ts: number;
  pictureId: number;
  body: Uint8Array;
  keyframe: boolean;
}): Buffer {
  const { ssrc, seq, ts, pictureId, body, keyframe } = args;
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = (VP8_PT & 0x7f) | 0x80;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  const desc = Buffer.from([
    0x90,
    0x80,
    0x80 | ((pictureId >> 8) & 0x7f),
    pictureId & 0xff,
  ]);
  let vp8PayloadHeader: Buffer;
  if (keyframe) {
    vp8PayloadHeader = Buffer.from([
      0x10, 0x00, 0x00,
      0x9d, 0x01, 0x2a,
      0x80, 0x02,
      0xe0, 0x01,
    ]);
  } else {
    vp8PayloadHeader = Buffer.from([0x11, 0x00, 0x00]);
  }
  return Buffer.concat([header, desc, vp8PayloadHeader, Buffer.from(body)]);
}

let worker: msTypes.Worker;
let router: msTypes.Router;

beforeAll(async () => {
  worker = await mediasoup.createWorker({ logLevel: 'warn' });
  router = await worker.createRouter({ mediaCodecs });
}, 60_000);

afterAll(() => {
  worker?.close();
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
 * Forward the canary bodies through a REAL mediasoup Router to TWO DirectTransport
 * consumers and capture each consumer's forwarded RTP. `byzantine` flips the byte just
 * before the 14-byte trailer on EVERY captured packet (harness-side; production relay
 * path untouched, INV-B) — a TAMPER the verifier detects by byte-mismatch while the
 * trailer (kid|ctr) survives for frame location. Mirrors canary-forward FORCE_TAMPER.
 */
async function forwardToTwoConsumers(
  byzantine: boolean,
): Promise<{ capturedA: Buffer[]; capturedB: Buffer[] }> {
  const bodies = await buildCanaryStream();
  const ssrc = 0x4000_0000;
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [
      { mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] },
    ],
    encodings: [{ ssrc, scalabilityMode: 'L1T1' }],
  };
  const srcTransport = await router.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'video', rtpParameters });

  const mkSink = async (): Promise<{ consumer: msTypes.Consumer; transport: msTypes.DirectTransport; captured: Buffer[] }> => {
    const t = await router.createDirectTransport();
    const consumer = await t.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: false,
    });
    const captured: Buffer[] = [];
    consumer.on('rtp', (pkt: Buffer) => {
      const copy = Buffer.from(pkt);
      if (byzantine) {
        const ti = copy.length - SFRAME_TRAILER_LEN - 1;
        if (ti >= 0) copy[ti] = (copy[ti]! ^ 0xff) & 0xff;
      }
      captured.push(copy);
      if (captured.length > 1024) captured.shift();
    });
    return { consumer, transport: t, captured };
  };
  const a = await mkSink();
  const b = await mkSink();

  let seq = 0, pic = 0, ts = 0, frame = 0, pktCount = 0, octetCount = 0;
  const interval = setInterval(() => {
    const body = bodies[frame % bodies.length]!;
    const packet = makeVp8RtpWithBody({
      ssrc, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe: frame % 10 === 0,
    });
    producer.send(packet);
    pktCount += 1; octetCount += packet.length;
    if (frame % 10 === 0) srcTransport.sendRtcp(makeRtcpSenderReport(ssrc, ts, pktCount, octetCount));
    ts += 3000; frame++;
  }, 10);
  // Request a keyframe on BOTH sinks so each consumer's forward window opens promptly
  // (shrinks the honest-case tail risk of one receiver missing a ctr in the 900ms window).
  await a.consumer.requestKeyFrame();
  await b.consumer.requestKeyFrame();
  await sleep(900);
  clearInterval(interval);
  await sleep(50);
  try {
    a.consumer.close(); b.consumer.close();
    a.transport.close(); b.transport.close(); // close the sink DirectTransports (template parity)
    producer.close(); srcTransport.close();
  } catch {
    /* best-effort */
  }
  return { capturedA: a.captured, capturedB: b.captured };
}

/**
 * Seed a PipeTapCollector SYNCHRONOUSLY from already-captured real forwarded RTP. The
 * real forward+capture already happened on the mediasoup pipe (forwardToTwoConsumers);
 * here we replay those exact bytes into the production collector's on('rtp') seam. The
 * emits are SYNCHRONOUS and happen AFTER the collector attached its listeners (in its
 * ctor), so every verify round deterministically snapshots the full captured set (no
 * microtask race against runCanaryVerifyRound's first `await deps.capture`).
 */
function collectorFrom(capturedA: Buffer[], capturedB: Buffer[]): PipeTapCollector {
  const emA = new EventEmitter();
  const emB = new EventEmitter();
  const collector = new PipeTapCollector([
    { receiverMinerId: SELF.minerId, consumer: emA },
    { receiverMinerId: PEER.minerId, consumer: emB },
  ]);
  for (const p of capturedA) emA.emit('rtp', p);
  for (const p of capturedB) emB.emit('rtp', p);
  return collector;
}

function makeDeps(
  collector: PipeTapCollector,
  board: InMemoryClaimBoard,
  submitted: DivergenceProof[],
  self: Ed25519Keypair,
): CanaryVerifyDeps {
  return {
    getRelayRoomScopes: (): RelayRoomScope[] => [{ relayId: RELAY_R, roomId: ROOM_ID }],
    getValidators: () => [SELF, PEER],
    getStunLossBps: () => 0n,
    capture: createPipeTapCapture(collector, {
      canaryKid: CANARY_KID, expectedCtrs: CTRS, kRoom: K_ROOM, cellSecret: CELL_SECRET,
    }),
    localBoard: board,
    selfSessionKeypair: self,
    submit: async (proof) => { submitted.push(proof); },
    // Zero-tolerance benign budget (deltaBps:0n + getStunLossBps:0n) BY DESIGN: TAMPER is
    // promoted p=1 regardless, and honest media is byte-exact, so any divergence is real.
    config: { k: 2, deltaBps: 0n, sendRate: CTRS.length },
  };
}

/** Drive the 2-validator quorum loop over the captured bytes; return submitted proofs. */
async function runQuorum(capturedA: Buffer[], capturedB: Buffer[]): Promise<DivergenceProof[]> {
  const board = new InMemoryClaimBoard({ wCorr: 100 });
  const submitted: DivergenceProof[] = [];
  const a = makeDeps(collectorFrom(capturedA, capturedB), board, submitted, new Ed25519Keypair());
  const b = makeDeps(collectorFrom(capturedA, capturedB), board, submitted, new Ed25519Keypair());
  let accA = undefined;
  let accB = undefined;
  for (let r = 0; r < 7; r++) { // > MIN_ROUNDS_FOR_CUMULATIVE (5)
    const ra = await runCanaryVerifyRound(a, accA, r); accA = ra.accumulator;
    const rb = await runCanaryVerifyRound(b, accB, r); accB = rb.accumulator;
  }
  return submitted;
}

describe('REQ-RMD-03 — honest relay forwards real canary media: ZERO divergence (no false positive, INV-A)', () => {
  it('over >MIN_ROUNDS rounds with byzantine OFF, no slash is submitted', async () => {
    const { capturedA, capturedB } = await forwardToTwoConsumers(false);
    expect(capturedA.length).toBeGreaterThan(0); // real media flowed (consumer A)
    expect(capturedB.length).toBeGreaterThan(0); // real media flowed (consumer B)
    expect(CANARY_FRAME_LEN).toBeGreaterThanOrEqual(10);
    const submitted = await runQuorum(capturedA, capturedB);
    expect(submitted).toHaveLength(0);
  }, 60_000);
});

describe('REQ-RMD-04/05/06 — byzantine tamper on REAL forwarded media -> detected -> >=2-distinct slash', () => {
  it('both validators detect the tamper from captured bytes; proof targets R with 2 distinct attesters', async () => {
    const { capturedA, capturedB } = await forwardToTwoConsumers(true);
    expect(capturedA.length).toBeGreaterThan(0);
    expect(capturedB.length).toBeGreaterThan(0);
    const submitted = await runQuorum(capturedA, capturedB);
    expect(submitted.length).toBeGreaterThan(0); // REQ-RMD-04: slash from REAL captured bytes
    for (const p of submitted) expect(p.relayMinerId).toBe(RELAY_R); // REQ-RMD-06: pinned to R
    // REQ-RMD-05: >=2 DISTINCT Wallet-B attesters
    const distinct = new Set(
      submitted[0]!.attestations.map((at) => Buffer.from(at.sessionPublicKey).toString('hex')),
    );
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  }, 60_000);
});

describe('REQ-RMD-10 — non-vacuity: the verdict reads the CAPTURED bytes', () => {
  it('feeding locally-recomputed GROUND TRUTH (not a captured forward) yields NO slash, proving detection is byte-driven', async () => {
    const bodies = await buildCanaryStream();
    const groundTruth = bodies.map((b) => Buffer.concat([Buffer.alloc(12), Buffer.from(b)]));
    const submitted = await runQuorum(groundTruth, groundTruth);
    expect(submitted).toHaveLength(0);
  }, 60_000);
});
