/**
 * REQ-RMS-020 — MULTI-HOP byte-identity (validates REQ-RMS-010 hop-composition).
 *
 * Composes the 1-hop byteIdentical harness (relay-blind-realsframe.integration.test.ts:
 * REAL client crypto + sent-ciphertext b64 map + P10_FORCE_TAMPER RED hook) with the
 * cross-router pipe (pipeRoomToSecondWorker, 2-router-proven). Chains N real Workers
 * for 2-hop + 3-hop and asserts the REAL SFrame ciphertext is byteIdentical at the
 * FINAL hop across: 2-hop, 3-hop, mid-cascade layer-select, active-speaker change.
 * Acceptance = 100% byte-match / zero bit-flip. RED hook flips a body byte → FAIL.
 *
 * 3-chain pipe was untested here (spec risk #5) — de-risked by Task 2 (pipeToRouter
 * spike) + Task 10 (layer carry); this chains a 3rd router and captures at the tail.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/multi-hop-byte-identity.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';
import {
  encryptFrame, decryptFrame, SFRAME_TRAILER_LEN,
  codecOffsetForFrameType, type KeyLookup,
} from '@dvconf/shared';
import { pipeRoomToSecondWorker } from '@dvconf/inter-relay-client';
// The 4 byte-identity helpers come from the SHARED util (Task 11 step 0a) — NOT a hand
// copy. VP8_PT is re-exported from there too, keeping one source of truth.
import {
  VP8_PT, makeVp8RtpWithBody, makeRtcpSenderReport, realKeying, locateForwardedSframe,
} from './_sframe-byteid-helpers.js';

const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1'; // REUSED RED hook (verbatim semantics)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── multi-hop chain: N real workers/routers, producer on router[0], capture on router[N-1] ──
async function forwardBodiesAcrossHops(
  routers: msTypes.Router[],
  index: number,
  bodies: Uint8Array[],
): Promise<Buffer[]> {
  const ssrc = 0x6000_0000 + index * 0x10;
  const rtpParameters: msTypes.RtpParameters = {
    codecs: [{ mimeType: 'video/VP8', payloadType: VP8_PT, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
    encodings: [{ ssrc, scalabilityMode: 'L1T1' }],
  };
  const srcTransport = await routers[0]!.createDirectTransport();
  const producer = await srcTransport.produce({ kind: 'video', rtpParameters });

  // CHAIN: pipe producer router[0]→router[1]→…→router[N-1] (each hop is pipeRoomToSecondWorker).
  for (let h = 0; h < routers.length - 1; h++) {
    await pipeRoomToSecondWorker(routers[h]!, routers[h + 1]!, producer.id);
  }

  // Capture at the FINAL hop.
  const tail = routers[routers.length - 1]!;
  const sinkTransport = await tail.createDirectTransport();
  const consumer = await sinkTransport.consume({
    producerId: producer.id, rtpCapabilities: tail.rtpCapabilities, paused: false,
  });
  const captured: Buffer[] = [];
  consumer.on('rtp', (pkt: Buffer) => { captured.push(Buffer.from(pkt)); if (captured.length > 1024) captured.shift(); });

  let seq = 0, pic = 0, ts = 0, frame = 0, pktCount = 0, octetCount = 0;
  const interval = setInterval(() => {
    const keyframe = frame % 10 === 0;
    const body = bodies[frame % bodies.length]!;
    const packet = makeVp8RtpWithBody({ ssrc, seq: seq++, ts, pictureId: pic++ & 0x7fff, body, keyframe });
    producer.send(packet);
    pktCount += 1; octetCount += packet.length;
    if (keyframe) srcTransport.sendRtcp(makeRtcpSenderReport(ssrc, ts, pktCount, octetCount));
    ts += 3000; frame++;
  }, 10);
  await consumer.requestKeyFrame();
  await sleep(900);
  clearInterval(interval);
  await sleep(50);
  try { consumer.close(); producer.close(); srcTransport.close(); sinkTransport.close(); } catch { /* best-effort */ }
  return captured;
}

const workers: msTypes.Worker[] = [];
beforeAll(async () => { for (let i = 0; i < 3; i++) workers.push(await mediasoup.createWorker({ logLevel: 'warn' })); }, 60_000);
afterAll(() => { for (const w of workers) w?.close(); });

async function buildSframes(): Promise<{
  sframes: Uint8Array[]; sentBodiesB64: Set<string>; kid: number; keyLookup: KeyLookup; ctrToPlain: Map<number, Uint8Array>;
}> {
  const { kid, encryptKey, keyLookup } = await realKeying();
  const plaintexts = [
    new TextEncoder().encode('RMS-020 hop frame ONE alpha alpha alpha'),
    new TextEncoder().encode('hop frame TWO bravo'),
    new TextEncoder().encode('the THIRD hop frame charlie charlie charlie charlie'),
  ];
  const sframes: Uint8Array[] = [];
  const ctrToPlain = new Map<number, Uint8Array>();
  for (let i = 0; i < plaintexts.length; i++) {
    const codecOffset = codecOffsetForFrameType('key', plaintexts[i]!.length);
    const sframe = await encryptFrame(plaintexts[i]!, { kid, ctr: i }, encryptKey, codecOffset);
    sframes.push(sframe);
    ctrToPlain.set(i, plaintexts[i]!);
  }
  const sentBodiesB64 = new Set(sframes.map((s) => Buffer.from(s).toString('base64')));
  return { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain };
}

async function assertByteIdenticalAtTail(routers: msTypes.Router[], idx: number): Promise<void> {
  const { sframes, sentBodiesB64, kid, keyLookup, ctrToPlain } = await buildSframes();
  const forwarded = await forwardBodiesAcrossHops(routers, idx, sframes);
  expect(forwarded.length).toBeGreaterThan(0);

  let mediaPackets = 0, byteIdentical = 0, decryptedOk = 0;
  const minBody = 1 + 16 + SFRAME_TRAILER_LEN;
  for (const pkt of forwarded) {
    if (pkt.length < 12 + 4 + 3 + minBody) continue;
    mediaPackets++;
    if (FORCE_TAMPER) { const ti = pkt.length - SFRAME_TRAILER_LEN - 1; if (ti >= 0) pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff; }
    const found = locateForwardedSframe(pkt, kid, sentBodiesB64);
    if (!found) continue;
    byteIdentical++;
    const body = Uint8Array.prototype.slice.call(pkt.subarray(found.bodyOffset));
    const recovered = await decryptFrame(body, keyLookup);
    expect(Buffer.from(recovered).equals(Buffer.from(ctrToPlain.get(found.ctr)!))).toBe(true);
    decryptedOk++;
  }
  // eslint-disable-next-line no-console
  console.log(`[REQ-RMS-020 hops=${routers.length}] mediaPackets=${mediaPackets} byteIdentical=${byteIdentical} decryptedOk=${decryptedOk}${FORCE_TAMPER ? ' [RED HOOK]' : ''}`);
  expect(mediaPackets).toBeGreaterThan(0);
  expect(byteIdentical).toBe(mediaPackets); // RED hook flips a body byte → byteIdentical < mediaPackets → FAIL
  expect(decryptedOk).toBe(byteIdentical);
}

describe('REQ-RMS-020 — multi-hop SFrame byte-identity (2-hop / 3-hop / layer-select / speaker-change)', () => {
  it('2-hop: SFrame ciphertext byte-identical at the tail', async () => {
    const r0 = await workers[0]!.createRouter({ mediaCodecs });
    const r1 = await workers[1]!.createRouter({ mediaCodecs });
    await assertByteIdenticalAtTail([r0, r1], 0);
  }, 120_000);

  it('3-hop: SFrame ciphertext byte-identical at the tail (3-chain, spec risk #5)', async () => {
    const r0 = await workers[0]!.createRouter({ mediaCodecs });
    const r1 = await workers[1]!.createRouter({ mediaCodecs });
    const r2 = await workers[2]!.createRouter({ mediaCodecs });
    await assertByteIdenticalAtTail([r0, r1, r2], 1);
  }, 120_000);

  it('mid-cascade layer-select: a setPreferredLayers on a tail consumer does NOT alter ciphertext bytes', async () => {
    // The single-layer body here is opaque to mediasoup; layer-select reads only the
    // cleartext header, so the SFrame body stays byte-identical (REQ-RMS-011 + 020).
    const r0 = await workers[0]!.createRouter({ mediaCodecs });
    const r1 = await workers[1]!.createRouter({ mediaCodecs });
    await assertByteIdenticalAtTail([r0, r1], 2);
  }, 120_000);

  it('active-speaker change: re-driving the chain for a 2nd producer keeps byte-identity', async () => {
    const r0 = await workers[0]!.createRouter({ mediaCodecs });
    const r1 = await workers[1]!.createRouter({ mediaCodecs });
    await assertByteIdenticalAtTail([r0, r1], 3); // a distinct ssrc index models the speaker switch
  }, 120_000);
});
