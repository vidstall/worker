/**
 * REQ-CFA-003 / REQ-CFA-009 / INV-A — Canary forwarding-integrity verifier
 * (validator-daemon, receiver-side equality, NO relay cooperation).
 *
 * The load-bearing INV-A proof: a content-blind relay forwards canary frames
 * BIT-EXACT. The verifier holds the per-cell `cellSecret` (the SAME out-of-band
 * factor the covert publisher used) and therefore re-derives K_canary +
 * recomputes the EXACT canary ciphertext stream LOCALLY. It then byte-compares
 * each locally-recomputed C_i against the bytes the relay forwarded. Ground-truth
 * lives entirely at the verifier — the relay is never asked to attest anything.
 *
 * DETECTION MODEL (hermetic in-order leg):
 *   - The expected counter sequence is DRIVEN LOCALLY (`expectedCtrs`), NOT read
 *     from the wire. A tampering relay can rewrite the cleartext trailer CTR, so
 *     the trailer CTR is NEVER trusted for DETECTION — it is used ONLY as a
 *     secondary hint to classify a non-match as tamper-vs-drop.
 *   - For each LOCAL expected ctr we recompute C_i = encryptFrame(P_i, {kid,ctr},
 *     K_canary, codecOffset). AES-GCM is deterministic for a fixed
 *     (key, IV=[kid|ctr], AAD, plaintext), so the recomputed bytes are the EXACT
 *     bytes the honest publisher put on the wire.
 *       · a byte-identical forwarded body exists for C_i  ⇒ forwarded intact.
 *       · NO byte-identical body for C_i, but a forwarded frame DOES carry that
 *         ctr in its (relay-readable) trailer ⇒ TAMPER (expectedHash≠observedHash).
 *       · NO forwarded frame carries that ctr at all ⇒ DROP (observedHash
 *         'MISSING'), detected via the LOCAL expected-ctr gap, not the trailer.
 *
 * COVERTNESS (inherited from keying.ts): K_canary = HKDF(IKM=K_room,
 * salt=cellSecret, info=…|snd=CANARY_SENDER_ID) — the Path C salt-mix (cellSecret
 * is the SALT, not the IKM). cellSecret is the load-bearing covert factor: a relay
 * / non-cell member holds K_room but NOT cellSecret, so it derives a DIFFERENT key
 * (Path A, empty salt) and cannot reproduce C_i — it cannot forge a byte-identical
 * canary frame to evade detection. CANARY_SENDER_ID domain-separates K_canary from
 * every real publisher's K_content, so (K_room, cellSecret) reveals ONLY the
 * synthetic canary stream, never real call media (INV-B content-blind).
 *
 * PURITY: this module takes captured Buffers + cellSecret and is unit-testable
 * WITHOUT mediasoup. It reuses the SHIPPED client crypto (encryptFrame /
 * readSframeTrailer / SFRAME_TRAILER_LEN) verbatim — NOTHING is reimplemented.
 *
 * LOGGING (HARD-GATE): NEVER log key material, cellSecret, P_i, or K_canary. Only
 * { canaryKid, mediaPackets, byteIdentical, divergences } via structured logging.
 */

import { createHash, createHmac } from 'node:crypto';
// Cross-repo import (Mechanism A, mirrors keying.ts + the relay integration test):
// 6-level `../` from apps/validator-daemon/src/canary -> the client crypto lib.
import {
  encryptFrame,
  readSframeTrailer,
  SFRAME_TRAILER_LEN,
  codecOffsetForFrameType,
} from '../../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';
import { createLogger } from '@dvconf/shared';
import { deriveCanaryKey, type CanaryKeyInput } from './keying.js';

const MOD = 'canary/verifier';
const log = createLogger(MOD);

/** Domain separator folded into the canary PRF seed (distinct from the HKDF info). */
const CANARY_SEED_LABEL = 'dvconf-canary/seed/v1';
/** AES-GCM authentication tag length (bytes) — appended to the ciphertext by WebCrypto. */
const GCM_TAG_LEN = 16;
/**
 * Per-frame plaintext length. HMAC-SHA256 yields 32 bytes, so this is <= 32 (a longer
 * value would silently truncate to 32). It is >= MAX_CODEC_OFFSET (10), so the pinned
 * keyframe codecOffset is a FIXED 10 → the AAD (clearPrefix||trailer) is deterministic.
 */
export const CANARY_FRAME_LEN = 32;
/**
 * On-wire length of every canary SFrame: clearPrefix(codecOffset) + ciphertext(|pt|-
 * codecOffset) + GCM tag(16) + trailer(14) = |pt| + 16 + 14 (codecOffset cancels). All
 * canary frames are this FIXED length, so the verifier extracts the SFrame body as the
 * LAST `CANARY_SFRAME_LEN` bytes of a forwarded packet — no fragile offset scan (the
 * trailer parses from the end at ANY offset, so a scan is ambiguous, M2 lesson).
 */
export const CANARY_SFRAME_LEN = CANARY_FRAME_LEN + GCM_TAG_LEN + SFRAME_TRAILER_LEN;

/** One detected forwarding divergence for a single expected canary frame. */
export interface CanaryDivergence {
  /** The LOCALLY-driven expected counter (frame sequence) that diverged. */
  frameSeq: number;
  /** SHA-256 hex of the locally-recomputed expected ciphertext C_i. */
  expectedHash: string;
  /** SHA-256 hex of the forwarded body bearing this ctr, or 'MISSING' on a drop. */
  observedHash: string;
}

export interface VerifyResult {
  /** Forwarded canary media packets considered (large enough to carry a body). */
  mediaPackets: number;
  /** Expected ctrs whose recomputed C_i had a byte-identical forwarded match. */
  byteIdentical: number;
  /** Per-frame divergences (tamper: hashes differ; drop: observedHash 'MISSING'). */
  divergences: CanaryDivergence[];
}

export interface VerifyInput {
  kRoom: Uint8Array;
  roomId: string;
  cellSecret: Uint8Array;
  canaryKid: number;
  /** LOCALLY-driven expected counter sequence (the canonical canary frame order). */
  expectedCtrs: number[];
}

/**
 * Deterministic canary seed from the per-cell OOB secret. NOT a key — the
 * AES-GCM key is K_canary (deriveCanaryKey); this seed only drives the public
 * plaintext PRF so the verifier can reproduce P_i. Domain-separated from the
 * HKDF `info` by its own label so the two never collide.
 */
export function deriveCanarySeed(cellSecret: Uint8Array): Uint8Array {
  return createHash('sha256')
    .update(Buffer.from(CANARY_SEED_LABEL))
    .update(Buffer.from(cellSecret))
    .digest();
}

/**
 * Deterministic canary plaintext P_i = HMAC-SHA256(canarySeed, u32-BE(i)),
 * truncated to CANARY_FRAME_LEN. Same (cellSecret, ctr) ⇒ same P_i on both the
 * publisher and the verifier, so the recomputed ciphertext is byte-exact.
 */
export function canaryPlaintext(canarySeed: Uint8Array, ctr: number): Uint8Array {
  const idx = Buffer.alloc(4);
  idx.writeUInt32BE(ctr >>> 0, 0);
  const mac = createHmac('sha256', Buffer.from(canarySeed)).update(idx).digest();
  return new Uint8Array(mac.subarray(0, CANARY_FRAME_LEN));
}

/**
 * Recompute the EXACT canary SFrame C_i for one ctr from cellSecret only — the
 * same call the covert publisher makes. codecOffset is pinned by frame kind 'key'
 * + length (a fixed 10 for CANARY_FRAME_LEN >= 10), so the AAD is deterministic.
 */
export async function recomputeCanaryFrame(
  input: Omit<VerifyInput, 'expectedCtrs'>,
  canarySeed: Uint8Array,
  ctr: number,
): Promise<Uint8Array> {
  const keyInput: CanaryKeyInput = {
    kRoom: input.kRoom,
    roomId: input.roomId,
    canaryKid: input.canaryKid,
    cellSecret: input.cellSecret,
  };
  const kCanary = await deriveCanaryKey(keyInput);
  const plaintext = canaryPlaintext(canarySeed, ctr);
  const codecOffset = codecOffsetForFrameType('key', plaintext.length);
  return encryptFrame(plaintext, { kid: input.canaryKid, ctr }, kCanary, codecOffset);
}

const sha256Hex = (b: Uint8Array): string =>
  createHash('sha256').update(Buffer.from(b)).digest('hex');

/**
 * Extract the canary SFrame body from a forwarded VP8 RTP packet as the LAST
 * `CANARY_SFRAME_LEN` bytes (every canary frame is that FIXED length), then parse its
 * key-free trailer. The trailer parses from the END at ANY offset, so a forward offset
 * scan is ambiguous (M2 lesson) — the deterministic fixed length pins the body exactly.
 * Returns the body bytes + the (relay-readable, UNTRUSTED-for-detection) trailer ctr if
 * the trailer carries our canaryKid, else null (foreign/short packet).
 */
function extractCanaryBody(
  pkt: Buffer,
  canaryKid: number,
): { body: Buffer; trailerCtr: number } | null {
  if (pkt.length < 12 + CANARY_SFRAME_LEN) return null; // too short to hold a canary body
  const body = pkt.subarray(pkt.length - CANARY_SFRAME_LEN);
  try {
    const trailer = readSframeTrailer(body);
    if (trailer.kid !== (canaryKid >>> 0)) return null;
    return { body: Buffer.from(body), trailerCtr: trailer.ctr };
  } catch {
    return null; // trailing region is not our trailer (config byte / kid mismatch)
  }
}

/**
 * Receiver-side equality: recompute each expected C_i LOCALLY and byte-compare it
 * against the relay-forwarded bodies. Returns byteIdentical / mediaPackets / the
 * per-frame divergence list. No relay cooperation — the verifier IS the ground truth.
 *
 * DETECTION is driven by the LOCAL `expectedCtrs`, NOT the wire trailer:
 *   - byte-identical recomputed C_i present on the wire ⇒ forwarded intact.
 *   - absent, but a forwarded frame carries that ctr (trailer hint) ⇒ TAMPER.
 *   - absent entirely ⇒ DROP ('MISSING').
 */
export async function verifyForwardedCanary(
  captured: Buffer[],
  input: VerifyInput,
): Promise<VerifyResult> {
  const canarySeed = deriveCanarySeed(input.cellSecret);

  // Recompute the LOCAL expected canary set ONCE (the ground truth — built only from
  // cellSecret + the local ctr sequence, never from the wire): the byte-identical match
  // set + the per-ctr observed body for tamper/drop classification.
  const expectedB64 = new Set<string>();
  const expectedHashByCtr = new Map<number, string>();
  for (const ctr of input.expectedCtrs) {
    const expected = await recomputeCanaryFrame(input, canarySeed, ctr);
    expectedB64.add(Buffer.from(expected).toString('base64'));
    expectedHashByCtr.set(ctr, sha256Hex(expected));
  }

  // Scan forwarded canary bodies (keyed off our canaryKid; foreign frames ignored).
  //   - mediaPackets / byteIdentical: per-PACKET forwarding-integrity (each forwarded
  //     body byte-matches SOME local expected C_i — the M2 authoritative-locator pattern;
  //     relay-independent because the expected set is local).
  //   - observedByCtr: trailer-ctr → observed body (hint-only, for tamper/drop
  //     classification; the trailer ctr is NEVER trusted for the detection itself).
  let mediaPackets = 0;
  let byteIdentical = 0;
  const observedByCtr = new Map<number, Buffer>();
  for (const pkt of captured) {
    const found = extractCanaryBody(pkt, input.canaryKid);
    if (!found) continue;
    mediaPackets++;
    if (expectedB64.has(found.body.toString('base64'))) byteIdentical++;
    if (!observedByCtr.has(found.trailerCtr)) observedByCtr.set(found.trailerCtr, found.body);
  }

  // DETECTION — driven by the LOCAL expected ctr sequence, NOT the wire trailer:
  //   byte-identical recomputed C_i present ⇒ intact; absent + a frame carries that ctr
  //   ⇒ TAMPER; absent entirely ⇒ DROP ('MISSING').
  const observedBodiesB64 = new Set([...observedByCtr.values()].map((b) => b.toString('base64')));
  const divergences: CanaryDivergence[] = [];
  for (const ctr of input.expectedCtrs) {
    const expectedHash = expectedHashByCtr.get(ctr)!;
    const observed = observedByCtr.get(ctr);
    // Intact iff the recomputed C_i for this ctr was forwarded byte-identical.
    const intact = observed !== undefined && expectedB64.has(observed.toString('base64'));
    if (intact) continue;
    // Cross-check the local match set in case this ctr's frame was forwarded but its
    // trailer ctr was rewritten (the recomputed C_i still appears under some OTHER ctr).
    const expectedForThisCtr = expectedHash;
    const presentByBytes = [...observedBodiesB64].some(
      (b) => sha256Hex(Buffer.from(b, 'base64')) === expectedForThisCtr,
    );
    if (presentByBytes) continue;
    divergences.push({
      frameSeq: ctr,
      expectedHash,
      observedHash: observed ? sha256Hex(observed) : 'MISSING',
    });
  }

  log.info(
    { canaryKid: input.canaryKid, mediaPackets, byteIdentical, divergences: divergences.length },
    'canary forwarding verified',
  );
  return { mediaPackets, byteIdentical, divergences };
}
