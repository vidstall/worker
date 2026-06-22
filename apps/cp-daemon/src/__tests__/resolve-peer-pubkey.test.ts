/**
 * REQ-MCS-012 (W5 M2 P1.0) — admission `peer_pubkey` resolution.
 *
 * CONTRACTS §0 (D-M2-16): the on-chain `RoomCapability.peer_pubkey` for the
 * E2EE path must carry the CLIENT'S in-browser ed25519 SESSION pubkey, not the
 * Sui miner-ID hex that the issuer used as a structural placeholder
 * (`cap-token-issuer.ts:629-638`, the F62 deferred-wiring gap).
 *
 * `resolvePeerPubkey` is the additive seam that closes that gap: when a session
 * pubkey is supplied (base64, 32-byte ed25519), it is decoded and used as the
 * admission `peer_pubkey`; when absent, the issuer falls back to today's
 * miner-ID hex decode (no behavior change for the infrastructure-peer path).
 *
 * 0 Move change: `room_capability.move:198-201` only length-checks the 32-byte
 * field — both a session key and the legacy decode satisfy it.
 */

import { describe, it, expect } from 'vitest';
import { resolvePeerPubkey } from '../cap-token-issuer.js';

// A real 32-byte ed25519 public key, base64-encoded (the shape the client's
// SessionKeypair.publicKeyB64 produces).
const SESSION_PUB_B64 = 'y/RvNH9ZsHKpMyoFTNTyh9mATZyl4qR4tNMvwOYGssg=';

function b64ToBytes(b64: string): number[] {
  return Array.from(Buffer.from(b64, 'base64'));
}

describe('resolvePeerPubkey (REQ-MCS-012 P1.0)', () => {
  it('uses the client session pubkey (base64) when present', () => {
    const out = resolvePeerPubkey({ id: '0xdeadbeef', sessionPubkeyB64: SESSION_PUB_B64 });
    expect(out).toEqual(b64ToBytes(SESSION_PUB_B64));
    expect(out.length).toBe(32); // ed25519 pubkey length the Move field length-checks
  });

  it('falls back to the miner-ID hex decode when no session pubkey is supplied (legacy path unchanged)', () => {
    const minerId = '0x' + 'ab'.repeat(32);
    const out = resolvePeerPubkey({ id: minerId });
    expect(out.length).toBe(32);
    expect(out.every((b: number) => b === 0xab)).toBe(true);
  });

  it('rejects a session pubkey that does not decode to 32 bytes (length invariant)', () => {
    expect(() => resolvePeerPubkey({ id: '0xabcd', sessionPubkeyB64: 'AAAA' })).toThrow(/32/);
  });

  it('rejects a non-base64 session pubkey rather than silently falling back', () => {
    expect(() =>
      resolvePeerPubkey({ id: '0xabcd', sessionPubkeyB64: 'not valid base64 !!!' }),
    ).toThrow();
  });
});
