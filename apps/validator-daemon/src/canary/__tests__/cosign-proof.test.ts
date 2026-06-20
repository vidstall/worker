/**
 * REQ-CFA-048/049 (W-M4-COSIGN, DESIGN-COSIGN.md D-CFA-39/40/45) — the additive proof helpers for
 * the pull-corroboration claim board: `signSelfAttestation` (the single PUBLISH leg over the FROZEN
 * 145-byte message, NOT via the >=2 gate) and `assembleProofFromAttestations` (accrues PRE-SIGNED
 * REMOTE attestations, re-asserts the >=2-DISTINCT-pubkey advisory pre-check). INV-A: nothing here
 * touches `canonicalProofMessage` / `MIN_ATTESTERS` / `buildDivergenceProof` — proven by the frozen
 * golden-vector test in proof.test.ts staying GREEN. All hermetic (fixed synthetic keypairs, no ports).
 */

import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  signSelfAttestation,
  assembleProofFromAttestations,
  distinctAttesterCount,
  canonicalProofMessage,
  MIN_ATTESTERS,
  OBSERVED_HASH_MISSING,
  type DivergenceClaim,
  type DivergenceAttestation,
} from '../proof.js';

const CLAIM: DivergenceClaim = {
  roomId: '0x' + '11'.repeat(32),
  relayMinerId: '0x' + '22'.repeat(32),
  canaryId: 9,
  frameSeq: 5,
  expectedHash: '33'.repeat(32),
  observedHash: OBSERVED_HASH_MISSING, // a DROP claim
};

const msgFor = (claim: DivergenceClaim): Uint8Array =>
  canonicalProofMessage({ ...claim, sessionKeypairs: [] });

async function attest(claim: DivergenceClaim, kp: Ed25519Keypair): Promise<DivergenceAttestation> {
  return signSelfAttestation(msgFor(claim), kp);
}

describe('REQ-CFA-048 — signSelfAttestation mints ONE Wallet-B leg over the UNCHANGED 145-byte message', () => {
  it('returns the keypair pubkey + a 64-byte sig and does NOT enforce the >=2 gate', async () => {
    const kp = new Ed25519Keypair();
    const att = await attest(CLAIM, kp);
    expect(Array.from(att.sessionPublicKey)).toEqual(Array.from(kp.getPublicKey().toRawBytes()));
    expect(att.signature.length).toBe(64);
    // A single self-attestation is the unit a board accrues — one keypair is enough (no throw).
    expect(distinctAttesterCount([att])).toBe(1);
  });

  it('signs the 145-byte canonical message verbatim (a different claim → a different signature)', async () => {
    const kp = new Ed25519Keypair();
    const a = await attest(CLAIM, kp);
    const b = await attest({ ...CLAIM, frameSeq: 6 }, kp);
    expect(Array.from(a.signature)).not.toEqual(Array.from(b.signature));
  });
});

describe('REQ-CFA-049 — assembleProofFromAttestations re-asserts the >=2-DISTINCT-pubkey pre-check', () => {
  it('assembles a DivergenceProof carrying the claim fields + >=2 distinct attestations', async () => {
    const a = await attest(CLAIM, new Ed25519Keypair());
    const b = await attest(CLAIM, new Ed25519Keypair());
    const proof = assembleProofFromAttestations(CLAIM, [a, b]);
    expect(proof.relayMinerId).toBe(CLAIM.relayMinerId);
    expect(proof.frameSeq).toBe(5);
    expect(proof.observedHash).toBe(OBSERVED_HASH_MISSING);
    expect(proof.attestations.length).toBe(2);
    expect(distinctAttesterCount(proof.attestations)).toBe(2);
  });

  it('THROWS below MIN_ATTESTERS distinct (a single attestation cannot slash)', async () => {
    const a = await attest(CLAIM, new Ed25519Keypair());
    expect(() => assembleProofFromAttestations(CLAIM, [a])).toThrow(/>=2 DISTINCT/);
  });

  it('one keypair presented TWICE counts as ONE distinct → rejected (mirrors on-chain VecSet)', async () => {
    const kp = new Ed25519Keypair();
    const a = await attest(CLAIM, kp);
    const aAgain = await attest(CLAIM, kp);
    expect(distinctAttesterCount([a, aAgain])).toBe(1);
    expect(() => assembleProofFromAttestations(CLAIM, [a, aAgain])).toThrow(/got 1 distinct/);
  });

  it('dedups duplicate pubkeys in the OUTPUT proof (one attestation per distinct attester)', async () => {
    const kpA = new Ed25519Keypair();
    const kpB = new Ed25519Keypair();
    const a = await attest(CLAIM, kpA);
    const aDup = await attest(CLAIM, kpA);
    const b = await attest(CLAIM, kpB);
    const proof = assembleProofFromAttestations(CLAIM, [a, aDup, b]);
    expect(proof.attestations.length).toBe(2); // deduped from 3 posts
    expect(distinctAttesterCount(proof.attestations)).toBe(2);
  });

  it('MIN_ATTESTERS is unchanged (frozen) at 2', () => {
    expect(MIN_ATTESTERS).toBe(2);
  });
});
