/**
 * Simulated measurement collection for the Validator daemon.
 *
 * In production, measurements would come from actual network probing
 * (packet integrity, latency, loss, bytes forwarded). For this phase,
 * values are simulated with realistic ranges.
 *
 * All values are bigint — never floating point (basis-point invariant).
 */

import { createLogger } from '@dvconf/shared';

const logger = createLogger('validator:measurements');

/** Result of a single measurement window against a relay. */
export interface MeasurementResult {
  /** Which relay was measured (miner ID). */
  relayMinerId: string;
  /** Total packets sent through relay. */
  packetsSent: bigint;
  /** Packets received back (integrity check). */
  packetsReceived: bigint;
  /** Packet loss rate in basis points (0-10000). */
  packetLossRate: bigint;
  /** Average round-trip latency in milliseconds. */
  avgLatencyMs: bigint;
  /** Latency variation (jitter) in milliseconds. */
  jitterMs: bigint;
  /** Total bytes the relay forwarded during measurement window. */
  bytesForwarded: bigint;
  /** Duration of the measurement window in milliseconds. */
  measurementDurationMs: bigint;
  /** Epoch timestamp when measurement was taken. */
  timestamp: bigint;
}

/**
 * Generate a random bigint in [min, max] range (inclusive).
 */
function randomBigInt(min: number, max: number): bigint {
  return BigInt(Math.floor(Math.random() * (max - min + 1)) + min);
}

/**
 * Collect simulated measurements for a relay.
 *
 * Generates realistic values:
 * - packetsSent: 10,000 - 50,000
 * - packetsReceived: 95-100% of sent (0-5% loss)
 * - avgLatencyMs: 20-150ms
 * - jitterMs: 2-20ms
 * - bytesForwarded: 1MB - 100MB
 * - measurementDurationMs: 60,000ms (1 minute window)
 */
export function collectMeasurements(relayMinerId: string): MeasurementResult {
  const packetsSent = randomBigInt(10_000, 50_000);

  // Loss: 0-5% => received = 95-100% of sent
  const lossPercent = randomBigInt(0, 5);
  const packetsReceived =
    (packetsSent * (100n - lossPercent)) / 100n;

  // Loss rate in basis points (0-500bp for 0-5%)
  const packetLossRate =
    packetsSent > 0n
      ? ((packetsSent - packetsReceived) * 10_000n) / packetsSent
      : 0n;

  const avgLatencyMs = randomBigInt(20, 150);
  const jitterMs = randomBigInt(2, 20);

  // Bytes forwarded: 1MB (1,048,576) to 100MB (104,857,600)
  const bytesForwarded = randomBigInt(1_048_576, 104_857_600);

  const measurementDurationMs = 60_000n;
  const timestamp = BigInt(Date.now());

  const result: MeasurementResult = {
    relayMinerId,
    packetsSent,
    packetsReceived,
    packetLossRate,
    avgLatencyMs,
    jitterMs,
    bytesForwarded,
    measurementDurationMs,
    timestamp,
  };

  logger.info(
    {
      relayMinerId,
      lossRate: packetLossRate.toString(),
      latency: avgLatencyMs.toString(),
      bytes: bytesForwarded.toString(),
    },
    `Simulated measurement for relay ${relayMinerId}: loss=${packetLossRate}bp, latency=${avgLatencyMs}ms, bytes=${bytesForwarded}`,
  );

  return result;
}
