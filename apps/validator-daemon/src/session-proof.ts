/**
 * SessionProof construction and dual-key signing.
 *
 * The SessionProof captures a validator's measurement of a relay during a room session.
 * Both the main wallet (public validator identity) and session wallet (ephemeral identity)
 * must sign the proof before submission.
 *
 * For this phase: proofs are constructed and signed but NOT submitted on-chain
 * (Economic layer not yet deployed).
 *
 * CRITICAL: Never log private keys or session wallet secret keys.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger } from '@dvconf/shared';
import type { MeasurementResult } from './measurements.js';

const logger = createLogger('validator:session-proof');

/** A SessionProof links a validator's measurement to a specific room and relay. */
export interface SessionProof {
  /** Room being audited. */
  roomId: string;
  /** Relay being measured. */
  relayMinerId: string;
  /** Validator performing the measurement (miner ID). */
  validatorMinerId: string;
  /** Session wallet address (ephemeral identity for this session). */
  sessionWalletAddress: string;
  /** The measurement data collected. */
  measurement: MeasurementResult;
  /** Sui epoch when proof was created. */
  epoch: bigint;
}

/** Dual-key signature pair — both required for on-chain verification. */
export interface DualKeySignature {
  /** Signature from main wallet (public validator identity). */
  signatureA: Uint8Array;
  /** Signature from session wallet (ephemeral identity). */
  signatureB: Uint8Array;
}

/**
 * Build a SessionProof from its components.
 */
export function buildSessionProof(
  roomId: string,
  relayMinerId: string,
  validatorMinerId: string,
  sessionWalletAddress: string,
  measurement: MeasurementResult,
  epoch: bigint,
): SessionProof {
  return {
    roomId,
    relayMinerId,
    validatorMinerId,
    sessionWalletAddress,
    measurement,
    epoch,
  };
}

/**
 * Deterministic serialization of a SessionProof to bytes.
 *
 * Uses JSON.stringify with a bigint replacer + TextEncoder for simplicity.
 * Production would use BCS (Binary Canonical Serialization) matching the Move struct layout.
 */
export function serializeProof(proof: SessionProof): Uint8Array {
  const jsonString = JSON.stringify(proof, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : (value as unknown),
  );
  return new TextEncoder().encode(jsonString);
}

/**
 * Sign proof bytes with both keypairs (dual-key pattern).
 *
 * Order matters for on-chain verification:
 * 1. Main wallet signs first (public validator identity — wallet A)
 * 2. Session wallet signs second (ephemeral identity — wallet B)
 *
 * CRITICAL: This function never logs the keypair private keys.
 */
export async function dualKeySign(
  proofBytes: Uint8Array,
  mainKeypair: Ed25519Keypair,
  sessionKeypair: Ed25519Keypair,
): Promise<DualKeySignature> {
  const signatureA = await mainKeypair.sign(proofBytes);
  const signatureB = await sessionKeypair.sign(proofBytes);

  return { signatureA, signatureB };
}

/**
 * Log a proof summary without exposing sensitive data.
 */
export function logProofSummary(proof: SessionProof): void {
  logger.info(
    {
      roomId: proof.roomId,
      relayMinerId: proof.relayMinerId,
      validatorMinerId: proof.validatorMinerId,
      lossRate: proof.measurement.packetLossRate.toString(),
      latency: proof.measurement.avgLatencyMs.toString(),
    },
    `SessionProof constructed — room=${proof.roomId}, relay=${proof.relayMinerId}, loss=${proof.measurement.packetLossRate}bp. Dual-key signed. NOT submitting (Economic layer not yet deployed).`,
  );
}
