/**
 * Browser-safe canary 62-byte SFrame builder for M2b-live-WAN Sub-lane A (REQ-MLW-A-01/02).
 *
 * REUSES the SHIPPED client crypto VERBATIM — the SAME modules the daemon verifier
 * cross-imports — so byte-identity to `recomputeCanaryFrame` (verifier.ts:136-151) holds
 * BY CONSTRUCTION:
 *   - `encryptFrame` + `codecOffsetForFrameType` from `…/webrtc/sframe-transform`
 *   - `PathCKeyDerivation` from `…/crypto/e2ee-spike`
 * and REIMPLEMENTS ONLY the two trivial daemon PRF fns (`deriveCanarySeed`=SHA-256,
 * `canaryPlaintext`=HMAC-SHA256[:32]) on WebCrypto, because the daemon versions use
 * `node:crypto` (NOT browser-safe). This module is browser-PURE: only `crypto.subtle`,
 * `Uint8Array`, `TextEncoder`, `DataView` — NO node:crypto / node:fs / Buffer / require.
 *
 * The 4-step pinned pipeline (mirrors verifier.ts recomputeCanaryFrame EXACTLY):
 *   1. seed     = SHA-256( utf8('dvconf-canary/seed/v1') ‖ cellSecret )                (32B)
 *      (two daemon .update() calls = byte-equiv to a single concat'd digest)
 *   2. P_i      = HMAC-SHA256( key=seed, msg=u32BE(ctr) )[0:32]                        (32B)
 *      (ctr is u32 BIG-ENDIAN — a little-endian slip breaks byte-id; the unit catches it)
 *   3. K_canary = PathCKeyDerivation().deriveContentKey({ kRoom, roomId, kid:canaryKid,
 *                   senderId:'dvconf-canary/v1', oobSecret:cellSecret })               (AES-GCM-256)
 *      (Path C: IKM=kRoom, salt=cellSecret, info=dvconf-e2ee/v1|roomId|kid|snd=senderId)
 *   4. C_i      = encryptFrame(P_i, {kid:canaryKid, ctr}, K_canary, codecOffset=10)    (62B)
 *      (codecOffsetForFrameType('key', 32) = min(MAX_CODEC_OFFSET=10, 32) = 10)
 *
 * Byte-identity vs recomputeCanaryFrame for ctr 0..7 is asserted (run in Node WebCrypto)
 * in canary-frame-browser.byteid.test.ts (REQ-MLW-A-02). The pinned strings below are
 * LOAD-BEARING — any divergence flips the unit RED.
 *
 * IMPORT DEPTH (verified vs the filesystem, NOT copied from the plan): this module sits at
 * scripts/bench/m2b-canary-browser/, so the client lib is 4 ups → workspace root → dvconf-client.
 * The `.js` specifier is what tsc/vitest resolve (the Task-0 harness uses the SAME path with a
 * `.ts` specifier under the esbuild loader).
 *
 * LOGGING (HARD-GATE): NEVER log cellSecret / K_canary / P_i. This module emits NO logs.
 */
import {
  encryptFrame,
  codecOffsetForFrameType,
} from '../../../../dvconf-client/src/lib/webrtc/sframe-transform.js';
import { PathCKeyDerivation } from '../../../../dvconf-client/src/lib/crypto/e2ee-spike.js';

/** keying.ts:44 — load-bearing for the HKDF info (`…|snd=dvconf-canary/v1`). */
const CANARY_SENDER_ID = 'dvconf-canary/v1';
/** verifier.ts:60 — folded into the SHA-256 seed (distinct from the HKDF info). */
const CANARY_SEED_LABEL = 'dvconf-canary/seed/v1';
/** verifier.ts:68 — HMAC-SHA256 is 32B, so the [:32] truncation is a no-op. */
const CANARY_FRAME_LEN = 32;

/** WebCrypto SubtleCrypto — present on Node ≥20 globalThis AND every secure browser context. */
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();

/** 4-byte BIG-ENDIAN encoding of a u32 — the HMAC message for `canaryPlaintext`. */
const u32be = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false); // BIG-ENDIAN (pin #2)
  return b;
};

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const total = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let off = 0;
  for (const x of parts) {
    total.set(x, off);
    off += x.length;
  }
  return total;
};

/**
 * Copy into a fresh `Uint8Array<ArrayBuffer>` so it satisfies WebCrypto's `BufferSource`
 * (TS lib.dom narrows `Uint8Array<ArrayBufferLike>` away from `BufferSource`). MIRRORS the
 * client e2ee-spike `bufferView` helper exactly — browser-pure (no Buffer / node:crypto).
 */
const bufferView = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
};

/**
 * REIMPLEMENT (WebCrypto) of verifier.ts:112-117 — SHA-256(label ‖ cellSecret), NO
 * length-prefix / separator (the daemon's two `.update()` calls concatenate identically).
 */
async function canarySeed(cellSecret: Uint8Array): Promise<Uint8Array> {
  // `concat` already returns Uint8Array<ArrayBuffer> (satisfies BufferSource).
  return new Uint8Array(
    await subtle.digest('SHA-256', concat(te.encode(CANARY_SEED_LABEL), cellSecret)),
  );
}

/**
 * REIMPLEMENT (WebCrypto) of verifier.ts:124-129 — HMAC-SHA256(seed, u32BE(ctr))[:32].
 */
async function canaryPlaintext(seed: Uint8Array, ctr: number): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', bufferView(seed), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = new Uint8Array(await subtle.sign('HMAC', key, bufferView(u32be(ctr))));
  return mac.subarray(0, CANARY_FRAME_LEN);
}

/**
 * Build the EXACT 62-byte canary SFrame for one ctr — byte-identical to the daemon's
 * `recomputeCanaryFrame`. `senderId` enters ONLY via the HKDF info inside step 3; it is NOT
 * a frame-header field, so `encryptFrame`'s header is just `{ kid, ctr }`.
 */
export async function buildCanaryFrameBrowser(input: {
  kRoom: Uint8Array;
  roomId: string;
  cellSecret: Uint8Array;
  canaryKid: number;
  ctr: number;
}): Promise<Uint8Array> {
  const seed = await canarySeed(input.cellSecret); // step 1
  const plaintext = await canaryPlaintext(seed, input.ctr); // step 2 (32B P_i)
  const kCanary = await new PathCKeyDerivation().deriveContentKey({
    // step 3 — REUSED client class; Path C salt=cellSecret, IKM=kRoom
    kRoom: input.kRoom,
    roomId: input.roomId,
    kid: input.canaryKid,
    senderId: CANARY_SENDER_ID,
    oobSecret: input.cellSecret,
  });
  // step 4 — REUSED client encryptFrame; codecOffsetForFrameType('key', 32) = 10
  return encryptFrame(
    plaintext,
    { kid: input.canaryKid, ctr: input.ctr },
    kCanary,
    codecOffsetForFrameType('key', CANARY_FRAME_LEN),
  );
}
