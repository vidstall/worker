/**
 * REQ-CFA-005 / INV-C — Wallet-B-only proof-of-divergence builder + canonical BCS serializer.
 *
 * The proof-of-divergence is the compact on-chain artifact (DESIGN §4.2):
 *   { roomId, relayMinerId, canaryId, frameSeq, expectedHash, observedHash | 'MISSING',
 *     attestations: >=2 x sig(Wallet-B session key over the canonical proof message) }
 *
 * INV-C (auditor identity-hiding): every attestation is a Wallet-B SESSION signature ONLY.
 * NO Wallet-A public key OR signature appears anywhere in the struct or on the wire. The
 * test asserts the absence of Wallet-A material structurally.
 *
 * BYTE-MIRROR (the contract Phase 3.1 Move re-derives): each Wallet-B key signs the SAME
 * canonical fixed-length message these tests reconstruct independently. A canonical-msg
 * mismatch => the Move quorum rejects (the W1 byte-mirror lesson). So the test recomputes
 * the canonical bytes itself (not via the serializer) and verifies each session sig over it.
 */

import { describe, it, expect } from 'vitest';
import { bcs } from '@mysten/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildDivergenceProof,
  serializeDivergenceProof,
  deserializeDivergenceProof,
  canonicalProofMessage,
  CANARY_PROOF_MSG_LEN,
  OBSERVED_HASH_MISSING,
  type DivergenceProofInput,
  type DivergenceProof,
} from '../proof.js';

/** 32-byte SHA-256-shaped hex (64 hex chars) for deterministic tests. */
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const ROOM_ID = '0x' + '11'.repeat(32);
const RELAY_ID = '0x' + '22'.repeat(32);

/** Mirror of proof.ts hexToBytes32 — the test reconstructs the canonical bytes independently. */
function hexToBytes32(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = cleaned.padStart(64, '0');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  return out;
}

/** Independent reconstruction of the FROZEN canonical message (the byte-mirror contract). */
function expectCanonical(input: DivergenceProofInput): Uint8Array {
  const present = input.observedHash !== OBSERVED_HASH_MISSING;
  const msg = new Uint8Array(CANARY_PROOF_MSG_LEN);
  let off = 0;
  const put = (b: Uint8Array): void => {
    msg.set(b, off);
    off += b.length;
  };
  put(hexToBytes32(input.roomId)); // 32
  put(hexToBytes32(input.relayMinerId)); // 32
  put(bcs.u64().serialize(BigInt(input.canaryId)).toBytes()); // 8
  put(bcs.u64().serialize(BigInt(input.frameSeq)).toBytes()); // 8
  put(hexToBytes32(input.expectedHash)); // 32
  put(Uint8Array.from([present ? 1 : 0])); // 1 presence tag
  put(present ? hexToBytes32(input.observedHash) : new Uint8Array(32)); // 32 (zero on MISSING)
  return msg;
}

function baseInput(observedHash: string = HASH_B): Omit<DivergenceProofInput, 'sessionKeypairs'> {
  return {
    roomId: ROOM_ID,
    relayMinerId: RELAY_ID,
    canaryId: 7,
    frameSeq: 42,
    expectedHash: HASH_A,
    observedHash,
  };
}

describe('canonicalProofMessage (FROZEN byte layout — Phase 3.1 Move byte-mirror)', () => {
  it('is the fixed CANARY_PROOF_MSG_LEN and matches an independent reconstruction', () => {
    const input = { ...baseInput(), sessionKeypairs: [] };
    const msg = canonicalProofMessage(input);
    expect(msg.length).toBe(CANARY_PROOF_MSG_LEN);
    expect(CANARY_PROOF_MSG_LEN).toBe(145); // 32+32+8+8+32+1+32
    expect(Buffer.from(msg).toString('hex')).toBe(
      Buffer.from(expectCanonical({ ...baseInput(), sessionKeypairs: [] })).toString('hex'),
    );
  });

  it('is deterministic (same input => same bytes)', () => {
    const input = { ...baseInput(), sessionKeypairs: [] };
    expect(Buffer.from(canonicalProofMessage(input)).toString('hex')).toBe(
      Buffer.from(canonicalProofMessage(input)).toString('hex'),
    );
  });

  it('MISSING (drop) sets the presence tag to 0 and zero-fills the observed-hash region', () => {
    const input = { ...baseInput(OBSERVED_HASH_MISSING), sessionKeypairs: [] };
    const msg = canonicalProofMessage(input);
    expect(msg.length).toBe(CANARY_PROOF_MSG_LEN);
    // presence tag is at offset 32+32+8+8+32 = 112
    expect(msg[112]).toBe(0);
    // the 32 observed-hash bytes after the tag are all zero
    expect([...msg.subarray(113, 145)].every((b) => b === 0)).toBe(true);
    expect(Buffer.from(msg).toString('hex')).toBe(
      Buffer.from(expectCanonical({ ...baseInput(OBSERVED_HASH_MISSING), sessionKeypairs: [] })).toString('hex'),
    );
  });

  it('present-vs-MISSING produce DIFFERENT canonical bytes (drop is signed distinctly)', () => {
    const present = canonicalProofMessage({ ...baseInput(HASH_B), sessionKeypairs: [] });
    const missing = canonicalProofMessage({ ...baseInput(OBSERVED_HASH_MISSING), sessionKeypairs: [] });
    expect(Buffer.from(present).toString('hex')).not.toBe(Buffer.from(missing).toString('hex'));
  });
});

describe('buildDivergenceProof (>=2 Wallet-B attestations, INV-C identity-hiding)', () => {
  it('yields attestations.length === 2 for 2 distinct session keypairs', async () => {
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();
    const proof = await buildDivergenceProof({ ...baseInput(), sessionKeypairs: [k1, k2] });
    expect(proof.attestations).toHaveLength(2);
  });

  it('each attestation is a Wallet-B SESSION sig only — verifies over the canonical message', async () => {
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();
    const input: DivergenceProofInput = { ...baseInput(), sessionKeypairs: [k1, k2] };
    const proof = await buildDivergenceProof(input);
    const canonical = expectCanonical(input);

    for (const att of proof.attestations) {
      // 64-byte raw ed25519 signature (NOT a Sui-serialized/intent-wrapped signature)
      expect(att.signature.length).toBe(64);
      // 32-byte raw session public key
      expect(att.sessionPublicKey.length).toBe(32);
    }

    // verify each attestation against the canonical bytes using the embedded session pubkey
    // via the SAME call Move mirrors: Ed25519PublicKey.verify(canonicalMsg, sig64).
    const { Ed25519PublicKey } = await import('@mysten/sui/keypairs/ed25519');
    for (const att of proof.attestations) {
      const pubkey = new Ed25519PublicKey(att.sessionPublicKey);
      expect(await pubkey.verify(canonical, att.signature)).toBe(true);
    }
  });

  it('binds the session key: each attestation pubkey matches its signing keypair', async () => {
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();
    const proof = await buildDivergenceProof({ ...baseInput(), sessionKeypairs: [k1, k2] });
    const pubs = proof.attestations.map((a) => Buffer.from(a.sessionPublicKey).toString('hex'));
    expect(pubs).toContain(Buffer.from(k1.getPublicKey().toRawBytes()).toString('hex'));
    expect(pubs).toContain(Buffer.from(k2.getPublicKey().toRawBytes()).toString('hex'));
  });

  it('INV-C: NO Wallet-A pubkey/sig present anywhere in the proof (structural)', async () => {
    const kSessionA = new Ed25519Keypair();
    const kSessionB = new Ed25519Keypair();
    // A separate "Wallet-A" main key that MUST NOT leak into the proof.
    const walletA = new Ed25519Keypair();
    const walletAPubHex = Buffer.from(walletA.getPublicKey().toRawBytes()).toString('hex');

    const proof = await buildDivergenceProof({
      ...baseInput(),
      sessionKeypairs: [kSessionA, kSessionB],
    });

    // The struct shape carries ONLY session material — no signatureA / pubkeyA / mainKey fields.
    const keys = new Set<string>();
    const collect = (obj: unknown): void => {
      if (obj && typeof obj === 'object' && !ArrayBuffer.isView(obj)) {
        for (const k of Object.keys(obj as Record<string, unknown>)) {
          keys.add(k.toLowerCase());
          collect((obj as Record<string, unknown>)[k]);
        }
      }
    };
    collect(proof);
    for (const k of keys) {
      expect(k).not.toContain('walleta');
      expect(k).not.toContain('main');
      // no "...a" dual-leg naming (signaturea / pubkeya)
      expect(k).not.toMatch(/(signature|pubkey|publickey|key)a$/);
    }

    // And no Wallet-A public-key BYTES appear in any attestation pubkey/sig.
    for (const att of proof.attestations) {
      expect(Buffer.from(att.sessionPublicKey).toString('hex')).not.toBe(walletAPubHex);
      expect(Buffer.from(att.signature).toString('hex')).not.toContain(walletAPubHex);
    }
  });

  it('supports the observedHash="MISSING" drop variant', async () => {
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();
    const input: DivergenceProofInput = {
      ...baseInput(OBSERVED_HASH_MISSING),
      sessionKeypairs: [k1, k2],
    };
    const proof = await buildDivergenceProof(input);
    expect(proof.observedHash).toBe(OBSERVED_HASH_MISSING);
    const canonical = expectCanonical(input);
    const { Ed25519PublicKey } = await import('@mysten/sui/keypairs/ed25519');
    for (const att of proof.attestations) {
      const pubkey = new Ed25519PublicKey(att.sessionPublicKey);
      expect(await pubkey.verify(canonical, att.signature)).toBe(true);
    }
  });

  it('rejects a single attester (<2 Wallet-B keys) — quorum is enforced at build', async () => {
    const k1 = new Ed25519Keypair();
    await expect(
      buildDivergenceProof({ ...baseInput(), sessionKeypairs: [k1] }),
    ).rejects.toThrow();
  });
});

describe('serializeDivergenceProof / deserializeDivergenceProof (round-trip)', () => {
  it('round-trips a 2-attestation proof (serialize -> deserialize === input)', async () => {
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();
    const proof = await buildDivergenceProof({ ...baseInput(), sessionKeypairs: [k1, k2] });

    const wire = serializeDivergenceProof(proof);
    expect(wire).toBeInstanceOf(Uint8Array);
    const back: DivergenceProof = deserializeDivergenceProof(wire);

    expect(back.roomId).toBe(proof.roomId);
    expect(back.relayMinerId).toBe(proof.relayMinerId);
    expect(back.canaryId).toBe(proof.canaryId);
    expect(back.frameSeq).toBe(proof.frameSeq);
    expect(back.expectedHash).toBe(proof.expectedHash);
    expect(back.observedHash).toBe(proof.observedHash);
    expect(back.attestations).toHaveLength(proof.attestations.length);
    for (let i = 0; i < proof.attestations.length; i++) {
      expect(Buffer.from(back.attestations[i]!.signature).toString('hex')).toBe(
        Buffer.from(proof.attestations[i]!.signature).toString('hex'),
      );
      expect(Buffer.from(back.attestations[i]!.sessionPublicKey).toString('hex')).toBe(
        Buffer.from(proof.attestations[i]!.sessionPublicKey).toString('hex'),
      );
    }
  });

  it('round-trips the MISSING (drop) variant', async () => {
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();
    const proof = await buildDivergenceProof({
      ...baseInput(OBSERVED_HASH_MISSING),
      sessionKeypairs: [k1, k2],
    });
    const back = deserializeDivergenceProof(serializeDivergenceProof(proof));
    expect(back.observedHash).toBe(OBSERVED_HASH_MISSING);
    expect(back.attestations).toHaveLength(2);
  });
});
