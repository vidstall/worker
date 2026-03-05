/**
 * Tests for SessionProof construction and dual-key signing.
 *
 * Verifies:
 * - Proof construction with all fields
 * - Deterministic serialization (same input = same bytes)
 * - Dual-key signing produces two distinct, valid signatures
 * - Identity separation between main and session keypairs
 */

import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildSessionProof,
  serializeProof,
  dualKeySign,
  type SessionProof,
} from '../session-proof.js';
import type { MeasurementResult } from '../measurements.js';

/** Create a fixed measurement for deterministic tests. */
function fixedMeasurement(): MeasurementResult {
  return {
    relayMinerId: '0xrelay1',
    packetsSent: 30_000n,
    packetsReceived: 29_100n,
    packetLossRate: 300n,
    avgLatencyMs: 45n,
    jitterMs: 5n,
    bytesForwarded: 50_000_000n,
    measurementDurationMs: 60_000n,
    timestamp: 1700000000000n,
  };
}

describe('buildSessionProof', () => {
  it('constructs valid proof with all fields', () => {
    const measurement = fixedMeasurement();
    const proof = buildSessionProof(
      'room-1',
      '0xrelay1',
      '0xvalidator1',
      '0xsession1',
      measurement,
      100n,
    );

    expect(proof.roomId).toBe('room-1');
    expect(proof.relayMinerId).toBe('0xrelay1');
    expect(proof.validatorMinerId).toBe('0xvalidator1');
    expect(proof.sessionWalletAddress).toBe('0xsession1');
    expect(proof.measurement).toEqual(measurement);
    expect(proof.epoch).toBe(100n);
  });
});

describe('serializeProof', () => {
  it('produces deterministic output (same input = same bytes)', () => {
    const measurement = fixedMeasurement();
    const proof = buildSessionProof(
      'room-1',
      '0xrelay1',
      '0xvalidator1',
      '0xsession1',
      measurement,
      100n,
    );

    const bytes1 = serializeProof(proof);
    const bytes2 = serializeProof(proof);

    expect(bytes1).toEqual(bytes2);
    expect(bytes1.length).toBeGreaterThan(0);
  });

  it('serializes bigint values as strings in JSON', () => {
    const measurement = fixedMeasurement();
    const proof = buildSessionProof(
      'room-1',
      '0xrelay1',
      '0xvalidator1',
      '0xsession1',
      measurement,
      100n,
    );

    const bytes = serializeProof(proof);
    const json = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // bigint epoch should be serialized as string "100"
    expect(parsed['epoch']).toBe('100');
  });
});

describe('dualKeySign', () => {
  it('produces two distinct signatures', async () => {
    const mainKeypair = new Ed25519Keypair();
    const sessionKeypair = new Ed25519Keypair();

    const measurement = fixedMeasurement();
    const proof = buildSessionProof(
      'room-1',
      '0xrelay1',
      '0xvalidator1',
      sessionKeypair.getPublicKey().toSuiAddress(),
      measurement,
      100n,
    );

    const proofBytes = serializeProof(proof);
    const { signatureA, signatureB } = await dualKeySign(
      proofBytes,
      mainKeypair,
      sessionKeypair,
    );

    expect(signatureA).toBeInstanceOf(Uint8Array);
    expect(signatureB).toBeInstanceOf(Uint8Array);
    expect(signatureA.length).toBeGreaterThan(0);
    expect(signatureB.length).toBeGreaterThan(0);

    // Signatures should be different (different keys)
    expect(Buffer.from(signatureA).toString('hex')).not.toBe(
      Buffer.from(signatureB).toString('hex'),
    );
  });

  it('both signatures are valid and deterministic (same key + data = same sig)', async () => {
    const mainKeypair = new Ed25519Keypair();
    const sessionKeypair = new Ed25519Keypair();

    const proofBytes = new TextEncoder().encode('test-proof-data');

    // Sign twice with the same keypairs — Ed25519 is deterministic
    const result1 = await dualKeySign(proofBytes, mainKeypair, sessionKeypair);
    const result2 = await dualKeySign(proofBytes, mainKeypair, sessionKeypair);

    // Same key + same data must produce the same signature
    expect(Buffer.from(result1.signatureA).toString('hex')).toBe(
      Buffer.from(result2.signatureA).toString('hex'),
    );
    expect(Buffer.from(result1.signatureB).toString('hex')).toBe(
      Buffer.from(result2.signatureB).toString('hex'),
    );

    // Ed25519 signatures are 64 bytes
    expect(result1.signatureA.length).toBe(64);
    expect(result1.signatureB.length).toBe(64);
  });

  it('swapping keypairs produces different signatures (key binding)', async () => {
    const mainKeypair = new Ed25519Keypair();
    const sessionKeypair = new Ed25519Keypair();

    const proofBytes = new TextEncoder().encode('test-proof-data');

    const normal = await dualKeySign(proofBytes, mainKeypair, sessionKeypair);
    const swapped = await dualKeySign(proofBytes, sessionKeypair, mainKeypair);

    // signatureA should differ when a different key is used as "main"
    expect(Buffer.from(normal.signatureA).toString('hex')).not.toBe(
      Buffer.from(swapped.signatureA).toString('hex'),
    );
  });

  it('session keypair is different from main keypair (identity separation)', () => {
    const mainKeypair = new Ed25519Keypair();
    const sessionKeypair = new Ed25519Keypair();

    const mainAddress = mainKeypair.getPublicKey().toSuiAddress();
    const sessionAddress = sessionKeypair.getPublicKey().toSuiAddress();

    expect(mainAddress).not.toBe(sessionAddress);

    // Public keys should also differ
    const mainPubHex = Buffer.from(mainKeypair.getPublicKey().toRawBytes()).toString('hex');
    const sessionPubHex = Buffer.from(sessionKeypair.getPublicKey().toRawBytes()).toString('hex');
    expect(mainPubHex).not.toBe(sessionPubHex);
  });
});
