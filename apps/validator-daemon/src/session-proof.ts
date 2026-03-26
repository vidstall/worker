/**
 * SessionProof construction, BCS serialization, dual-key signing, and on-chain submission.
 *
 * The SessionProof captures a validator's measurement of a relay during a room session.
 * Both the main wallet (public validator identity) and session wallet (ephemeral identity)
 * must sign the proof before submission.
 *
 * On-chain submission uses the economic_layer::submit_session_proof entry function.
 * TX is sent FROM the session wallet (wallet B) per PM P1-1.
 *
 * CRITICAL: Never log private keys or session wallet secret keys.
 */

import { bcs } from '@mysten/bcs';
import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger, type NetworkConfig, type Logger } from '@dvconf/shared';
import { ErrorCodes } from '@dvconf/shared';
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

/** Dual-key signature pair -- both required for on-chain verification. */
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
 * Convert a hex string (with or without 0x prefix) to a 32-byte Uint8Array.
 * Pads with leading zeros if shorter than 32 bytes.
 */
function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = cleaned.padStart(64, '0'); // 32 bytes = 64 hex chars
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(padded.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * IC-2: BCS Message Byte Layout Contract
 *
 * Serialize proof fields in the EXACT field order expected by
 * economic_layer.move::submit_session_proof on-chain verification:
 *
 *   1. room_id:           BCS<ID>  = 32 bytes (address encoding)
 *   2. relay_miner_id:    BCS<ID>  = 32 bytes (address encoding)
 *   3. packets_forwarded: BCS<u64> = 8 bytes little-endian
 *   4. bytes_transferred: BCS<u64> = 8 bytes little-endian
 *   5. unique_peers:      BCS<u64> = 8 bytes little-endian
 *   6. duration_seconds:  BCS<u64> = 8 bytes little-endian
 *   7. avg_latency_ms:    BCS<u64> = 8 bytes little-endian
 *   8. packet_loss_bps:   BCS<u64> = 8 bytes little-endian
 *   9. jitter_ms:         BCS<u64> = 8 bytes little-endian
 *
 * Total message size: 32 + 32 + (7 * 8) = 120 bytes
 */
export function serializeProofBcs(
  roomId: string,
  relayMinerId: string,
  packetsForwarded: bigint,
  bytesTransferred: bigint,
  uniquePeers: bigint,
  durationSeconds: bigint,
  avgLatencyMs: bigint,
  packetLossBps: bigint,
  jitterMs: bigint,
): Uint8Array {
  // BCS<ID> is serialized as 32-byte address (no length prefix).
  // Sui IDs are hex strings (with 0x prefix) representing 32 bytes.
  const roomIdBytes = hexToBytes(roomId);
  const relayIdBytes = hexToBytes(relayMinerId);

  // BCS<u64> is 8 bytes little-endian
  const pktFwd = bcs.u64().serialize(packetsForwarded).toBytes();
  const bytesTx = bcs.u64().serialize(bytesTransferred).toBytes();
  const peers = bcs.u64().serialize(uniquePeers).toBytes();
  const duration = bcs.u64().serialize(durationSeconds).toBytes();
  const latency = bcs.u64().serialize(avgLatencyMs).toBytes();
  const loss = bcs.u64().serialize(packetLossBps).toBytes();
  const jitter = bcs.u64().serialize(jitterMs).toBytes();

  // Concatenate in exact IC-2 field order
  const msg = new Uint8Array(120);
  let offset = 0;
  for (const part of [roomIdBytes, relayIdBytes, pktFwd, bytesTx, peers, duration, latency, loss, jitter]) {
    msg.set(part, offset);
    offset += part.length;
  }

  return msg;
}

/**
 * Legacy serialization (JSON-based) -- kept for backward compatibility.
 * Production code uses serializeProofBcs() for on-chain proof submission.
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
 * IC-4: Dual-Key Public Key Passing Contract
 *
 * Order matters for on-chain verification:
 * 1. Main wallet signs first (public validator identity -- wallet A)
 * 2. Session wallet signs second (ephemeral identity -- wallet B)
 *
 * Uses Ed25519Keypair.sign() which returns raw 64-byte ed25519 signature.
 * This is NOT Sui TX signing -- it's raw ed25519 signing for on-chain ed25519_verify.
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
    `SessionProof constructed -- room=${proof.roomId}, relay=${proof.relayMinerId}, loss=${proof.measurement.packetLossRate}bp`,
  );
}

/**
 * Submit a SessionProof on-chain via economic_layer::submit_session_proof PTB.
 *
 * IC-1: submit_session_proof TX Argument Contract
 * IC-2: BCS Message Byte Layout Contract
 * IC-4: Dual-Key Public Key Passing Contract
 *
 * The TX is sent FROM the session wallet (wallet B) per PM P1-1.
 *
 * @param client          - SuiClient instance
 * @param sessionKeypair  - Session wallet keypair (wallet B) -- TX sender
 * @param mainKeypair     - Main wallet keypair (wallet A) -- for signing proof bytes
 * @param config          - Network configuration with shared object IDs
 * @param escrowId        - RoomEscrow object ID (discovered via EscrowCreated event)
 * @param proof           - The SessionProof to submit
 * @param log             - Logger instance
 * @returns true if submission succeeded, false if failed/skipped
 */
export async function submitSessionProof(
  client: SuiClient,
  sessionKeypair: Ed25519Keypair,
  mainKeypair: Ed25519Keypair,
  config: NetworkConfig,
  escrowId: string,
  proof: SessionProof,
  log?: Logger,
): Promise<boolean> {
  const l = log ?? logger;

  // Convert measurement duration from ms to seconds
  const durationSeconds = proof.measurement.measurementDurationMs / 1000n;

  // IC-2: BCS serialize proof fields in exact field order
  const bcsMessage = serializeProofBcs(
    proof.roomId,
    proof.relayMinerId,
    proof.measurement.packetsSent,       // packets_forwarded
    proof.measurement.bytesForwarded,    // bytes_transferred
    0n,                                   // unique_peers (0 placeholder Phase 13)
    durationSeconds,                      // duration_seconds
    proof.measurement.avgLatencyMs,       // avg_latency_ms
    proof.measurement.packetLossRate,     // packet_loss_bps
    proof.measurement.jitterMs,           // jitter_ms
  );

  // IC-4: Dual-key signing -- raw ed25519 signatures (NOT Sui TX signing)
  const { signatureA: sigPublic, signatureB: sigSession } = await dualKeySign(
    bcsMessage,
    mainKeypair,
    sessionKeypair,
  );

  // IC-4: Extract raw 32-byte ed25519 public keys
  const pubkeyPublic = mainKeypair.getPublicKey().toRawBytes();
  const pubkeySession = sessionKeypair.getPublicKey().toRawBytes();

  // IC-1: Build the submit_session_proof PTB
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::economic_layer::submit_session_proof`,
    arguments: [
      tx.object(config.networkRegistryId),     // &NetworkRegistry
      tx.object(escrowId),                      // &mut RoomEscrow (from EscrowCreated event)
      tx.object(config.roomManagerId),          // &RoomManager (Phase 18: validator assignment check)
      tx.object(config.validatorRegistryId),   // &mut ValidatorRegistry
      tx.object(config.relayRegistryId),       // &mut RelayRegistry
      tx.pure.id(proof.roomId),                // room_id
      tx.pure.id(proof.relayMinerId),          // relay_miner_id
      tx.pure.u64(proof.measurement.packetsSent),       // packets_forwarded
      tx.pure.u64(proof.measurement.bytesForwarded),    // bytes_transferred
      tx.pure.u64(0n),                                   // unique_peers (0 placeholder Phase 13)
      tx.pure.u64(durationSeconds),                      // duration_seconds
      tx.pure.u64(proof.measurement.avgLatencyMs),       // avg_latency_ms
      tx.pure.u64(proof.measurement.packetLossRate),     // packet_loss_bps
      tx.pure.u64(proof.measurement.jitterMs),           // jitter_ms
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeyPublic))),   // pubkey_public (32 bytes)
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(pubkeySession))),  // pubkey_session (32 bytes)
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigPublic))),      // sig_public (64 bytes)
      tx.pure(bcs.vector(bcs.u8()).serialize(Array.from(sigSession))),     // sig_session (64 bytes)
    ],
  });

  try {
    // TX sent from session wallet (wallet B) per PM P1-1
    const result = await client.signAndExecuteTransaction({
      signer: sessionKeypair,
      transaction: tx,
      options: { showEffects: true, showEvents: true },
    });

    await client.waitForTransaction({ digest: result.digest });

    l.info(
      { digest: result.digest, roomId: proof.roomId, relayMinerId: proof.relayMinerId },
      `SessionProof submitted on-chain -- room=${proof.roomId}, relay=${proof.relayMinerId}`,
    );
    return true;
  } catch (err: unknown) {
    // IC-1: Handle specific economic_layer error codes
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.includes(String(ErrorCodes.economicLayer.E_ALREADY_SUBMITTED))) {
      // 656: Idempotent -- proof already submitted for this escrow, safe to continue
      l.info(
        { roomId: proof.roomId, relayMinerId: proof.relayMinerId },
        `SessionProof already submitted (idempotent) -- room=${proof.roomId}`,
      );
      return true;
    }

    if (errMsg.includes(String(ErrorCodes.economicLayer.E_SESSION_WALLET_NOT_FOUND))) {
      // 655: Session wallet not registered -- skip this room
      l.warn(
        { roomId: proof.roomId },
        `Session wallet not found for room=${proof.roomId}, skipping`,
      );
      return false;
    }

    if (errMsg.includes(String(ErrorCodes.economicLayer.E_RELAY_NOT_REGISTERED))) {
      // 661: Relay not in registry -- skip this room
      l.warn(
        { roomId: proof.roomId, relayMinerId: proof.relayMinerId },
        `Relay ${proof.relayMinerId} not registered, skipping room=${proof.roomId}`,
      );
      return false;
    }

    if (errMsg.includes(String(ErrorCodes.economicLayer.E_INVALID_SIGNATURE))) {
      // 654: BCS serialization mismatch or wrong key -- investigate
      l.error(
        { roomId: proof.roomId, relayMinerId: proof.relayMinerId, err: errMsg },
        `INVALID SIGNATURE for room=${proof.roomId} -- check BCS serialization (IC-2) and key binding (IC-4)`,
      );
      return false;
    }

    // Unexpected error
    l.error(
      { roomId: proof.roomId, err: errMsg },
      `Failed to submit SessionProof for room=${proof.roomId}`,
    );
    return false;
  }
}
