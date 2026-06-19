/**
 * REQ-CFA-006 — Canary divergence-slash SUBMITTER (validator-daemon → Move entry).
 *
 * The Phase-4 wiring leg: turns a {@link DivergenceProof} (built by proof.ts from a real
 * verifier.ts divergence) into a PTB call of the DEPLOYED Move entry
 * `canary_audit::slash_for_canary_divergence`, then signs + executes it. This is the seam
 * the localnet E2E exercises end-to-end.
 *
 * ── ARG ENCODING (must match canary_audit.move:162 signature + the FROZEN canonical message) ──
 *   room_id / relay_miner_id   → tx.pure.id (BCS<ID> = raw 32 bytes)
 *   canary_id / frame_seq      → tx.pure.u64 (8-byte LE)
 *   expected_hash              → vector<u8> RAW 32 bytes (SHA-256 hex → bytes; NOT bcs<vec>)
 *   observed_hash              → vector<u8> RAW 32 bytes (all-zero on a drop / MISSING)
 *   observed_present           → bool (false on a drop)
 *   pubkeys / sigs             → vector<vector<u8>> (one raw 32-byte session pubkey +
 *                                one raw 64-byte ed25519 sig per attestation, positional)
 * The Move entry rebuilds the SAME 145-byte canonical message and `ed25519_verify`s each
 * (pubkey, sig) over it; a single byte of drift here → the on-chain quorum rejects.
 *
 * ── WHO SIGNS (approach (b) / W-E9) ──────────────────────────────────────────────────
 * `relay_bond` is the relay's OWNED `&mut StakePosition` (`has key`, no store). A PTB can
 * only pass an owned object by its OWNER, so the slash tx is SIGNED BY THE RELAY (the bond
 * owner). This proves the entry mechanism on the deployed package (share_for_testing is
 * #[test_only] and stripped). Production needs a protocol-controlled bond so a validator tx
 * can slash without the owner's cooperation — that is the W-E9 limitation, on record.
 *
 * LOGGING (HARD-GATE): NEVER log key material / signatures. Only non-secret metadata
 * (roomId, relayMinerId, canaryId, frameSeq, attesterCount, digest).
 */

import { bcs } from '@mysten/bcs';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { createLogger, type Logger } from '@dvconf/shared';
import { OBSERVED_HASH_MISSING, type DivergenceProof } from './proof.js';

const MOD = 'canary/slash-submitter';
const fallbackLog = createLogger(MOD);

const GAS_BUDGET = 100_000_000;

/** Shared-object + bond ids the slash entry needs. */
export interface SlashCallOpts {
  packageId: string;
  /** NetworkRegistry shared object id. */
  netReg: string;
  /** ValidatorRegistry shared object id (session-wallet resolution, INV-C). */
  validatorReg: string;
  /** RoomManager shared object id (R_k assignment check). */
  roomMgr: string;
  /** The relay's OWNED StakePosition object id (the bond to slash). */
  relayBondId: string;
}

/** Result shape a caller reads the CanaryDivergenceSlashed event + digest out of. */
export interface SlashSubmitResult {
  digest: string;
  events?: Array<{ type?: string; parsedJson?: unknown }>;
  effects?: { status?: { status?: string; error?: string } };
}

/** Convert a hex string (±0x) to a RAW 32-byte array (left-zero-padded). Mirrors proof.ts. */
function hexToBytes32(hex: string): number[] {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = cleaned.padStart(64, '0');
  const out: number[] = new Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  return out;
}

const VecVecU8 = bcs.vector(bcs.vector(bcs.u8()));

/**
 * Add the `slash_for_canary_divergence` moveCall to a Transaction (does NOT sign/execute).
 * Exposed so a caller can dry-run / assert-abort the SAME bytes the live submit would send.
 */
function addMoveCall(tx: Transaction, proof: DivergenceProof, opts: SlashCallOpts): Transaction {
  const present = proof.observedHash !== OBSERVED_HASH_MISSING;
  const expectedBytes = hexToBytes32(proof.expectedHash);
  // On a drop, the Move entry zero-fills the observed region internally; we still pass a
  // valid 32-byte vector (all-zero) so the param shape (vector<u8>) is well-formed.
  const observedBytes = present ? hexToBytes32(proof.observedHash) : new Array<number>(32).fill(0);

  const pubkeys = proof.attestations.map((a) => Array.from(a.sessionPublicKey));
  const sigs = proof.attestations.map((a) => Array.from(a.signature));

  tx.moveCall({
    target: `${opts.packageId}::canary_audit::slash_for_canary_divergence`,
    arguments: [
      tx.object(opts.netReg), // net_reg: &NetworkRegistry
      tx.object(opts.validatorReg), // validator_reg: &ValidatorRegistry
      tx.object(opts.roomMgr), // room_mgr: &RoomManager
      tx.object(opts.relayBondId), // relay_bond: &mut StakePosition (OWNED by signer)
      tx.pure.id(proof.roomId), // room_id: ID
      tx.pure.id(proof.relayMinerId), // relay_miner_id: ID
      tx.pure.u64(BigInt(proof.canaryId)), // canary_id: u64
      tx.pure.u64(BigInt(proof.frameSeq)), // frame_seq: u64
      tx.pure.vector('u8', expectedBytes), // expected_hash: vector<u8> RAW 32
      tx.pure.vector('u8', observedBytes), // observed_hash: vector<u8> RAW 32
      tx.pure.bool(present), // observed_present: bool
      tx.pure(VecVecU8.serialize(pubkeys)), // pubkeys: vector<vector<u8>>
      tx.pure(VecVecU8.serialize(sigs)), // sigs: vector<vector<u8>>
    ],
  });
  return tx;
}

/**
 * Build, sign (with the bond OWNER keypair — approach (b)/W-E9), and execute the slash. Waits
 * for finality with effects + events and asserts on-chain success. Returns the result so the
 * caller can read the CanaryDivergenceSlashed event + the bond delta.
 */
async function submit(
  client: SuiClient,
  bondOwner: Ed25519Keypair,
  proof: DivergenceProof,
  opts: SlashCallOpts,
  logger: Logger = fallbackLog,
): Promise<SlashSubmitResult> {
  const tx = new Transaction();
  addMoveCall(tx, proof, opts);
  tx.setGasBudget(GAS_BUDGET);

  const result = (await client.signAndExecuteTransaction({
    signer: bondOwner,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  })) as unknown as SlashSubmitResult;
  await client.waitForTransaction({ digest: result.digest, options: { showEffects: true, showEvents: true } });

  const status = result.effects?.status?.status;
  if (status !== 'success') {
    const err = result.effects?.status?.error ?? '(no error string)';
    throw new Error(`slash_for_canary_divergence failed on-chain: status=${status ?? 'unknown'} error=${err}`);
  }
  logger.info(
    {
      module: MOD,
      action: 'submit_slash',
      context: {
        roomId: proof.roomId,
        relayMinerId: proof.relayMinerId,
        canaryId: proof.canaryId,
        frameSeq: proof.frameSeq,
        attesterCount: proof.attestations.length,
        digest: result.digest,
      },
    },
    'canary divergence slash submitted on-chain',
  );
  return result;
}

/** Submitter facade — `addMoveCall` for dry-run/abort assertions, `submit` for the live tx. */
export const submitCanarySlash = {
  addMoveCall,
  submit,
} as const;
