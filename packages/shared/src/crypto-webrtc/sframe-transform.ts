/**
 * Vendored from services/client/client/src/lib/webrtc/sframe-transform.ts —
 * keep byte-identical (below the import line). The canary verifier's
 * security property depends on this matching the shipped client crypto
 * exactly ("reuses the SHIPPED client crypto verbatim — NOTHING is
 * reimplemented"). Resync manually if the client's version changes.
 */

/**
 * REQ-MCS-010 (P2) + REQ-MCS-014 (M3 Lane B) — partial-SFrame transform codec
 * (Content E2EE, Option A — keying-agnostic codec).
 *
 * The pure, Node-testable SFrame encrypt/decrypt core that the Encoded-Transform
 * shim (`encoded-transform-shim.ts`) drives over a peer connection.
 *
 * M3 LANE B — PARTIAL-SFrame (single wire format, no mode flag). The P2 codec
 * PREPENDED [config|kid|ctr] to the FRONT of the frame, displacing the VP8 payload
 * header at offset 0, so the SFU read our 0x01 config byte as the VP8 frame-tag and
 * never detected a keyframe (forwarded 0 packets — P10 Finding B). The fix is the
 * WebRTC insertable-streams codec-aware partial pattern (grounded in RFC 6386 §9.1 +
 * RFC 7741 §4.3 — VP8 uncompressed-header markers; NOT "RFC 9605 partial-SFrame",
 * which AEADs the whole payload): keep the CLEARTEXT VP8 codec prefix at the FRONT,
 * encrypt the rest, move the metadata to a TRAILER.
 *
 * ON-WIRE LAYOUT (replaces the old prepend-header layout):
 *   [ cleartext codec prefix (codecOffset bytes) ]    <- SFU reads VP8 markers here (offset 0)
 *   [ AES-GCM(body) = ciphertext || 16-byte GCM tag ] <- WebCrypto atomic output, kept intact
 *   [ trailer (14 bytes): config:0x01(1) | kid:u32-BE(4) | ctr:u64-BE(8) | codecOffset:u8(1) ]
 *
 * The cleartext prefix AND the trailer are bound as AAD, so a relay reads the VP8
 * keyframe markers + KID/CTR routing metadata but CANNOT forge them (RFC 9605 binds
 * the header into the AEAD; we extend that to the prefix + trailer here).
 *
 * DRY: K_content is an AES-GCM CryptoKey derived from K_room by `PathAKeyDerivation`
 * (e2ee-spike.ts). This codec CONSUMES that key; it does NOT derive keys. The receiver
 * key store is the SHIPPED `KidKeyStore` (KID→key across a rekey grace window).
 *
 * CRYPTO SAFETY — NONCE UNIQUENESS (the core property): AES-GCM is catastrophically
 * broken if a (key, IV) pair EVER repeats. The 12-byte IV = [ kid:u32-BE | ctr:u64-BE ]
 * carries NO sender identity, so its uniqueness rests on the KEY being PER-SENDER:
 *   - PER-SENDER KEY (D-M2-21 — the load-bearing precondition): in the shared-key SFU
 *     room every publisher unwraps the SAME K_room, so K_content MUST be derived per
 *     publisher (`PathAKeyDerivation` folds senderId into the HKDF info). Two
 *     publishers then hold DIFFERENT K_content, so their identical IV=[kid|ctr] is
 *     paired with a different key — no reuse. A sender-INDEPENDENT key would make
 *     Publisher A frame#0 and B frame#0 reuse one (key, IV) → catastrophic nonce reuse.
 *   - PER-FRAME CTR: within one (sender, KID) the CTR is strictly increasing, so
 *     (key, IV) never repeats; the caller MUST never reuse a CTR under one key.
 * NOTE: per-sender keying gives nonce safety, NOT per-sender AUTHENTICATION — any
 * member can derive any sender's K_content from the shared K_room (impersonation
 * stays an MLS/M3 concern, D-M2-5).
 *
 * CRYPTO-CLAIM DISCIPLINE (D-M2-8): this codec is keying-agnostic — NO forward-secrecy
 * / PCS, and it makes no validator-exclusion claim ITSELF. It provides AES-GCM frame
 * confidentiality + integrity ONLY, consuming whatever K_content the KeyManager hands
 * it. Cryptographic validator-exclusion now lives one layer up at the KEYING choke
 * point: Path C (Lane D Phase 2) is WIRED, so for a high-privacy INVITE room the
 * KeyManager derives a divergent K_content from the OOB salt and a covertly-admitted
 * in-room validator (K_room but no OOB) AES-GCM-fails on these frames — a STRUCTURAL
 * exclusion (to our knowledge novel / argued-from-absence). Open rooms + Path A stay
 * content-blind by ECONOMICS, not crypto; the relay is structurally blind in ALL modes;
 * content security depends on keeping the invite link secret.
 *
 * LOGGING (HARD-GATE): NEVER log K_content, the IV, frame plaintext, or any key
 * material. Log only { kid, ctr, byteLength, codecOffset } via `clientLog`.
 */

import { clientLog } from './log.js';

const MOD = 'webrtc/sframe-transform';

/** AES-GCM authentication tag length (bits) — 128-bit (16-byte) tag, appended by WebCrypto. */
const GCM_TAG_BITS = 128;
/** AES-GCM authentication tag length (bytes) — appended to the ciphertext by WebCrypto. */
const GCM_TAG_LEN = 16;

/** Trailer byte layout (M3 partial-SFrame). config byte is key-independent, relay-readable. */
const CONFIG_BYTE = 0x01; // version/config marker (1 byte)
const TRAILER_CONFIG_LEN = 1; // config byte
const TRAILER_KID_LEN = 4; // KID as u32-BE (membership epoch; fits the demo range)
const TRAILER_CTR_LEN = 8; // CTR as u64-BE (per-frame counter)
const TRAILER_OFFSET_LEN = 1; // codecOffset as u8 (cleartext-prefix length, self-locating)
/** Total trailer length appended to every SFrame (replaces the old front header). */
export const SFRAME_TRAILER_LEN =
  TRAILER_CONFIG_LEN + TRAILER_KID_LEN + TRAILER_CTR_LEN + TRAILER_OFFSET_LEN; // 14

/** IV (AES-GCM nonce) length — 96-bit / 12-byte, the GCM-recommended size. */
export const SFRAME_IV_LEN = 12;

/**
 * The encoded-frame types we map to a cleartext codec-prefix length. A keyframe
 * exposes more uncompressed VP8 header bytes (RFC 6386 §9.1) than a delta frame
 * (RFC 7741 §4.3); 'empty'/undefined keep a single cleartext byte.
 */
export type FrameKind = 'key' | 'delta' | 'empty';

/**
 * Cleartext codec-prefix length the SFU needs to read VP8 keyframe markers at offset 0:
 *   - 'key'   → 10 bytes (VP8 uncompressed keyframe header, RFC 6386 §9.1)
 *   - 'delta' → 3 bytes  (VP8 uncompressed interframe header, RFC 7741 §4.3)
 *   - 'empty' / undefined → 1 byte
 * Then CLAMP to `frameLen` so a very short / empty frame never asks to keep more
 * cleartext than it has (the body to encrypt = frameData.subarray(codecOffset);
 * when empty, AES-GCM over empty plaintext yields just the tag — fine).
 */
/**
 * Max cleartext codec-prefix length — a VP8 keyframe uncompressed header (RFC 6386
 * §9.1). The decrypt validator bounds `codecOffset` to `[0, MAX_CODEC_OFFSET]` in
 * lockstep with this helper so a CLAMPED short-frame offset (e.g. a 4-byte key frame →
 * 4, a 2-byte delta frame → 2) still round-trips. `codecOffset` is AAD-bound, so a
 * relay cannot forge it to mis-slice.
 */
export const MAX_CODEC_OFFSET = 10;

export function codecOffsetForFrameType(type: FrameKind | undefined, frameLen: number): number {
  const base = type === 'key' ? MAX_CODEC_OFFSET : type === 'delta' ? 3 : 1;
  return Math.min(base, frameLen);
}

/**
 * Narrow a `Uint8Array` to an `ArrayBuffer`-backed view at the WebCrypto boundary.
 * TS 5.7+ types a bare `Uint8Array` as `Uint8Array<ArrayBufferLike>` (possibly a
 * `SharedArrayBuffer`), which WebCrypto's `BufferSource` rejects. Mirrors the
 * `bufferView` helper in `e2ee-spike.ts`.
 */
function bufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** Per-frame metadata written in cleartext (relay reads these key-free). */
export interface FrameHeader {
  /** Key ID = our membership epoch (CONTRACTS §2). u32 range in the short-form trailer. */
  kid: number;
  /** Per-frame counter — MUST be strictly increasing per (key); (kid,ctr) is never reused. */
  ctr: number;
}

/** Parsed trailer: the FrameHeader plus the self-locating cleartext-prefix length. */
export interface ParsedTrailer extends FrameHeader {
  /** Length of the cleartext codec prefix kept at the front of the frame. */
  codecOffset: number;
}

/**
 * Receiver key-selection shape. The SHIPPED `KidKeyStore` (e2ee-spike.ts) returns
 * raw K_room bytes per KID; in production the KeyManager wraps it to return the
 * DERIVED K_content `CryptoKey` for a KID (across the grace window). This codec only
 * needs "give me the K_content CryptoKey for this KID, or null if I can't decrypt it".
 */
export type KeyLookup = (kid: number, nowMs: number) => Promise<CryptoKey | null> | (CryptoKey | null);

/**
 * Write the 14-byte cleartext SFrame TRAILER:
 *   [ config:1 | kid:u32-BE | ctr:u64-BE | codecOffset:u8 ].
 * No key material — the relay parses this for routing + M1 layer-select on ciphertext.
 * KID/CTR/codecOffset are plain integers, NOT secrets.
 */
export function writeSframeTrailer({ kid, ctr }: FrameHeader, codecOffset: number): Uint8Array {
  const trailer = new Uint8Array(SFRAME_TRAILER_LEN);
  const view = new DataView(trailer.buffer);
  trailer[0] = CONFIG_BYTE;
  view.setUint32(TRAILER_CONFIG_LEN, kid >>> 0, false); // big-endian KID
  // u64 CTR as two u32 halves (JS numbers are safe to 2^53; ctr stays well below).
  view.setUint32(TRAILER_CONFIG_LEN + TRAILER_KID_LEN, Math.floor(ctr / 0x1_0000_0000) >>> 0, false);
  view.setUint32(TRAILER_CONFIG_LEN + TRAILER_KID_LEN + 4, ctr >>> 0, false);
  trailer[SFRAME_TRAILER_LEN - 1] = codecOffset & 0xff;
  return trailer;
}

/**
 * Parse the cleartext SFrame trailer FROM THE END of the buffer WITHOUT the key (what
 * the relay can do). Returns { kid, ctr, codecOffset } — codecOffset is authoritative,
 * so the receiver never needs `frame.type`. Throws on a too-short buffer or an
 * unrecognised config byte.
 */
export function readSframeTrailer(sframeBytes: Uint8Array): ParsedTrailer {
  if (sframeBytes.length < SFRAME_TRAILER_LEN) {
    throw new Error('SFrame: buffer too short for cleartext trailer');
  }
  const start = sframeBytes.length - SFRAME_TRAILER_LEN;
  if (sframeBytes[start] !== CONFIG_BYTE) {
    throw new Error(`SFrame: unexpected config byte 0x${sframeBytes[start].toString(16)}`);
  }
  const view = new DataView(sframeBytes.buffer, sframeBytes.byteOffset + start, SFRAME_TRAILER_LEN);
  const kid = view.getUint32(TRAILER_CONFIG_LEN, false);
  const ctrHi = view.getUint32(TRAILER_CONFIG_LEN + TRAILER_KID_LEN, false);
  const ctrLo = view.getUint32(TRAILER_CONFIG_LEN + TRAILER_KID_LEN + 4, false);
  const ctr = ctrHi * 0x1_0000_0000 + ctrLo;
  const codecOffset = sframeBytes[sframeBytes.length - 1];
  return { kid, ctr, codecOffset };
}

/**
 * Derive the 96-bit AES-GCM IV from (kid, ctr): IV = [ kid:u32-BE | ctr:u64-BE ].
 * UNCHANGED from P2. Deterministic so the receiver reconstructs it from the trailer.
 * The IV carries NO sender id, so it is unique per (key, frame) ONLY because the KEY
 * is per-sender (D-M2-21) AND the CTR is unique within a (sender, KID). NEVER log this
 * value (it is paired with the key).
 */
export function deriveFrameIv({ kid, ctr }: FrameHeader): Uint8Array {
  const iv = new Uint8Array(SFRAME_IV_LEN);
  const view = new DataView(iv.buffer);
  view.setUint32(0, kid >>> 0, false);
  view.setUint32(4, Math.floor(ctr / 0x1_0000_0000) >>> 0, false);
  view.setUint32(8, ctr >>> 0, false);
  return iv;
}

/**
 * AAD = clearPrefix(codecOffset bytes) || trailerBytes(14). Binding BOTH the cleartext
 * codec prefix and the trailer means a relay can READ the VP8 keyframe markers + the
 * KID/CTR/codecOffset metadata but CANNOT forge either without breaking decryption.
 * Both encrypt and decrypt reconstruct the SAME AAD from the same two regions.
 */
function buildAad(clearPrefix: Uint8Array, trailer: Uint8Array): Uint8Array {
  const aad = new Uint8Array(clearPrefix.length + trailer.length);
  aad.set(clearPrefix, 0);
  aad.set(trailer, clearPrefix.length);
  return aad;
}

/**
 * Encrypt one encoded frame as partial-SFrame: keep the first `codecOffset` bytes
 * cleartext (the VP8 codec prefix the SFU reads), AES-GCM-encrypt the rest, append a
 * 14-byte trailer. Output = [ clearPrefix || ciphertext || GCM tag || trailer ].
 *
 * The cleartext prefix AND the trailer are bound as AAD (see `buildAad`), so the relay
 * reads the keyframe markers + metadata but cannot forge them.
 */
export async function encryptFrame(
  plainFrameData: Uint8Array,
  header: FrameHeader,
  kContent: CryptoKey,
  codecOffset: number,
): Promise<Uint8Array> {
  const clearPrefix = plainFrameData.subarray(0, codecOffset);
  const body = plainFrameData.subarray(codecOffset);
  const trailer = writeSframeTrailer(header, codecOffset);
  const iv = deriveFrameIv(header);
  const aad = buildAad(clearPrefix, trailer);
  const cipherBuf = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: bufferView(iv),
      additionalData: bufferView(aad),
      tagLength: GCM_TAG_BITS,
    },
    kContent,
    bufferView(body),
  );
  const cipher = new Uint8Array(cipherBuf); // ciphertext || tag (WebCrypto appends the tag)
  const out = new Uint8Array(clearPrefix.length + cipher.length + trailer.length);
  out.set(clearPrefix, 0);
  out.set(cipher, clearPrefix.length);
  out.set(trailer, clearPrefix.length + cipher.length);
  clientLog.info(MOD, 'encrypted frame', {
    kid: header.kid,
    ctr: header.ctr,
    byteLength: out.length,
    codecOffset,
  });
  return out;
}

/**
 * Parse the trailer FROM THE END → (kid, ctr, codecOffset); validate it; select
 * K_content for that KID via the grace-window-aware `keyLookup`; reconstruct the IV +
 * AAD; AES-GCM decrypt the body; re-prepend the cleartext prefix → the FULL original
 * frame. The receiver MUST NOT depend on `frame.type` — codecOffset is authoritative
 * from the trailer. Throws on a malformed trailer, an unknown KID, or a wrong/absent
 * key / tampered prefix-or-trailer (GCM auth failure) — the caller drops the frame.
 *
 * @param nowMs injectable clock for the grace-window lookup (defaults to Date.now()).
 */
export async function decryptFrame(
  sframeBytes: Uint8Array,
  keyLookup: KeyLookup,
  nowMs: number = Date.now(),
): Promise<Uint8Array> {
  const trailer = readSframeTrailer(sframeBytes); // key-free parse FROM THE END
  const { kid, ctr, codecOffset } = trailer;
  // Bound to [0, MAX_CODEC_OFFSET] in lockstep with codecOffsetForFrameType — a clamped
  // short-frame offset (e.g. a 4-byte key frame → 4) MUST round-trip, not be dropped.
  // codecOffset is AAD-bound (a relay cannot forge it to mis-slice) and the length guard
  // below bounds it against the actual buffer.
  if (codecOffset < 0 || codecOffset > MAX_CODEC_OFFSET) {
    throw new Error(`SFrame: invalid codecOffset ${codecOffset}`);
  }
  // codecOffset (cleartext prefix) + GCM tag + trailer must all fit; else too short.
  if (codecOffset > sframeBytes.length - SFRAME_TRAILER_LEN - GCM_TAG_LEN) {
    throw new Error('SFrame: buffer too short for codecOffset + tag + trailer');
  }
  const kContent = await keyLookup(kid, nowMs);
  if (!kContent) {
    throw new Error(`SFrame: no key for KID ${kid} (rekeyed-out / not yet received)`);
  }
  const clearPrefix = sframeBytes.subarray(0, codecOffset);
  // ciphertext || tag = everything between the cleartext prefix and the trailer.
  const gcmInput = sframeBytes.subarray(codecOffset, sframeBytes.length - SFRAME_TRAILER_LEN);
  const trailerBytes = sframeBytes.subarray(sframeBytes.length - SFRAME_TRAILER_LEN);
  const iv = deriveFrameIv({ kid, ctr });
  const aad = buildAad(clearPrefix, trailerBytes);
  // crypto.subtle.decrypt throws (OperationError) on a wrong key / tampered tag / AAD.
  const plainBuf = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bufferView(iv),
      additionalData: bufferView(aad),
      tagLength: GCM_TAG_BITS,
    },
    kContent,
    bufferView(gcmInput),
  );
  const plainBody = new Uint8Array(plainBuf);
  // Re-prepend the cleartext prefix → the FULL original frame.
  const full = new Uint8Array(clearPrefix.length + plainBody.length);
  full.set(clearPrefix, 0);
  full.set(plainBody, clearPrefix.length);
  return full;
}
