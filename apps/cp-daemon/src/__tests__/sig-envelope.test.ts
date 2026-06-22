/**
 * Multi-CP quorum Phase 1 — Leg 0(b): INV-A wire-codec round-trip.
 *
 * The ONE net-new byte surface for the shared `/quorum/claims` carrier
 * (DESIGN INV-A verdict, line 49) is the HTTP wire serialization of a
 * `{ pubkey: 32B, sig: 64B }` signature envelope. It WRAPS but never alters
 * the already-frozen signed bytes; a non-canonical round-trip must degrade
 * FAIL-CLOSED (reject) rather than silently corrupt a golden-vector region.
 *
 * Codec = base64 over each fixed-length field, cloned from the
 * `Buffer.from(...).toString('base64')` precedent at `turn-rpc.ts:128`.
 *
 * THIS TEST PINS:
 *   - encode -> decode is BYTE-IDENTICAL for a valid {32B,64B} envelope.
 *   - decode REJECTS a wrong-length pubkey or sig (fail-closed, never truncate/pad).
 *   - decode REJECTS malformed / non-base64 / missing fields (fail-closed).
 *
 * HERMETIC: pure functions only, no HTTP, no port.
 */

import { describe, it, expect } from 'vitest';
import {
  encodeSigEnvelope,
  decodeSigEnvelope,
  type SigEnvelope,
} from '../sig-envelope.js';

const PUBKEY = new Uint8Array(32).map((_, i) => (i * 7 + 1) & 0xff);
const SIG = new Uint8Array(64).map((_, i) => (i * 13 + 3) & 0xff);

describe('Leg 0(b) — encodeSigEnvelope / decodeSigEnvelope ({32B pubkey, 64B sig})', () => {
  it('round-trips a valid envelope byte-identically', () => {
    const env: SigEnvelope = { pubkey: PUBKEY, sig: SIG };
    const wire = encodeSigEnvelope(env);
    const back = decodeSigEnvelope(wire);
    expect(Buffer.from(back.pubkey).equals(Buffer.from(PUBKEY))).toBe(true);
    expect(Buffer.from(back.sig).equals(Buffer.from(SIG))).toBe(true);
  });

  it('the wire form is JSON with base64 string fields (turn-rpc.ts:128 codec)', () => {
    const wire = encodeSigEnvelope({ pubkey: PUBKEY, sig: SIG });
    const json = JSON.parse(JSON.stringify(wire)) as Record<string, unknown>;
    expect(typeof json['pubkey']).toBe('string');
    expect(typeof json['sig']).toBe('string');
    // base64 of the exact bytes — value-level pin, not just a type check.
    expect(json['pubkey']).toBe(Buffer.from(PUBKEY).toString('base64'));
    expect(json['sig']).toBe(Buffer.from(SIG).toString('base64'));
  });

  it('survives a full JSON serialize -> parse -> decode (HTTP wire simulation)', () => {
    const overTheWire = JSON.stringify(encodeSigEnvelope({ pubkey: PUBKEY, sig: SIG }));
    const back = decodeSigEnvelope(JSON.parse(overTheWire));
    expect(Buffer.from(back.pubkey).equals(Buffer.from(PUBKEY))).toBe(true);
    expect(Buffer.from(back.sig).equals(Buffer.from(SIG))).toBe(true);
  });

  it('fail-closed: a wrong-length PUBKEY (31 / 33 bytes) is rejected', () => {
    const short = Buffer.from(new Uint8Array(31)).toString('base64');
    const long = Buffer.from(new Uint8Array(33)).toString('base64');
    const sig = Buffer.from(SIG).toString('base64');
    expect(() => decodeSigEnvelope({ pubkey: short, sig })).toThrow(/pubkey|length|32/i);
    expect(() => decodeSigEnvelope({ pubkey: long, sig })).toThrow(/pubkey|length|32/i);
  });

  it('fail-closed: a wrong-length SIG (63 / 65 bytes) is rejected', () => {
    const pubkey = Buffer.from(PUBKEY).toString('base64');
    const short = Buffer.from(new Uint8Array(63)).toString('base64');
    const long = Buffer.from(new Uint8Array(65)).toString('base64');
    expect(() => decodeSigEnvelope({ pubkey, sig: short })).toThrow(/sig|length|64/i);
    expect(() => decodeSigEnvelope({ pubkey, sig: long })).toThrow(/sig|length|64/i);
  });

  it('fail-closed: encode rejects a wrong-length input (never emits a bad envelope)', () => {
    expect(() =>
      encodeSigEnvelope({ pubkey: new Uint8Array(31), sig: SIG }),
    ).toThrow(/pubkey|length|32/i);
    expect(() =>
      encodeSigEnvelope({ pubkey: PUBKEY, sig: new Uint8Array(65) }),
    ).toThrow(/sig|length|64/i);
  });

  it('fail-closed: malformed wire (missing fields / non-string / non-base64) is rejected', () => {
    const goodPub = Buffer.from(PUBKEY).toString('base64');
    const goodSig = Buffer.from(SIG).toString('base64');
    expect(() => decodeSigEnvelope(null)).toThrow();
    expect(() => decodeSigEnvelope({})).toThrow();
    expect(() => decodeSigEnvelope({ pubkey: goodPub })).toThrow();
    expect(() => decodeSigEnvelope({ pubkey: 123, sig: goodSig })).toThrow();
  });
});
