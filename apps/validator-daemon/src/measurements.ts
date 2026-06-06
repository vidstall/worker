/**
 * Real-probe measurement collection for the Validator daemon (RO-019b).
 *
 * A measurement window is derived from a `MeasurementProbe` transport — in
 * production this wraps the STUN probe (latency/jitter/loss) + the relay
 * metrics HTTP fetch (bytes/peers/duration); in tests a deterministic fake is
 * injected. The legacy *simulated* random generator (OFF-3) has been removed:
 * the values now come from the probe, not `Math.random()`.
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
  /** Unique peers seen by the relay for this room (reconciles OFF-3). */
  uniquePeers: bigint;
  /** Duration of the measurement window in milliseconds. */
  measurementDurationMs: bigint;
  /** Epoch timestamp when measurement was taken. */
  timestamp: bigint;
}

/**
 * A single probe sample — the raw, real network-measured inputs that a
 * `MeasurementProbe` resolves. All values are already in their on-chain units
 * (bigint, basis points for loss, ms for latency/jitter, seconds for duration).
 */
export interface ProbeSample {
  /** Average round-trip latency in milliseconds (from STUN RTT). */
  avgLatencyMs: bigint;
  /** Inter-arrival jitter in milliseconds. */
  jitterMs: bigint;
  /** Packet loss in basis points (lost/sent * 10000). */
  packetLossBps: bigint;
  /** Total probes/packets sent during the window. */
  packetsSent: bigint;
  /** Probes/packets received back. */
  packetsReceived: bigint;
  /** Total bytes the relay forwarded for this room. */
  bytesForwarded: bigint;
  /** Unique peers seen by the relay for this room. */
  uniquePeers: bigint;
  /** Measurement window duration in seconds (> 0 when the probe answered). */
  durationSeconds: bigint;
}

/**
 * A probe transport: resolves a real {@link ProbeSample} for a relay.
 *
 * Production wiring (see `index.ts`) composes the STUN probe + relay metrics
 * fetch into one of these; unit tests inject a deterministic fake.
 */
export type MeasurementProbe = (relayMinerId: string) => Promise<ProbeSample>;

/**
 * Collect a real measurement for a relay by running the injected probe.
 *
 * RO-019b: the random simulation is gone — every field is derived from the
 * probe sample. `measurementDurationMs` mirrors the probe's `durationSeconds`
 * (in ms); a probe that did not answer (`durationSeconds == 0`) yields a
 * zero-duration window, which the on-chain standby liveness gate reads.
 */
export async function collectMeasurements(
  relayMinerId: string,
  probe: MeasurementProbe,
): Promise<MeasurementResult> {
  const sample = await probe(relayMinerId);

  // Clamp packetsReceived <= packetsSent (integrity invariant).
  const packetsReceived =
    sample.packetsReceived > sample.packetsSent ? sample.packetsSent : sample.packetsReceived;

  const result: MeasurementResult = {
    relayMinerId,
    packetsSent: sample.packetsSent,
    packetsReceived,
    packetLossRate: sample.packetLossBps,
    avgLatencyMs: sample.avgLatencyMs,
    jitterMs: sample.jitterMs,
    bytesForwarded: sample.bytesForwarded,
    uniquePeers: sample.uniquePeers,
    measurementDurationMs: sample.durationSeconds * 1000n,
    timestamp: BigInt(Date.now()),
  };

  logger.info(
    {
      relayMinerId,
      lossRate: result.packetLossRate.toString(),
      latency: result.avgLatencyMs.toString(),
      bytes: result.bytesForwarded.toString(),
      uniquePeers: result.uniquePeers.toString(),
      durationMs: result.measurementDurationMs.toString(),
    },
    `Measured relay ${relayMinerId}: loss=${result.packetLossRate}bp, latency=${result.avgLatencyMs}ms, bytes=${result.bytesForwarded}, peers=${result.uniquePeers}`,
  );

  return result;
}
