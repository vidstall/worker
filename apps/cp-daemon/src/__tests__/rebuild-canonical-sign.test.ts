/**
 * Multi-CP quorum Phase 1 — Leg 2 (G1 attest predicate) tests (RED-first → GREEN).
 *
 * DESIGN-connection-arch.md G1: each CP re-derives the canonical ISSUE message from
 * the cell's identifying fields via the FROZEN `buildIssueCanonicalMsg`
 * (cap-token-issuer.ts:285-299), POLICY-VALIDATES (room/role/expiry/nonce bounds),
 * and self-signs with RAW ed25519 (64-byte, NO Sui intent-wrap — same as the
 * single-CP branch index.ts:138-152 + makeSingleCpKeystore, OQ-CRR-9) ONLY on a
 * local byte-match + policy-pass. Returns `null` otherwise (fail-closed — NO
 * signature on a byte-mismatch or policy-fail).
 *
 * WHY (DESIGN G1): without this, M-of-N is meaningless — a malicious issuer could
 * collect M real signatures over byte-valid bytes no honest CP independently
 * validated; verify_quorum passes, the mint succeeds.
 *
 * SHAPE mirror: canary `attestIfIndependentlyObserved` (claim-board.ts:140-156) —
 * re-derive + predicate + self-sign-or-null. Different predicate
 * (re-derive+policy-valid vs re-derive+independently-observed).
 *
 * Forcing function: reuses the `bcs-equivalence.test.ts` golden ISSUE vector as the
 * canonical-bytes anchor (room 0x11*32, peer 0x22*32, role 2, expires 200n,
 * nonce 1 → 81 bytes). A valid claim's signed bytes MUST equal that vector and the
 * returned RAW 64-byte sig MUST verify against the signer's pubkey.
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildIssueCanonicalMsg,
  rebuildCanonicalAndSignIfMatches,
  type CapTokenIssueClaim,
} from '../cap-token-issuer.js';

/** hex string → number[] bytes (matches Move's id_to_bytes shape / bcs-equivalence helper). */
function hex(s: string): number[] {
  const cleaned = s.startsWith('0x') ? s.slice(2) : s;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

function bytesToHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** The golden ISSUE vector from bcs-equivalence.test.ts (the canonical-bytes anchor). */
const GOLDEN_ROOM_ID = '0x' + '11'.repeat(32);
const GOLDEN_PEER_PUBKEY = new Array(32).fill(0x22);
const GOLDEN_ROLE = 2; // relay
const GOLDEN_EXPIRES = 200n;
const GOLDEN_NONCE = 1;

/** Build a well-formed claim whose `canonicalMsgHex` matches the golden ISSUE bytes. */
function goldenClaim(over?: Partial<CapTokenIssueClaim>): CapTokenIssueClaim {
  const canonicalMsg = buildIssueCanonicalMsg({
    roomId: GOLDEN_ROOM_ID,
    peerPubkey: GOLDEN_PEER_PUBKEY,
    role: GOLDEN_ROLE,
    expiresEpoch: GOLDEN_EXPIRES,
    nonce: GOLDEN_NONCE,
  });
  return {
    kind: 'captoken-issue',
    roomId: GOLDEN_ROOM_ID,
    peerPubkey: GOLDEN_PEER_PUBKEY,
    role: GOLDEN_ROLE,
    expiresEpoch: GOLDEN_EXPIRES,
    nonce: GOLDEN_NONCE,
    canonicalMsgHex: bytesToHex(canonicalMsg),
    ...over,
  };
}

describe('Leg 2 — G1 rebuildCanonicalAndSignIfMatches (cap-token attest predicate)', () => {
  it('valid claim → RAW 64-byte sig that verifies against the signer pubkey over the golden ISSUE bytes', async () => {
    const signer = Ed25519Keypair.generate();
    const claim = goldenClaim();

    const att = await rebuildCanonicalAndSignIfMatches(claim, signer);

    expect(att).not.toBeNull();
    // RAW 64-byte ed25519 sig (NOT intent-wrapped — single-CP branch shape).
    expect(att!.signature.length).toBe(64);
    // pubkey is the signer's 32-byte raw ed25519 key.
    expect(att!.pubkey.length).toBe(32);
    expect(att!.pubkey).toEqual(Array.from(signer.getPublicKey().toRawBytes()));
    // operator address mirrors the single-CP branch's `addr` column.
    expect(att!.addr).toBe(signer.toSuiAddress());

    // The signature verifies against the FROZEN buildIssueCanonicalMsg output —
    // exactly the bcs-equivalence golden ISSUE vector (81 bytes).
    const canonical = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: GOLDEN_ROLE,
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: GOLDEN_NONCE,
    });
    expect(canonical.length).toBe(32 + 32 + 1 + 8 + 8);
    const ok = await signer
      .getPublicKey()
      .verify(canonical, new Uint8Array(att!.signature));
    expect(ok).toBe(true);
  });

  it('byte-mismatch (claim.canonicalMsgHex disagrees with re-derived bytes) → null, NO signature (fail-closed, G4)', async () => {
    const signer = Ed25519Keypair.generate();
    // Identifying fields are well-formed, but the poster-claimed canonicalMsgHex
    // is for a DIFFERENT message (role tampered) — the CP cannot reproduce it.
    const tampered = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: 4, // poster lied: claims role 4 bytes while fields say role 2
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: GOLDEN_NONCE,
    });
    const claim = goldenClaim({ canonicalMsgHex: bytesToHex(tampered) });

    const att = await rebuildCanonicalAndSignIfMatches(claim, signer);
    expect(att).toBeNull();
  });

  it('policy-fail: out-of-range role → null (no sig)', async () => {
    const signer = Ed25519Keypair.generate();
    // role 7 is not a valid MinerRole (0..4); rebuild the hex to match so this is
    // a PURE policy reject, not a byte-mismatch reject.
    const msg = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: 7,
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: GOLDEN_NONCE,
    });
    const claim = goldenClaim({ role: 7, canonicalMsgHex: bytesToHex(msg) });

    const att = await rebuildCanonicalAndSignIfMatches(claim, signer);
    expect(att).toBeNull();
  });

  it('policy-fail: peerPubkey not 32 bytes → null (no sig)', async () => {
    const signer = Ed25519Keypair.generate();
    const shortPk = [0x01, 0x02, 0x03, 0x04];
    const msg = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: shortPk,
      role: GOLDEN_ROLE,
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: GOLDEN_NONCE,
    });
    const claim = goldenClaim({ peerPubkey: shortPk, canonicalMsgHex: bytesToHex(msg) });

    const att = await rebuildCanonicalAndSignIfMatches(claim, signer);
    expect(att).toBeNull();
  });

  it('policy-fail: expired token (expiresEpoch <= currentEpoch) → null (no sig)', async () => {
    const signer = Ed25519Keypair.generate();
    const msg = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: GOLDEN_ROLE,
      expiresEpoch: 50n,
      nonce: GOLDEN_NONCE,
    });
    const claim = goldenClaim({ expiresEpoch: 50n, canonicalMsgHex: bytesToHex(msg) });

    // currentEpoch 100 > expires 50 → expired → fail-closed.
    const att = await rebuildCanonicalAndSignIfMatches(claim, signer, { currentEpoch: 100n });
    expect(att).toBeNull();
  });

  it('policy-fail: non-positive nonce (nonce < 1, D-010-B monotonic starts at 1) → null', async () => {
    const signer = Ed25519Keypair.generate();
    const msg = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: GOLDEN_ROLE,
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: 0,
    });
    const claim = goldenClaim({ nonce: 0, canonicalMsgHex: bytesToHex(msg) });

    const att = await rebuildCanonicalAndSignIfMatches(claim, signer);
    expect(att).toBeNull();
  });

  it('policy-fail: malformed roomId (not 32-byte hex) → null', async () => {
    const signer = Ed25519Keypair.generate();
    const badRoom = '0xdeadbeef'; // 4 bytes, not 32
    const msg = buildIssueCanonicalMsg({
      roomId: badRoom,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: GOLDEN_ROLE,
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: GOLDEN_NONCE,
    });
    const claim = goldenClaim({ roomId: badRoom, canonicalMsgHex: bytesToHex(msg) });

    const att = await rebuildCanonicalAndSignIfMatches(claim, signer);
    expect(att).toBeNull();
  });

  it('two CPs over the SAME valid claim produce DISTINCT sigs that BOTH verify (independence, no shared signing)', async () => {
    const cpA = Ed25519Keypair.generate();
    const cpB = Ed25519Keypair.generate();
    const claim = goldenClaim();

    const a = await rebuildCanonicalAndSignIfMatches(claim, cpA);
    const b = await rebuildCanonicalAndSignIfMatches(claim, cpB);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.signature).not.toEqual(b!.signature); // different keys → different sigs
    expect(a!.addr).not.toBe(b!.addr);

    const canonical = buildIssueCanonicalMsg({
      roomId: GOLDEN_ROOM_ID,
      peerPubkey: GOLDEN_PEER_PUBKEY,
      role: GOLDEN_ROLE,
      expiresEpoch: GOLDEN_EXPIRES,
      nonce: GOLDEN_NONCE,
    });
    expect(await cpA.getPublicKey().verify(canonical, new Uint8Array(a!.signature))).toBe(true);
    expect(await cpB.getPublicKey().verify(canonical, new Uint8Array(b!.signature))).toBe(true);
  });
});
