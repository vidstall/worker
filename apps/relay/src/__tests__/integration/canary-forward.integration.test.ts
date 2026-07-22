/**
 * REQ-CFA-003 / REQ-CFA-009 / INV-A (forwarding-integrity) — HERMETIC canary
 * forward-leg proof (REAL mediasoup DirectTransport, REAL client crypto).
 *
 * THE LOAD-BEARING INV-A PROOF. A content-blind relay forwards canary frames
 * BIT-EXACT and a covert verifier — holding ONLY the per-cell `cellSecret`,
 * never the relay's cooperation — recomputes the EXACT canary ciphertext stream
 * locally and asserts receiver-side byte equality. Then the RED hooks prove the
 * verifier has TEETH: a tampering relay (P10_FORCE_TAMPER, mirrors the M2
 * relay-blind hermetic floor) and a dropping relay are both DETECTED.
 *
 * RELATION TO M2 (relay-blind-realsframe): that test keyed off the ROSTER
 * (KeyManager / sealed-box K_room) and proved "ciphertext survives the forward,
 * decryptable ONLY with K_content". THIS test keys off a FIXED per-cell
 * `cellSecret` (PathC salt-mix, keying.ts) — a SYNTHETIC canary publisher, no
 * roster — and proves FORWARDING-INTEGRITY: the verifier drives the expected ctr
 * LOCALLY and flags tamper (byte mismatch) + drop (local-ctr gap) WITHOUT trusting
 * the relay-readable trailer ctr for detection. The mediasoup forward backbone
 * (forwardBodies / makeVp8RtpWithBody) is the SAME P5/P10 scaffolding, copied here
 * (file-local test harness, never production) with a drop hook added.
 *
 * INV-B (content-blind): the relay PRODUCTION forward path (room-handler.ts
 * createConsumer / recvTransport.consume) is UNTOUCHED — this audit is transparent
 * to it. The RED tamper hook is HARNESS-SIDE ONLY (it mutates the captured
 * forwarded Buffer), never a production hook.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/canary-forward.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

// REAL client crypto (vendored into @dvconf/shared) — only for the per-frame layout
// assertions; the verifier itself re-derives + recomputes. Nothing reimplemented.
import { readSframeTrailer, SFRAME_TRAILER_LEN } from '@dvconf/shared';
// The audit modules under test (validator-daemon canary plane).
import {
  verifyForwardedCanary,
  recomputeCanaryFrame,
  deriveCanarySeed,
  CANARY_FRAME_LEN,
  type VerifyInput,
} from '../../../../validator-daemon/src/canary/verifier.js';

// ── VP8-only codec (mirrors mediasoup-manager.ts + the M2 P10 floor) ───────────
const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

const SFRAME_CONFIG_BYTE = 0x01;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── RED hook (HARNESS-SIDE only — never a production hook) ──────────────────────
// P10_FORCE_TAMPER=1 flips the LAST ciphertext byte (the one just before the
// 14-byte trailer) of each captured forwarded SFrame, modelling a NON-blind relay
// that mutated the body in transit. The trailer (config 0x01 | KID | CTR) stays
// intact so the verifier still locates the frame by kid+ctr → it classifies the
// byte mismatch as TAMPER. With the flag UNSET this is a no-op (GREEN = real bytes).
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';

/** Minimal RTCP Sender Report (PT=200) — VERBATIM from the M2 P10 floor. Required so
 *  each SSRC has a non-zero GetSenderReportNtpMs(), the SimulcastConsumer forward
 *  precondition (G-MCS-1). */
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

/** Build a VP8 RTP packet carrying an opaque BODY (the canary SFrame) after a
 *  real-VP8 header (keyframe start code on keyframes). VERBATIM from the M2 P10 floor. */
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

/**
 * One forwarding tile: a single-layer (L1T1) VP8 producer (DirectTransport src)
 * + an unpaused DirectTransport consumer that CAPTURES every forwarded RTP packet.
 * Bodies are cycled round-robin so a finite canary set drives a steady stream.
 * Copied from the M2 P10 floor with a DROP hook: any ctr in `dropBodyIndices`
 * (the round-robin body slot) is NEVER sent → that canary frame is absent on the
 * wire → the verifier flags it as a DROP via the LOCAL expected-ctr gap.
 */
async function forwardBodies(
  index: number,
  bodies: Uint8Array[],
  opts?: { dropBodyIndices?: Set<number> },
): Promise<Buffer[]> {
  const ssrc = 0x3000_0000 + index * 0x10;
  const drop = opts?.dropBodyIndices ?? new Set<number>();

  const rtpParameters: msTypes.RtpParameters = {
    codecs: [
      { mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] },
    ],
    encodings: [{ ssrc, scalabilityMode: 'L1T1' }],
  };

  const srcTransport = await router.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'video', rtpParameters });
  const sinkTransport = await router.createDirectTransport();
  const consumer = await sinkTransport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false,
  });

  const captured: Buffer[] = [];
  consumer.on('rtp', (pkt: Buffer) => {
    const copy = Buffer.from(pkt);
    // RED tamper hook (harness-side): flip the last ciphertext byte (just before
    // the 14-byte trailer) so the body can no longer byte-match a recomputed C_i,
    // while the trailer (config 0x01 | KID | CTR) survives for kid+ctr location.
    if (FORCE_TAMPER) {
      const ti = copy.length - SFRAME_TRAILER_LEN - 1;
      if (ti >= 0) copy[ti] = (copy[ti]! ^ 0xff) & 0xff;
    }
    captured.push(copy);
    if (captured.length > 1024) captured.shift();
  });

  let seq = 0;
  let pic = 0;
  let ts = 0;
  let frame = 0;
  let pktCount = 0;
  let octetCount = 0;
  const interval = setInterval(() => {
    const slot = frame % bodies.length;
    const keyframe = frame % 10 === 0;
    if (!drop.has(slot)) {
      const body = bodies[slot]!;
      const packet = makeVp8RtpWithBody({
        ssrc,
        seq: seq++,
        ts,
        pictureId: pic++ & 0x7fff,
        body,
        keyframe,
      });
      producer.send(packet);
      pktCount += 1;
      octetCount += packet.length;
      if (keyframe) {
        srcTransport.sendRtcp(makeRtcpSenderReport(ssrc, ts, pktCount, octetCount));
      }
    }
    ts += 3000;
    frame++;
  }, 10);

  await consumer.requestKeyFrame();
  await sleep(900);
  clearInterval(interval);
  await sleep(50);
  try {
    consumer.close();
    producer.close();
    srcTransport.close();
    sinkTransport.close();
  } catch {
    /* best-effort */
  }
  return captured;
}

// ── Fixed per-cell canary inputs (NOT roster keying) ───────────────────────────
const CELL_SECRET = new Uint8Array(32).fill(0xab); // fixed >=128-bit OOB cellSecret
const K_ROOM = new Uint8Array(32).fill(0x5c); // fixed room key (canary cell holds it)
const ROOM_ID = 'cfa-canary-forward-room';
const CANARY_KID = 7;
const N_FRAMES = 6; // >= 5 canary frames

/** Build the canonical canary SFrame stream for ctr 0..N-1 from cellSecret only. */
async function buildCanaryStream(): Promise<{ bodies: Uint8Array[]; ctrs: number[] }> {
  const canarySeed = deriveCanarySeed(CELL_SECRET);
  const baseInput: Omit<VerifyInput, 'expectedCtrs'> = {
    kRoom: K_ROOM,
    roomId: ROOM_ID,
    cellSecret: CELL_SECRET,
    canaryKid: CANARY_KID,
  };
  const ctrs = Array.from({ length: N_FRAMES }, (_, i) => i);
  const bodies: Uint8Array[] = [];
  for (const ctr of ctrs) {
    const sframe = await recomputeCanaryFrame(baseInput, canarySeed, ctr);
    bodies.push(sframe);
  }
  return { bodies, ctrs };
}

const verifyInput = (expectedCtrs: number[]): VerifyInput => ({
  kRoom: K_ROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  expectedCtrs,
});

describe('REQ-CFA-003/009 INV-A — hermetic canary forward leg (REAL mediasoup + receiver-side equality)', () => {
  it(
    'POSITIVE: a content-blind relay forwards canary frames BIT-EXACT — verifier (cellSecret-only, local ctr) ⇒ byteIdentical==mediaPackets, 0 divergences',
    async () => {
      const { bodies, ctrs } = await buildCanaryStream();

      // Layout self-check: each canary SFrame carries the real 14-byte trailer
      // (config 0x01 at len-14) bearing our KID + ctr, and codecOffset is the
      // PINNED keyframe value (10, since CANARY_FRAME_LEN >= 10) ⇒ deterministic AAD.
      expect(CANARY_FRAME_LEN).toBeGreaterThanOrEqual(10);
      bodies.forEach((s, i) => {
        expect(s[s.length - SFRAME_TRAILER_LEN]).toBe(SFRAME_CONFIG_BYTE);
        expect(s.length).toBe(CANARY_FRAME_LEN + 16 + SFRAME_TRAILER_LEN);
        const t = readSframeTrailer(s);
        expect(t.kid).toBe(CANARY_KID);
        expect(t.ctr).toBe(i);
        expect(t.codecOffset).toBe(10);
      });
      // The canary bodies are all distinct (the PRF is non-degenerate).
      expect(new Set(bodies.map((b) => Buffer.from(b).toString('base64'))).size).toBe(bodies.length);

      const forwarded = await forwardBodies(0, bodies);
      // GUARD: real media flowed (no dead-pipe false-green).
      expect(forwarded.length).toBeGreaterThan(0);

      const result = await verifyForwardedCanary(forwarded, verifyInput(ctrs));

      // eslint-disable-next-line no-console
      console.log(
        `[CFA-003 positive] forwarded=${forwarded.length} mediaPackets=${result.mediaPackets} ` +
          `byteIdentical=${result.byteIdentical} divergences=${result.divergences.length}` +
          (FORCE_TAMPER ? '  [RED HOOK: P10_FORCE_TAMPER=1]' : ''),
      );

      expect(result.mediaPackets).toBeGreaterThan(0);

      if (FORCE_TAMPER) {
        // RED TAMPER TOOTH: every forwarded body was mutated ⇒ NO byte-identical
        // match ⇒ byteIdentical < mediaPackets AND a tamper divergence
        // (expectedHash != observedHash, observedHash != 'MISSING') for each ctr.
        expect(result.byteIdentical).toBeLessThan(result.mediaPackets);
        expect(result.divergences.length).toBe(ctrs.length);
        for (const d of result.divergences) {
          expect(d.observedHash).not.toBe('MISSING');
          expect(d.observedHash).not.toBe(d.expectedHash);
        }
        return;
      }

      // GREEN: every locally-recomputed canary frame is byte-identical to a
      // forwarded body — the relay forwarded BIT-EXACT, proven receiver-side with
      // NO relay cooperation. Zero divergences.
      expect(result.byteIdentical).toBe(result.mediaPackets);
      expect(result.divergences.length).toBe(0);
    },
    120_000,
  );

  it(
    'RED DROP TOOTH: a dropped canary seq (one body never sent) ⇒ a DROP divergence (observedHash MISSING) via the LOCAL expected-ctr gap, not the relay trailer',
    async () => {
      const { bodies, ctrs } = await buildCanaryStream();
      const DROP_CTR = 2; // drop the round-robin slot for ctr=2 entirely

      // Drop every occurrence of body#DROP_CTR so that ctr never appears on the wire.
      const forwarded = await forwardBodies(0, bodies, {
        dropBodyIndices: new Set<number>([DROP_CTR]),
      });
      expect(forwarded.length).toBeGreaterThan(0);

      const result = await verifyForwardedCanary(forwarded, verifyInput(ctrs));

      // eslint-disable-next-line no-console
      console.log(
        `[CFA-009 drop] forwarded=${forwarded.length} mediaPackets=${result.mediaPackets} ` +
          `byteIdentical=${result.byteIdentical} divergences=${result.divergences.length} ` +
          `dropCtr=${DROP_CTR}`,
      );

      // Exactly one divergence — the dropped ctr — flagged MISSING. The OTHER
      // canary frames still forwarded BIT-EXACT (byteIdentical accounts for them).
      expect(result.divergences.length).toBe(1);
      const drop = result.divergences[0]!;
      expect(drop.frameSeq).toBe(DROP_CTR);
      expect(drop.observedHash).toBe('MISSING');
      expect(drop.expectedHash).not.toBe('MISSING');
      // The non-dropped frames were forwarded intact (proving the drop is a real,
      // localised gap — not a global failure).
      expect(result.byteIdentical).toBe(result.mediaPackets);
      expect(result.mediaPackets).toBeGreaterThan(0);
    },
    120_000,
  );
});
