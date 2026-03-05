/**
 * Tests for simulated measurement collection.
 *
 * Verifies that collectMeasurements returns realistic values
 * with correct types (all bigint) and within expected ranges.
 */

import { describe, it, expect } from 'vitest';
import { collectMeasurements, type MeasurementResult } from '../measurements.js';

describe('collectMeasurements', () => {
  const RELAY_ID = '0xabc123';

  function collect(): MeasurementResult {
    return collectMeasurements(RELAY_ID);
  }

  it('returns all fields as bigint', () => {
    const m = collect();
    expect(typeof m.packetsSent).toBe('bigint');
    expect(typeof m.packetsReceived).toBe('bigint');
    expect(typeof m.packetLossRate).toBe('bigint');
    expect(typeof m.avgLatencyMs).toBe('bigint');
    expect(typeof m.jitterMs).toBe('bigint');
    expect(typeof m.bytesForwarded).toBe('bigint');
    expect(typeof m.measurementDurationMs).toBe('bigint');
    expect(typeof m.timestamp).toBe('bigint');
  });

  it('packetLossRate is 0-500bp (0-5% loss range)', () => {
    // Run multiple times to increase confidence
    for (let i = 0; i < 20; i++) {
      const m = collect();
      expect(m.packetLossRate).toBeGreaterThanOrEqual(0n);
      expect(m.packetLossRate).toBeLessThanOrEqual(500n);
    }
  });

  it('avgLatencyMs is in realistic range (20-150ms)', () => {
    for (let i = 0; i < 20; i++) {
      const m = collect();
      expect(m.avgLatencyMs).toBeGreaterThanOrEqual(20n);
      expect(m.avgLatencyMs).toBeLessThanOrEqual(150n);
    }
  });

  it('bytesForwarded is positive', () => {
    const m = collect();
    expect(m.bytesForwarded).toBeGreaterThan(0n);
  });

  it('timestamp is set to a reasonable epoch value', () => {
    const m = collect();
    // Should be a recent timestamp (after 2024)
    const year2024 = BigInt(new Date('2024-01-01').getTime());
    expect(m.timestamp).toBeGreaterThan(year2024);
  });

  it('relayMinerId matches input', () => {
    const m = collect();
    expect(m.relayMinerId).toBe(RELAY_ID);
  });

  it('measurementDurationMs is 60000 (1 minute window)', () => {
    const m = collect();
    expect(m.measurementDurationMs).toBe(60_000n);
  });

  it('packetsReceived is at most packetsSent', () => {
    for (let i = 0; i < 20; i++) {
      const m = collect();
      expect(m.packetsReceived).toBeLessThanOrEqual(m.packetsSent);
    }
  });
});
