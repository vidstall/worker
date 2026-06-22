/**
 * Multi-CP quorum Phase 1 — Leg 0(b): INV-A wire-codec (PURE).
 *
 * The ONE net-new byte surface for the shared `/quorum/claims` carrier
 * (DESIGN INV-A verdict, line 49) is the HTTP wire serialization of a signature
 * envelope `{ pubkey: 32B, sig: 64B }`. This codec WRAPS the already-frozen
 * signed bytes (canary 145-byte proof / cap-token issue layout) in base64 JSON;
 * it MUST NOT alter, truncate, or pad any byte.
 *
 * Codec = base64 over each fixed-length field, cloned from the
 * `Buffer.from(...).toString('base64')` precedent at `turn-rpc.ts:128`.
 *
 * Fail-closed everywhere: a wrong-length pubkey/sig or a malformed wire object
 * is REJECTED (throws), so a non-canonical round-trip degrades to a hard error
 * (and, downstream, a Move verify reject) — never a silent golden-vector
 * corruption. Additive — no existing surface is touched.
 */

const PUBKEY_LEN = 32;
const SIG_LEN = 64;

/** A signature envelope: a 32-byte ed25519 pubkey + its 64-byte signature. */
export interface SigEnvelope {
  pubkey: Uint8Array;
  sig: Uint8Array;
}

/** The base64 JSON wire form of a {@link SigEnvelope}. */
export interface SigEnvelopeWire {
  pubkey: string;
  sig: string;
}

function assertLen(field: 'pubkey' | 'sig', bytes: Uint8Array, expected: number): void {
  if (bytes.length !== expected) {
    throw new Error(
      `sig-envelope ${field} wrong length: got ${bytes.length}, expected ${expected} bytes (fail-closed)`,
    );
  }
}

/**
 * Encode a {@link SigEnvelope} to its base64 JSON wire form. Fail-closed: a
 * wrong-length pubkey/sig throws rather than emitting a malformed envelope.
 */
export function encodeSigEnvelope(env: SigEnvelope): SigEnvelopeWire {
  assertLen('pubkey', env.pubkey, PUBKEY_LEN);
  assertLen('sig', env.sig, SIG_LEN);
  return {
    pubkey: Buffer.from(env.pubkey).toString('base64'),
    sig: Buffer.from(env.sig).toString('base64'),
  };
}

function decodeField(field: 'pubkey' | 'sig', value: unknown, expected: number): Uint8Array {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`sig-envelope ${field} missing or not a base64 string (fail-closed)`);
  }
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  assertLen(field, bytes, expected);
  return bytes;
}

/**
 * Decode a wire object to a {@link SigEnvelope}. Fail-closed: a missing field,
 * non-string field, or wrong-length decode throws — never truncates or pads.
 */
export function decodeSigEnvelope(wire: unknown): SigEnvelope {
  if (typeof wire !== 'object' || wire === null) {
    throw new Error('sig-envelope wire is not an object (fail-closed)');
  }
  const o = wire as Record<string, unknown>;
  return {
    pubkey: decodeField('pubkey', o['pubkey'], PUBKEY_LEN),
    sig: decodeField('sig', o['sig'], SIG_LEN),
  };
}
