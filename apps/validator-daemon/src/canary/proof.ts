/**
 * REQ-CFA-005 / INV-C — Canary proof-of-divergence builder (Wallet-B session sigs ONLY).
 *
 * When the receiver-side verifier (`verifier.ts`) records a forwarding divergence for a
 * relay, a covering cell of >=2 DISTINCT validators each ATTEST the SAME divergence by
 * signing a CANONICAL fixed-length message with their Wallet-B SESSION keypair. The
 * resulting compact struct (DESIGN §4.2) is what Phase 4 submits to the Move entry
 * `slash_for_canary_divergence`:
 *
 *   { roomId, relayMinerId, canaryId, frameSeq, expectedHash, observedHash | 'MISSING',
 *     attestations: >=2 x { sessionPublicKey(32), signature(64) } }   // Wallet-B ONLY
 *
 * ── INV-C (auditor identity-hiding) ───────────────────────────────────────────────────
 * Each attestation is a Wallet-B SESSION signature ONLY. NO Wallet-A (the public validator
 * identity / "main" wallet) public key OR signature is ever placed in the struct or on the
 * wire. We sign DIRECTLY via `sessionKeypair.sign(canonicalMessage)` — we do NOT call the
 * dual-leg `session-proof.ts::dualKeySign` (which also produces a Wallet-A `signatureA`),
 * because that A leg would link Wallet-A↔Wallet-B on-chain mid-session. The chain resolves
 * each session pubkey → a distinct `validator_miner_id` via the package-gated
 * `validator_registry::lookup_session_wallet`, so quorum is counted WITHOUT a Wallet-A bind.
 *
 * ── BYTE-MIRROR CONTRACT (the FROZEN canonical proof message — Phase 3.1 Move re-derives) ─
 * Each Wallet-B key signs `canonicalProofMessage(...)`, a DETERMINISTIC fixed-length byte
 * string the Move verifier reconstructs to call `ed25519_verify(sig, session_pubkey, msg)`.
 * A canonical-msg mismatch => the Move quorum REJECTS (the W1 byte-mirror lesson: a daemon
 * that signs a different byte string than the chain rebuilds fails verify). The layout is
 * FROZEN here and MUST be byte-identical in `canary_audit.move`:
 *
 *   off   field            BCS / encoding                              bytes
 *   ----  ---------------  ------------------------------------------  -----
 *     0   room_id          BCS<ID>  = raw 32-byte address              32
 *    32   relay_miner_id   BCS<ID>  = raw 32-byte address              32
 *    64   canary_id        BCS<u64> = 8-byte little-endian             8
 *    72   frame_seq        BCS<u64> = 8-byte little-endian             8
 *    80   expected_hash    raw 32-byte SHA-256 digest                  32
 *   112   observed_present 1-byte tag: 0x01 present / 0x00 MISSING      1
 *   113   observed_hash    raw 32 bytes (the SHA-256, or ALL-ZERO      32
 *                          when observed_present == 0x00 / drop)
 *   ----                                                               ---
 *   total CANARY_PROOF_MSG_LEN                                         145
 *
 * The DROP sentinel: `observedHash === 'MISSING'` (a frame the relay never forwarded) is
 * encoded as observed_present=0x00 + an all-zero 32-byte region, so present-vs-drop produce
 * DISTINCT signed bytes. ID/hash hex strings map to raw 32 bytes via `hexToBytes32` (the
 * same address-encoding `session-proof.ts::serializeProofBcs` uses for BCS<ID>); u64 fields
 * use `bcs.u64()` (8-byte LE) exactly like that module.
 *
 * LOGGING (HARD-GATE): NEVER log key material / signatures / private keys. The only
 * structured log here is non-secret metadata (roomId, relayMinerId, canaryId, frameSeq,
 * attesterCount). Public keys + signatures are public artifacts but are NOT logged either.
 */

import { bcs } from '@mysten/bcs';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger } from '@dvconf/shared';

const log = createLogger('canary/proof');

/** The DROP sentinel: the relay never forwarded a frame for this expected ctr. */
export const OBSERVED_HASH_MISSING = 'MISSING' as const;

/** Raw byte length of the FROZEN canonical proof message (see header table). */
export const CANARY_PROOF_MSG_LEN = 32 + 32 + 8 + 8 + 32 + 1 + 32; // = 145

/** Minimum distinct Wallet-B attesters required to build a proof (RO-023c / DESIGN §4.1). */
export const MIN_ATTESTERS = 2;

/** A single Wallet-B attestation over the canonical proof message — NO Wallet-A material. */
export interface DivergenceAttestation {
  /** Raw 32-byte Wallet-B SESSION ed25519 public key (resolves to a miner_id on-chain). */
  sessionPublicKey: Uint8Array;
  /** Raw 64-byte ed25519 signature over `canonicalProofMessage(...)` (NOT Sui-wrapped). */
  signature: Uint8Array;
}

/** The compact proof-of-divergence (DESIGN §4.2). Carries Wallet-B attestations ONLY. */
export interface DivergenceProof {
  /** Room being audited (Sui ID hex). */
  roomId: string;
  /** The single culprit relay (Sui ID hex) — single-relay attribution (REQ-CFA-007). */
  relayMinerId: string;
  /** The canary stream id (canaryKid). */
  canaryId: number;
  /** The diverged frame sequence (the locally-driven expected ctr). */
  frameSeq: number;
  /** SHA-256 hex of the locally-recomputed expected ciphertext C_i. */
  expectedHash: string;
  /** SHA-256 hex of the forwarded body, or `OBSERVED_HASH_MISSING` on a drop. */
  observedHash: string;
  /** >=2 distinct Wallet-B session attestations over the canonical message. */
  attestations: DivergenceAttestation[];
}

/** Inputs to build a proof. `sessionKeypairs` are the Wallet-B session keypairs ONLY. */
export interface DivergenceProofInput {
  roomId: string;
  relayMinerId: string;
  canaryId: number;
  frameSeq: number;
  expectedHash: string;
  observedHash: string;
  /** The cell's Wallet-B session keypairs (>=2). NO main/Wallet-A keypair is accepted. */
  sessionKeypairs: Ed25519Keypair[];
}

/**
 * Convert a hex string (with/without 0x) to a 32-byte Uint8Array (left-zero-padded).
 * Mirrors `session-proof.ts::hexToBytes` — BCS<ID> is a raw 32-byte address (no length
 * prefix), and a SHA-256 hex digest is likewise 32 raw bytes.
 */
function hexToBytes32(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = cleaned.padStart(64, '0'); // 32 bytes = 64 hex chars
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build the FROZEN canonical proof message (the byte-mirror contract Phase 3.1 Move
 * re-derives). See the header table for the exact field order / BCS types / offsets.
 * DROP (observedHash === MISSING) => presence tag 0x00 + an all-zero observed-hash region.
 */
export function canonicalProofMessage(input: DivergenceProofInput): Uint8Array {
  const present = input.observedHash !== OBSERVED_HASH_MISSING;

  const roomIdBytes = hexToBytes32(input.roomId); // 32
  const relayIdBytes = hexToBytes32(input.relayMinerId); // 32
  const canaryIdBytes = bcs.u64().serialize(BigInt(input.canaryId)).toBytes(); // 8 LE
  const frameSeqBytes = bcs.u64().serialize(BigInt(input.frameSeq)).toBytes(); // 8 LE
  const expectedBytes = hexToBytes32(input.expectedHash); // 32
  const presenceByte = Uint8Array.from([present ? 1 : 0]); // 1
  const observedBytes = present ? hexToBytes32(input.observedHash) : new Uint8Array(32); // 32

  const msg = new Uint8Array(CANARY_PROOF_MSG_LEN);
  let offset = 0;
  for (const part of [
    roomIdBytes,
    relayIdBytes,
    canaryIdBytes,
    frameSeqBytes,
    expectedBytes,
    presenceByte,
    observedBytes,
  ]) {
    msg.set(part, offset);
    offset += part.length;
  }
  return msg;
}

/**
 * Build the proof-of-divergence: each Wallet-B session keypair signs the SAME canonical
 * message (Wallet-B leg ONLY — NO `dualKeySign`, NO Wallet-A signature). Throws if fewer
 * than `MIN_ATTESTERS` (2) session keypairs are supplied (quorum enforced at build time).
 *
 * NOTE: distinct-`validator_miner_id` quorum is enforced ON-CHAIN (Phase 3.1, via the
 * package-gated `lookup_session_wallet` + a VecSet dedup) — a single validator rotating
 * Wallet-B twice yields 2 distinct session pubkeys here but resolves to ONE miner_id and is
 * rejected by the chain. This builder enforces only the >=2-attestation count.
 */
export async function buildDivergenceProof(input: DivergenceProofInput): Promise<DivergenceProof> {
  if (input.sessionKeypairs.length < MIN_ATTESTERS) {
    throw new Error(
      `canary/proof: need >=${MIN_ATTESTERS} Wallet-B attesters, got ${input.sessionKeypairs.length}`,
    );
  }

  const message = canonicalProofMessage(input);

  // Wallet-B leg ONLY: raw ed25519 sign (the SAME call Move mirrors via ed25519_verify).
  // No Wallet-A keypair is touched — INV-C identity-hiding.
  const attestations: DivergenceAttestation[] = [];
  for (const sessionKeypair of input.sessionKeypairs) {
    const signature = await sessionKeypair.sign(message);
    attestations.push({
      sessionPublicKey: sessionKeypair.getPublicKey().toRawBytes(),
      signature,
    });
  }

  log.info(
    {
      roomId: input.roomId,
      relayMinerId: input.relayMinerId,
      canaryId: input.canaryId,
      frameSeq: input.frameSeq,
      drop: input.observedHash === OBSERVED_HASH_MISSING,
      attesters: attestations.length,
    },
    'canary proof-of-divergence built (Wallet-B only)',
  );

  return {
    roomId: input.roomId,
    relayMinerId: input.relayMinerId,
    canaryId: input.canaryId,
    frameSeq: input.frameSeq,
    expectedHash: input.expectedHash,
    observedHash: input.observedHash,
    attestations,
  };
}

// ── Round-tripping wire serializer (BCS) ──────────────────────────────────────────────
//
// The proof is serialized for daemon-internal transport / evidence; the ON-CHAIN PTB
// (Phase 4) passes the fields + raw attestation vectors directly to the Move entry. This
// serializer is the symmetric round-trip the test asserts (serialize -> deserialize ===
// input). It is BCS-structured (length-prefixed) and DISTINCT from `canonicalProofMessage`
// (which is the fixed-length SIGNED bytes). Strings (ID/hash hex, the MISSING sentinel) are
// preserved verbatim so the deserialized struct equals the input.
const AttestationBcs = bcs.struct('CanaryAttestation', {
  sessionPublicKey: bcs.vector(bcs.u8()),
  signature: bcs.vector(bcs.u8()),
});

const DivergenceProofBcs = bcs.struct('CanaryDivergenceProof', {
  roomId: bcs.string(),
  relayMinerId: bcs.string(),
  canaryId: bcs.u64(),
  frameSeq: bcs.u64(),
  expectedHash: bcs.string(),
  observedHash: bcs.string(),
  attestations: bcs.vector(AttestationBcs),
});

/** Serialize a proof to a length-prefixed BCS wire form (round-trips with deserialize). */
export function serializeDivergenceProof(proof: DivergenceProof): Uint8Array {
  return DivergenceProofBcs.serialize({
    roomId: proof.roomId,
    relayMinerId: proof.relayMinerId,
    canaryId: BigInt(proof.canaryId),
    frameSeq: BigInt(proof.frameSeq),
    expectedHash: proof.expectedHash,
    observedHash: proof.observedHash,
    attestations: proof.attestations.map((a) => ({
      sessionPublicKey: Array.from(a.sessionPublicKey),
      signature: Array.from(a.signature),
    })),
  }).toBytes();
}

/** Deserialize the BCS wire form back into a `DivergenceProof` (inverse of serialize). */
export function deserializeDivergenceProof(wire: Uint8Array): DivergenceProof {
  const parsed = DivergenceProofBcs.parse(wire);
  return {
    roomId: parsed.roomId,
    relayMinerId: parsed.relayMinerId,
    canaryId: Number(parsed.canaryId),
    frameSeq: Number(parsed.frameSeq),
    expectedHash: parsed.expectedHash,
    observedHash: parsed.observedHash,
    attestations: parsed.attestations.map((a) => ({
      sessionPublicKey: Uint8Array.from(a.sessionPublicKey),
      signature: Uint8Array.from(a.signature),
    })),
  };
}
