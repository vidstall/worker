/**
 * Tests for real-probe measurement collection (RO-019b).
 *
 * collectMeasurements derives a MeasurementResult from an injected probe
 * transport (real STUN/metrics in production; a deterministic fake here).
 * Verifies the values come from the probe (NOT random) and all fields are
 * bigint (basis-point invariant).
 */

import { describe, it, expect } from 'vitest';
import {
  collectMeasurements,
  type MeasurementResult,
  type ProbeSample,
} from '../measurements.js';

const RELAY_ID = '0xabc123';

/** A deterministic probe sample with fixed, recognizable values. */
function fixedSample(overrides: Partial<ProbeSample> = {}): ProbeSample {
  return {
    avgLatencyMs: 42n,
    jitterMs: 7n,
    packetLossBps: 250n,
    packetsSent: 20_000n,
    packetsReceived: 19_500n,
    bytesForwarded: 12_345_678n,
    uniquePeers: 4n,
    durationSeconds: 60n,
    ...overrides,
  };
}

function fakeProbe(sample: ProbeSample): () => Promise<ProbeSample> {
  return () => Promise.resolve(sample);
}

describe('collectMeasurements (RO-019b real probe)', () => {
  it('returns all fields as bigint', async () => {
    const m = await collectMeasurements(RELAY_ID, fakeProbe(fixedSample()));
    expect(typeof m.packetsSent).toBe('bigint');
    expect(typeof m.packetsReceived).toBe('bigint');
    expect(typeof m.packetLossRate).toBe('bigint');
    expect(typeof m.avgLatencyMs).toBe('bigint');
    expect(typeof m.jitterMs).toBe('bigint');
    expect(typeof m.bytesForwarded).toBe('bigint');
    expect(typeof m.uniquePeers).toBe('bigint');
    expect(typeof m.measurementDurationMs).toBe('bigint');
    expect(typeof m.timestamp).toBe('bigint');
  });

  it('avgLatencyMs comes from the probe (NOT random)', async () => {
    const m = await collectMeasurements(RELAY_ID, fakeProbe(fixedSample({ avgLatencyMs: 99n })));
    expect(m.avgLatencyMs).toBe(99n);
  });

  it('jitterMs, packetLossRate, bytesForwarded, uniquePeers come from the probe', async () => {
    const m = await collectMeasurements(
      RELAY_ID,
      fakeProbe(fixedSample({
        jitterMs: 11n,
        packetLossBps: 333n,
        bytesForwarded: 7_777n,
        uniquePeers: 9n,
      })),
    );
    expect(m.jitterMs).toBe(11n);
    expect(m.packetLossRate).toBe(333n);
    expect(m.bytesForwarded).toBe(7_777n);
    expect(m.uniquePeers).toBe(9n);
  });

  it('measurementDurationMs reflects the probe duration_seconds (> 0)', async () => {
    const m = await collectMeasurements(RELAY_ID, fakeProbe(fixedSample({ durationSeconds: 30n })));
    expect(m.measurementDurationMs).toBe(30_000n);
    expect(m.measurementDurationMs).toBeGreaterThan(0n);
  });

  it('is deterministic for a fixed probe sample (no randomness left)', async () => {
    const sample = fixedSample();
    const a = await collectMeasurements(RELAY_ID, fakeProbe(sample));
    const b = await collectMeasurements(RELAY_ID, fakeProbe(sample));
    expect(a.avgLatencyMs).toBe(b.avgLatencyMs);
    expect(a.jitterMs).toBe(b.jitterMs);
    expect(a.packetLossRate).toBe(b.packetLossRate);
    expect(a.bytesForwarded).toBe(b.bytesForwarded);
    expect(a.packetsSent).toBe(b.packetsSent);
  });

  it('relayMinerId matches input', async () => {
    const m: MeasurementResult = await collectMeasurements(RELAY_ID, fakeProbe(fixedSample()));
    expect(m.relayMinerId).toBe(RELAY_ID);
  });

  it('packetsReceived is at most packetsSent', async () => {
    const m = await collectMeasurements(RELAY_ID, fakeProbe(fixedSample()));
    expect(m.packetsReceived).toBeLessThanOrEqual(m.packetsSent);
  });

  it('timestamp is a reasonable epoch value', async () => {
    const m = await collectMeasurements(RELAY_ID, fakeProbe(fixedSample()));
    const year2024 = BigInt(new Date('2024-01-01').getTime());
    expect(m.timestamp).toBeGreaterThan(year2024);
  });
});
