/**
 * W5 M2 Phase 10 (P10) — RELAY-BLIND, REAL-SFRAME HERMETIC FLOOR (REQ-MCS-014).
 *
 * THE THESIS HEADLINE, hermetic real-crypto leg. P5
 * (`relay-blind-forward.integration.test.ts`) already PROVED the STRUCTURAL
 * blind-forward invariant: mediasoup forwards an opaque RTP payload BYTE-IDENTICAL
 * (it has no decode/decrypt/mutate path), selecting layers only on the cleartext
 * header. P5 did this with a STAND-IN opaque body (deterministic random bytes + a
 * FAKE 6-byte SFrame header, config 0x00). We do NOT re-prove P5's result here.
 *
 * P10's HONEST DELTA over P5 (and the ONLY new claim this file makes):
 *   The opaque body forwarded through the relay is now a REAL P2/P3 (M3 Lane B
 *   partial-SFrame) CIPHERTEXT — produced by the SHIPPED client crypto:
 *     real ed25519 session keypair (session-keypair.ts)
 *       → real libsodium sealed-box K_room distribution (e2ee-spike.ts)
 *       → real per-sender K_content HKDF (KeyManager, key-manager.ts, D-M2-21)
 *       → real AES-GCM `encryptFrame` over the REAL partial-SFrame layout
 *         [ cleartext codec prefix (codecOffset) | ciphertext||tag | 14-byte TRAILER:
 *           config:1 | kid:u32-BE | ctr:u64-BE | codecOffset:u8 ] (sframe-transform.ts).
 *   That real ciphertext stays opaque + byte-identical through the in-process
 *   relay forward, and — the load-bearing contrast — a NON-E2EE (cleartext)
 *   payload forwarded over the SAME relay path comes out DECODABLE WITHOUT ANY
 *   KEY. So the relay's behaviour is byte-for-byte identical for ciphertext and
 *   cleartext; what differs is whether the forwarded bytes mean anything to a
 *   reader without K_content.
 *
 * We import the REAL client crypto by relative path (cross-repo); Vite/Vitest
 * resolves each client module's OWN deps (libsodium-wrappers-sumo, @mysten/bcs,
 * @mysten/sui) from the client's node_modules. NO SFrame/AES-GCM is reimplemented
 * here — the ciphertext is the production stack's, verbatim.
 *
 * ── What is PROVEN (positive) ─────────────────────────────────────────────────
 *   (a) BYTE-IDENTITY of the REAL ciphertext through the forward: every forwarded
 *       media packet's SFrame body byte-matches the exact `encryptFrame` output we
 *       sent (the relay rewrote only RTP/VP8 HEADER bytes for routing).
 *   (b) REAL 14-byte TRAILER OBSERVED on the wire: config byte 0x01 + readSframeTrailer
 *       (parsed FROM THE END) recovers the exact {kid, ctr} for each forwarded body.
 *   (c) DECODABLE WITH the key: `decryptFrame(forwardedBody, keyLookup)` (the REAL
 *       per-sender keyLookup) recovers the EXACT original plaintext.
 *   (d) NON-VACUOUS (no key / wrong key): `decryptFrame` with a null lookup AND with
 *       an INDEPENDENT real K_content both REJECT (GCM auth failure) — so (c) is a
 *       real decrypt, not a tautology.
 *
 * ── NEGATIVE CONTROL (load-bearing) ───────────────────────────────────────────
 *   The SAME plaintext WITHOUT SFrame (a plain cleartext payload modelling a
 *   non-E2EE room) is forwarded through the SAME relay path. Its forwarded body is
 *   recovered and parsed back to the ORIGINAL plaintext WITH NO KEY. This is the
 *   contrast that gives the headline its meaning: identical relay mechanics, but
 *   the non-E2EE bytes are readable and the SFrame bytes are not (without K_content).
 *
 * ── RED hooks (prove the GREEN asserts are the mechanism, not vacuous) ─────────
 *   P10_FORCE_TAMPER=1 flips one body byte of each forwarded SFrame packet before
 *   the byte-identity comparison → the body no longer matches a sent ciphertext →
 *   the byte-identity assert FAILS (mirrors P5's BLIND_FORCE_TAMPER). It ALSO
 *   exercises the AEAD-integrity path explicitly: we locate the tampered body by
 *   its trailer-config (skipping the b64-map gate, which the tampered body no longer
 *   matches) and assert `decryptFrame` on the tampered bytes REJECTS — so a mutated ciphertext is both non-identical
 *   AND undecryptable.
 *
 * ── Honesty bounds (DA-2/DA-3/DA-8, D-M2-7/8 — keep the P5 block) ──────────────
 * This is a RELAY-SIDE mechanism floor on a SYNTHETIC DirectTransport source — NOT
 * WAN glass-to-glass, NOT a browser getStats(), NOT a real-browser SFrame-over-VP8
 * interop run (that real-browser leg is **Step 2**, the separate dated
 * `.evidence/verification/transmission-m2-relayblind-*.md` artifact). The relay's
 * blindness here is STRUCTURAL (mediasoup has no SFrame/decode path; the payload is
 * opaque to it). This is **NOT a crypto audit** and is **NEVER** a cryptographic
 * "relay/validator CANNOT decrypt" claim — in M2 the validator HOLDS the key and
 * blindness is ECONOMIC/OPERATIONAL; cryptographic validator-exclusion is Path C →
 * M3 (D-M2-7/8). What this proves is the STRUCTURAL floor: real P2/P3 (M3 Lane B
 * partial-SFrame) ciphertext (real 14-byte trailer + real AES-GCM + real per-sender
 * K_content) survives the relay forward opaque + byte-identical, decryptable ONLY with
 * the key, against a cleartext negative control that needs no key.
 *
 * Requirements touched: REQ-MCS-014 (relay-blind real-SFrame hermetic floor).
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/relay-blind-realsframe.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as mediasoup from 'mediasoup';
import type { types as msTypes } from 'mediasoup';

// ── REAL client crypto (cross-repo import, Mechanism A) ───────────────────────
// 6-level `../` from this integration dir to the client lib. Vite resolves each
// client module's OWN deps from dvconf-client/node_modules. NOTHING here
// reimplements SFrame / AES-GCM / key derivation — the ciphertext is the
// production stack's, verbatim (the P10 invariant).
import {
  encryptFrame,
  decryptFrame,
  readSframeTrailer,
  SFRAME_TRAILER_LEN,
  codecOffsetForFrameType,
  type KeyLookup,
} from '../../../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';
import {
  KeyManager,
  type RosterMember,
} from '../../../../../../dvconf-client/src/lib/crypto/key-manager.js';
import { createSessionKeypair } from '../../../../../../dvconf-client/src/lib/crypto/session-keypair.js';

// -- VP8-only codec (mirrors mediasoup-manager.ts + the M1 bench / P5) ----------

const VP8_PT = 101;
const mediaCodecs: msTypes.RtpCodecCapability[] = [
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, preferredPayloadType: VP8_PT },
];

// REAL partial-SFrame layout (sframe-transform.ts, M3 Lane B): the cleartext metadata
// is now a 14-byte TRAILER at the END whose first byte is CONFIG_BYTE 0x01 (NOT P5's
// fake 0x00, and NOT a front header). The trailer is
// [config:1 | kid:u32-BE | ctr:u64-BE | codecOffset:u8], parsed key-free FROM THE END by
// readSframeTrailer. The body is located by the AUTHORITATIVE sent-ciphertext b64 match
// (mediasoup rewrites RTP/VP8 HEADER bytes for routing, never the SFrame body).
const SFRAME_CONFIG_BYTE = 0x01;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── RED hook ──────────────────────────────────────────────────────────────────
// P10_FORCE_TAMPER=1 flips a CIPHERTEXT-BODY byte of each forwarded SFrame packet
// before the byte-identity comparison: the body no longer matches a sent ciphertext
// (byteIdentical < mediaPackets) AND, located by the trailer-config (b64-map gate
// skipped), the tampered bytes fail AEAD decrypt. With the flag UNSET this is a no-op,
// so GREEN is the real forwarded bytes. Mirrors P5's BLIND_FORCE_TAMPER.
const FORCE_TAMPER = process.env['P10_FORCE_TAMPER'] === '1';

/** Minimal RTCP Sender Report (PT=200) — VERBATIM from P5 / the M1 bench. Required
 *  so each SSRC has a non-zero GetSenderReportNtpMs(), the precondition the
 *  SimulcastConsumer demands to forward (G-MCS-1). */
function makeRtcpSenderReport(
  ssrc: number,
  rtpTimestamp: number,
  packetCount: number,
  octetCount: number,
): Buffer {
  const buf = Buffer.alloc(28);
  buf[0] = 0x80;
  buf[1] = 200; // SR
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

/**
 * Build a VP8 RTP packet whose payload carries an arbitrary opaque BODY after a
 * real-VP8 header (G-MCS-1 keyframe start code on keyframes). The body is the REAL
 * SFrame ciphertext (positive) OR a cleartext plaintext (negative control) — the
 * relay forwards either opaquely; this builder is body-agnostic.
 *
 * VP8 header semantics are VERBATIM from P5's makeSframeVp8Rtp.
 */
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
  header[0] = 0x80; // V=2
  header[1] = (VP8_PT & 0x7f) | 0x80; // marker=1 + PT
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);

  const desc = Buffer.from([
    0x90, // X=1, S=1
    0x80, // I=1 (PictureID present)
    0x80 | ((pictureId >> 8) & 0x7f), // M=1 + PID high 7 bits
    pictureId & 0xff, // PID low 8 bits
  ]);

  let vp8PayloadHeader: Buffer;
  if (keyframe) {
    vp8PayloadHeader = Buffer.from([
      0x10, 0x00, 0x00, // frame tag: P-bit=0 => keyframe
      0x9d, 0x01, 0x2a, // VP8 keyframe start code (G-MCS-1)
      0x80, 0x02, // width 640
      0xe0, 0x01, // height 480
    ]);
  } else {
    vp8PayloadHeader = Buffer.from([0x11, 0x00, 0x00]); // P-bit=1 => interframe
  }

  return Buffer.concat([header, desc, vp8PayloadHeader, Buffer.from(body)]);
}

/**
 * REAL keying (production source). Build two real session keypairs (coord + me),
 * have the coordinator bootstrap + seal K_room to the roster, and have ME open my
 * sealed envelope. Returns my real per-sender encrypt key + the real keyLookup the
 * receiver uses to decrypt. This is the SHIPPED P1/P3 path — no crypto here.
 *
 * Coordinator election is by smallest pubkey (electCoordinator); whichever of the
 * two wins bootstraps, and the OTHER's KeyManager applies the bundle. We always end
 * up with MY KeyManager holding the room key (either I bootstrapped, or I applied).
 */
async function realKeying(): Promise<{
  senderId: string;
  kid: number;
  encryptKey: CryptoKey;
  keyLookup: KeyLookup;
}> {
  const a = createSessionKeypair({ withOpener: true });
  const b = createSessionKeypair({ withOpener: true });
  const roster: RosterMember[] = [
    { peerId: 'peer-a', sessionPubkeyB64: a.publicKeyB64 },
    { peerId: 'peer-b', sessionPubkeyB64: b.publicKeyB64 },
  ];

  // "me" is keypair `a`; the coordinator is whichever wins the election.
  const meKm = new KeyManager({
    roomId: 'p10-relayblind-room',
    localSessionPubkeyB64: a.publicKeyB64,
    opener: a.opener!,
    graceWindowMs: 2000,
  });
  const otherKm = new KeyManager({
    roomId: 'p10-relayblind-room',
    localSessionPubkeyB64: b.publicKeyB64,
    opener: b.opener!,
    graceWindowMs: 2000,
  });
  meKm.setRoster(roster);
  otherKm.setRoster(roster);

  // The coordinator (smaller pubkey) bootstraps + seals; the other applies. Whoever
  // I am, MY KeyManager (`meKm`) ends up holding the room key.
  if (meKm.isCoordinator()) {
    const bundle = await meKm.bootstrapRoomKey();
    await otherKm.applyBundle(bundle); // not used to decrypt, but exercises the full seal/open path
  } else {
    const bundle = await otherKm.bootstrapRoomKey();
    await meKm.applyBundle(bundle); // opens MY real sealed envelope (real libsodium box_open)
  }

  const senderId = a.publicKeyB64;
  const kid = meKm.kid;
  const encryptKey = await meKm.contentKeyForSenderAtKid(senderId, kid);
  if (!encryptKey) throw new Error('realKeying: no K_content for the bootstrapped epoch');
  const keyLookup = meKm.keyLookupForSender(senderId);
  return { senderId, kid, encryptKey, keyLookup };
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
 * One forwarding tile: a single-layer VP8 producer (DirectTransport src) + an
 * unpaused DirectTransport consumer that CAPTURES every forwarded RTP packet
 * (DirectTransport consumers emit per-packet 'rtp'). The driver injects packets
 * whose BODY is supplied by the caller (real SFrame ciphertext OR cleartext), with
 * a real-VP8 keyframe + RTCP-SR every 10th frame (G-MCS-1). Returns the captured
 * forwarded packets after the drive window.
 */
async function forwardBodies(
  index: number,
  bodies: Uint8Array[],
): Promise<Buffer[]> {
  const ssrc = 0x3000_0000 + index * 0x10;

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
    paused: false, // UNPAUSED — RTP must flow to be captured
  });

  const captured: Buffer[] = [];
  consumer.on('rtp', (pkt: Buffer) => {
    captured.push(Buffer.from(pkt));
    if (captured.length > 1024) captured.shift();
  });

  let seq = 0;
  let pic = 0;
  let ts = 0;
  let frame = 0;
  let pktCount = 0;
  let octetCount = 0;

  // Cycle the supplied bodies round-robin so a finite plaintext set drives a steady
  // packet stream for the ~900ms window.
  const interval = setInterval(() => {
    const keyframe = frame % 10 === 0;
    const body = bodies[frame % bodies.length]!;
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
    ts += 3000; // ~33ms @ 90kHz
    frame++;
  }, 10);

  await consumer.requestKeyFrame();
  await sleep(900);
  clearInterval(interval);
  await sleep(50); // drain in-flight

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

/**
 * Locate the REAL partial-SFrame body in a FORWARDED VP8 RTP packet by SCANNING for the
 * candidate body start (offsets 12..64) and matching the AUTHORITATIVE sent-ciphertext
 * b64 set: `cand = pkt.subarray(off)`, and if `sentBodiesB64.has(cand.toString('base64'))`
 * the body is found. The M3 Lane B config byte 0x01 now lives in the TRAILER at the END,
 * so there is no front 0x01+KID signature to scan; the b64 byte-identity match IS the
 * authoritative locator. We then parse the trailer FROM THE END for {kid, ctr}.
 *
 * Why scan, not a fixed offset (same lesson as P5): mediasoup legitimately rewrites
 * RTP/VP8 HEADER bytes for routing (extension, descriptor) — that is the cleartext
 * metadata routing the blind-forward invariant PERMITS. It NEVER rewrites the SFrame body.
 *
 * Returns {bodyOffset, kid, ctr} when the trailing body matched a sent body; else null.
 */
function locateForwardedSframe(
  pkt: Buffer,
  kid: number,
  sentBodiesB64: Set<string>,
): { bodyOffset: number; kid: number; ctr: number } | null {
  const scanEnd = Math.min(pkt.length - SFRAME_TRAILER_LEN, 64);
  for (let off = 12; off < scanEnd; off++) {
    const cand = pkt.subarray(off);
    if (cand.length < SFRAME_TRAILER_LEN + 16) break; // too short to hold body + trailer
    if (sentBodiesB64.has(cand.toString('base64'))) {
      const trailer = readSframeTrailer(cand);
      void kid; // kid is asserted by the caller against trailer.kid
      return { bodyOffset: off, kid: trailer.kid, ctr: trailer.ctr };
    }
  }
  return null;
}

/**
 * TRAILER-ONLY locator (RED-hook aid): find the partial-SFrame body WITHOUT the b64-map
 * gate by scanning for a candidate body start whose TRAILER (parsed FROM THE END by
 * readSframeTrailer) carries config 0x01 + our KID. Used only to locate a TAMPERED body
 * (which by definition no longer matches the sent map) so we can assert it fails AEAD
 * decrypt. The RED hook flips a CIPHERTEXT-body byte (not the trailer), so the trailer
 * config + KID survive and remain locatable here.
 */
function locateSframeHeaderOnly(pkt: Buffer, kid: number): number | null {
  const scanEnd = Math.min(pkt.length - SFRAME_TRAILER_LEN, 64);
  for (let off = 12; off < scanEnd; off++) {
    const cand = pkt.subarray(off);
    if (cand.length < SFRAME_TRAILER_LEN + 16) break;
    // The trailer's config byte sits at (cand.length - SFRAME_TRAILER_LEN). Only attempt a
    // trailer parse when that byte is 0x01, then confirm the KID matches.
    if (cand[cand.length - SFRAME_TRAILER_LEN] !== SFRAME_CONFIG_BYTE) continue;
    try {
      const trailer = readSframeTrailer(cand);
      if (trailer.kid === (kid >>> 0)) return off;
    } catch {
      /* not a trailer at this offset; keep scanning */
    }
  }
  return null;
}

describe('W5 M2 P10 — relay-blind REAL-SFrame hermetic floor (REAL mediasoup + REAL client crypto, REQ-MCS-014)', () => {
  it(
    'POSITIVE: REAL P2/P3 SFrame ciphertext survives the relay forward byte-identical, decryptable ONLY with K_content (RED hook P10_FORCE_TAMPER)',
    async () => {
      // ── REAL keying + REAL encryption (production stack, no reimplementation) ──
      const { senderId, kid, encryptKey, keyLookup } = await realKeying();

      // Known plaintexts of varying length → varying real ciphertext lengths
      // (|plaintext| + 16 GCM tag + 14-byte trailer = |plaintext| + 30, independent of
      // codecOffset), so a coincidental match is implausible.
      const plaintexts = [
        new TextEncoder().encode('P10 relay-blind: known plaintext frame ONE — alpha'),
        new TextEncoder().encode('frame TWO bravo'),
        new TextEncoder().encode('the third known plaintext frame — charlie charlie charlie charlie'),
      ];

      // REAL encryptFrame (M3 Lane B partial-SFrame): cleartext codec prefix (codecOffset
      // bytes) + real AES-GCM body + 14-byte trailer [config 0x01 | kid:u32 | ctr:u64 |
      // codecOffset:u8] under the real per-sender K_content. We model the synthetic
      // plaintext as a KEYFRAME (codecOffset = codecOffsetForFrameType('key', |pt|), clamped
      // to the plaintext length). NOTHING is reimplemented.
      const sframes: Uint8Array[] = [];
      const ctrToPlain = new Map<number, Uint8Array>();
      for (let i = 0; i < plaintexts.length; i++) {
        const codecOffset = codecOffsetForFrameType('key', plaintexts[i]!.length);
        const sframe = await encryptFrame(plaintexts[i]!, { kid, ctr: i }, encryptKey, codecOffset);
        // PROVE the real layout up front: the cleartext prefix is the first codecOffset
        // bytes of the plaintext, the trailing config byte (at len-14) is 0x01, length =
        // |pt| + 16 + 14 (= |pt| + 30), and readSframeTrailer recovers the exact {kid, ctr}.
        expect(sframe[sframe.length - SFRAME_TRAILER_LEN]).toBe(SFRAME_CONFIG_BYTE);
        expect(sframe.length).toBe(plaintexts[i]!.length + 16 + SFRAME_TRAILER_LEN);
        const parsed = readSframeTrailer(sframe);
        expect(parsed.kid).toBe(kid);
        expect(parsed.ctr).toBe(i);
        expect(parsed.codecOffset).toBe(codecOffset);
        sframes.push(sframe);
        ctrToPlain.set(i, plaintexts[i]!);
      }

      // ── FORWARD the real ciphertext bodies through the in-process relay (P5 backbone) ──
      const forwarded = await forwardBodies(0, sframes);

      // GUARD: real media was forwarded + captured (no dead-pipe false-green).
      expect(forwarded.length).toBeGreaterThan(0);

      const sentBodiesB64 = new Set(sframes.map((s) => Buffer.from(s).toString('base64')));
      expect(sentBodiesB64.size).toBe(sframes.length);

      let mediaPackets = 0; // forwarded packets large enough to carry our smallest body
      let byteIdentical = 0; // …whose SFrame body byte-matches a sent real ciphertext
      let realHeaderObserved = 0; // …with the real 14-byte trailer (config 0x01 + KID)
      let decryptedOk = 0; // …that decrypt WITH K_content to an EXACT original plaintext
      let tamperedUndecryptable = 0; // RED-hook: tampered bodies that FAIL AEAD decrypt

      const minBody = 1 + 16 + SFRAME_TRAILER_LEN; // >=1 byte ct + GCM tag + 14-byte trailer
      for (const pkt of forwarded) {
        if (pkt.length < 12 + 4 + 3 + minBody) continue; // skip RTX/padding artifacts
        mediaPackets++;

        // RED hook (P10_FORCE_TAMPER=1): a NON-blind relay that mutated the body in
        // transit — flip the LAST CIPHERTEXT-body byte (the one immediately before the
        // 14-byte trailer) so the body can no longer byte-match a sent body
        // (byteIdentical < mediaPackets) AND fails AEAD decrypt, while the trailer
        // (config 0x01 + KID) stays intact so the trailer-only locator can still find it.
        if (FORCE_TAMPER) {
          const ti = pkt.length - SFRAME_TRAILER_LEN - 1; // last byte of ciphertext||tag
          if (ti >= 0) pkt[ti] = (pkt[ti]! ^ 0xff) & 0xff;
        }

        const found = locateForwardedSframe(pkt, kid, sentBodiesB64);
        if (!found) {
          // Under the RED hook the tampered body won't match the map — locate it by the
          // intact trailer (config 0x01 + KID at the END) and PROVE the mutated ciphertext
          // fails AEAD decrypt (the integrity-failure path, complementing byte-identity).
          if (FORCE_TAMPER) {
            const off = locateSframeHeaderOnly(pkt, kid);
            if (off !== null) {
              const tampered = Uint8Array.prototype.slice.call(pkt.subarray(off));
              await expect(decryptFrame(tampered, keyLookup)).rejects.toThrow();
              tamperedUndecryptable++;
            }
          }
          continue;
        }
        // (a) byte-identity: the relay rewrote only RTP/VP8 HEADER bytes, never the
        // SFrame body — the REAL ciphertext is forwarded verbatim.
        byteIdentical++;
        // (b) real 14-byte trailer observed on the wire (config 0x01 + KID survived,
        // parsed FROM THE END by readSframeTrailer in locateForwardedSframe).
        expect(found.kid).toBe(kid);
        realHeaderObserved++;

        // (c) DECODABLE WITH the key: real decryptFrame under the REAL keyLookup
        // recovers the EXACT original plaintext for this ctr.
        const body = Uint8Array.prototype.slice.call(pkt.subarray(found.bodyOffset));
        const recovered = await decryptFrame(body, keyLookup);
        const expected = ctrToPlain.get(found.ctr);
        expect(expected).toBeDefined();
        expect(Buffer.from(recovered).equals(Buffer.from(expected!))).toBe(true);
        decryptedOk++;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[P10 REQ-MCS-014 positive] forwarded=${forwarded.length} mediaPackets=${mediaPackets} ` +
          `byteIdentical=${byteIdentical} realHeaderObserved=${realHeaderObserved} ` +
          `decryptedOk=${decryptedOk} tamperedUndecryptable=${tamperedUndecryptable} kid=${kid}` +
          (FORCE_TAMPER ? '  [RED HOOK: P10_FORCE_TAMPER=1]' : ''),
      );

      // We forwarded a meaningful number of media packets.
      expect(mediaPackets).toBeGreaterThan(0);
      // (a) EVERY forwarded media packet's real ciphertext body is byte-identical to
      // a sent ciphertext — STRUCTURAL blind forward (relay has no decode/mutate path).
      // RED: P10_FORCE_TAMPER flips a body byte → byteIdentical < mediaPackets → FAIL.
      expect(byteIdentical).toBe(mediaPackets);
      // (b) …and on every one, the REAL 14-byte cleartext trailer survived unchanged.
      expect(realHeaderObserved).toBe(byteIdentical);
      // (c) …and every one decrypted WITH K_content to its EXACT original plaintext.
      expect(decryptedOk).toBe(byteIdentical);

      // (d) NON-VACUOUS — the decrypt is real, not a tautology:
      //   - WITHOUT any key (lookup → null): decryptFrame REJECTS.
      //   - WITH a WRONG independent real K_content (a fresh real keying): REJECTS
      //     (GCM auth failure). This rules out "any key works".
      const sample = sframes[0]!;
      await expect(decryptFrame(sample, () => null)).rejects.toThrow();
      const other = await realKeying();
      await expect(decryptFrame(sample, other.keyLookup)).rejects.toThrow();

      // Sanity: a nonsense body is NOT in the sent set (the comparison is real).
      expect(sentBodiesB64.has(Buffer.from('not-a-real-ciphertext').toString('base64'))).toBe(false);

      // touch senderId so the lint/coverage sees it consumed in an assertion message.
      expect(senderId.length).toBeGreaterThan(0);
    },
    120_000,
  );

  it(
    'NEGATIVE CONTROL: the SAME plaintext WITHOUT SFrame (non-E2EE room) forwards as CLEARTEXT — decodable through the relay with NO key',
    async () => {
      // The load-bearing contrast. A non-E2EE room puts the PLAINTEXT on the wire as
      // the VP8 body (no SFrame, no key). The relay forwards it byte-identically — the
      // SAME relay mechanics as the positive case — but here the forwarded bytes are
      // the cleartext itself, recoverable WITHOUT ANY KEY.
      const plaintexts = [
        new TextEncoder().encode('NEGATIVE-CONTROL cleartext frame ONE — alpha'),
        new TextEncoder().encode('cleartext frame TWO bravo'),
        new TextEncoder().encode('NEGATIVE-CONTROL cleartext frame THREE — charlie charlie charlie'),
      ];

      // A marker prefix so we can locate the cleartext body in the forwarded packet
      // (the analogue of the SFrame header scan — but it is NOT a key, just a
      // delimiter a passive reader could equally use).
      const MARKER = Buffer.from('CLR0', 'ascii'); // 4-byte plaintext marker
      const bodies = plaintexts.map((pt) => Buffer.concat([MARKER, Buffer.from(pt)]));
      const sentBodiesB64 = new Set(bodies.map((b) => b.toString('base64')));

      const forwarded = await forwardBodies(1, bodies);
      expect(forwarded.length).toBeGreaterThan(0);

      let mediaPackets = 0;
      let cleartextRecovered = 0; // forwarded bodies parsed back to a known plaintext WITH NO KEY
      const recoveredPlaintexts = new Set<string>();

      const minBody = MARKER.length + 1;
      for (const pkt of forwarded) {
        if (pkt.length < 12 + 4 + 3 + minBody) continue;
        mediaPackets++;
        // Locate the cleartext body by the plaintext marker (NO key involved).
        let off = -1;
        const scanEnd = Math.min(pkt.length - minBody, 64);
        for (let i = 12; i < scanEnd; i++) {
          if (
            pkt[i] === MARKER[0] && pkt[i + 1] === MARKER[1] &&
            pkt[i + 2] === MARKER[2] && pkt[i + 3] === MARKER[3]
          ) {
            const candidate = pkt.subarray(i).toString('base64');
            if (sentBodiesB64.has(candidate)) { off = i; break; }
          }
        }
        if (off < 0) continue;
        const body = pkt.subarray(off);
        // RECOVER the plaintext with NO key, NO decrypt — just strip the marker and
        // read the bytes. This is exactly what a relay (or any passive observer) can
        // do to a non-E2EE stream, and is the contrast that gives P10 its meaning.
        const recovered = body.subarray(MARKER.length).toString('utf8');
        expect(plaintexts.some((pt) => new TextDecoder().decode(pt) === recovered)).toBe(true);
        recoveredPlaintexts.add(recovered);
        cleartextRecovered++;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[P10 REQ-MCS-014 negative-control] forwarded=${forwarded.length} mediaPackets=${mediaPackets} ` +
          `cleartextRecovered=${cleartextRecovered} distinctPlaintexts=${recoveredPlaintexts.size}`,
      );

      // Real media flowed.
      expect(mediaPackets).toBeGreaterThan(0);
      // EVERY forwarded media packet's body was the cleartext — recovered WITHOUT a
      // key. THIS is the contrast: identical relay mechanics, but a non-E2EE payload
      // is readable on the wire while the real SFrame ciphertext (positive case) is
      // not (without K_content). The relay is byte-blind either way; E2EE is what
      // makes the bytes meaningless to a reader without the key.
      expect(cleartextRecovered).toBe(mediaPackets);
      // We genuinely recovered the original plaintexts (not a vacuous always-true).
      expect(recoveredPlaintexts.size).toBeGreaterThan(0);
      for (const r of recoveredPlaintexts) {
        expect(plaintexts.some((pt) => new TextDecoder().decode(pt) === r)).toBe(true);
      }
    },
    120_000,
  );
});
