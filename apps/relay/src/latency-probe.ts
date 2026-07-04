/**
 * Relay-side latency probe — Task #26 (scope B) + `#26-rtt-followup`.
 *
 * Emits `L_relay_fwd` (relay→client forwarding latency, ms) by reading the
 * RTCP RR `roundTripTime` from the relay→client **Consumer**'s RTP-stream stat.
 * NOTE: `Transport.getStats()` has NO `rtt` field on any transport type
 * (empirically proven by two in-process mediasoup probes), so the metric is
 * sourced from the Consumer — mirroring the `t_hop_network` Producer path.
 * Wired in `signaling.ts handleConsume` (once a Consumer exists), NOT in
 * `handleCreateTransport` (a bare transport carries no RTP object).
 *
 * Off-by-default: returns `null` when `BENCH_LATENCY` env is unset, so the
 * call sites can be wired with zero overhead in production.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 */

import type { types as msTypes } from 'mediasoup';
import {
  LatencyWriter,
  isBenchEnabled,
  type Logger,
} from '@dvconf/shared';

export interface RelayLatencyProbe {
  /**
   * Poll one relay→client Consumer once and emit `L_relay_fwd` = the Consumer's
   * RTCP RR `roundTripTime` (RAW round-trip, ms — NOT halved). Safe to call from
   * a hot loop; skips the sample until an RTCP RR has populated `roundTripTime`.
   */
  sample(
    consumer: msTypes.Consumer,
    context: {
      roomId: string;
      peerId: string;
      /** The relay→client recv transport id the Consumer lives on (absent if not resolvable). */
      transportId?: string;
      consumerId?: string;
      nPeers?: number;
    },
  ): Promise<void>;
  /**
   * Spawn a 1-second poller for the given relay→client Consumer, emitting
   * `L_relay_fwd` from its RTCP RR `roundTripTime` (raw rtt). Returns a stop fn.
   */
  startSampler(
    consumer: msTypes.Consumer,
    context: {
      roomId: string;
      peerId: string;
      /** The relay→client recv transport id the Consumer lives on (absent if not resolvable). */
      transportId?: string;
      consumerId?: string;
      nPeers?: number;
    },
  ): () => void;
  /**
   * Lane-B inter-relay hop probe. Reads `roundTripTime` from the RECEIVER's
   * `inbound-rtp` stat (lives on a piped Producer, not the Consumer/outbound-rtp
   * side — empirically verified). Emits `t_hop_network = rtt/2` (ms).
   */
  sampleRtpStream(
    producer: msTypes.Producer,
    context: { fromRelay: string; toRelay: string },
  ): Promise<void>;
  /**
   * Spawn a 1-second interval poller for `t_hop_network` on the given piped
   * producer. Mirrors `startSampler`; reads `BENCH_SAMPLE_INTERVAL_MS`.
   * Returns a stop fn — call it (or wire to producer `'close'`) to halt.
   */
  startRtpStreamSampler(
    producer: msTypes.Producer,
    context: { fromRelay: string; toRelay: string },
  ): () => void;
  close(): void;
}

/** PURE. One-way inter-relay network hop from a round-trip pipe RTT (ms). Null if rtt <= 0. */
export function tHopNetworkFromRtt(rttMs: number): number | null {
  return rttMs > 0 ? rttMs / 2 : null;
}

/**
 * Create a relay latency probe. Returns `null` if `BENCH_LATENCY` is unset
 * so call sites can branch trivially:
 *
 *     const probe = createRelayLatencyProbe('relay-0xabc', logger);
 *     if (probe !== null) probe.startSampler(consumer, {...});
 */
export function createRelayLatencyProbe(
  instance: string,
  logger: Logger,
): RelayLatencyProbe | null {
  if (!isBenchEnabled()) {
    return null;
  }

  const writer = new LatencyWriter({ source: 'relay', instance });
  logger.info(
    { traceId: writer.traceId, scenario: writer.scenario, file: writer.getFilePath() },
    'Latency benchmark probe ENABLED',
  );

  /**
   * Read `roundTripTime` (RTCP RR, ms) from an RTP-stream object's stats.
   *
   * Serves BOTH metrics: a piped Producer (`t_hop_network`, Lane B) and a
   * relay→client Consumer (`L_relay_fwd`, `#26-rtt-followup`). RTT lives on the
   * RTP-stream stat, NOT on `Transport.getStats()` (which has no `rtt` field —
   * empirically proven).
   *
   * `statType` (optional) pins WHICH stream to read. `Consumer.getStats()`
   * returns BOTH the Consumer's own send stream (`outbound-rtp`, the relay→client
   * leg = what `L_relay_fwd` means) AND the underlying Producer's recv stream
   * (`inbound-rtp`, the UPSTREAM publisher→relay leg); both carry `roundTripTime`.
   * Without a filter, first-positive could silently read the UPSTREAM hop and
   * mislabel it. When `statType` is omitted the behaviour is IDENTICAL to before
   * (first positive) — so the t_hop Producer callers stay byte-identical.
   *
   * Empirical grounding (`0.0152587890625 ms` on a REAL cross-worker pipe after
   * ~6 s of RTCP exchange) is from the pipe/Producer (`inbound-rtp`) path ONLY.
   * The Consumer/`outbound-rtp` side (`L_relay_fwd`) is NOT yet empirically
   * verified — it needs a real browser's RTCP RR (not producible in-process), so
   * it is a live-run item and correctly stays SILENT until that stat populates.
   * Units = milliseconds (mediasoup reports fractional ms for sub-ms loopback).
   */
  async function readRttFromRtpStream(
    rtpObject: msTypes.Producer | msTypes.Consumer,
    statType?: string,
  ): Promise<number | null> {
    try {
      const stats = await rtpObject.getStats();
      for (const s of stats) {
        if (statType !== undefined && (s as { type?: string }).type !== statType) continue;
        const rtt = (s as { roundTripTime?: number }).roundTripTime;
        if (typeof rtt === 'number' && rtt > 0) return rtt;
      }
      return null;
    } catch (err) {
      logger.debug({ err }, 'RTP-stream getStats failed (latency sample skipped)');
      return null;
    }
  }

  return {
    async sample(consumer, context) {
      // L_relay_fwd = the relay→client SEND leg → read the Consumer's own
      // `outbound-rtp` stat ONLY (never the underlying producer's inbound hop).
      const rtt = await readRttFromRtpStream(consumer, 'outbound-rtp');
      if (rtt !== null) {
        writer.write('L_relay_fwd', rtt, context);
      }
    },
    startSampler(consumer, context) {
      const intervalMs = parseInt(process.env['BENCH_SAMPLE_INTERVAL_MS'] ?? '1000', 10);
      const handle = setInterval(() => {
        void readRttFromRtpStream(consumer, 'outbound-rtp').then((rtt) => {
          if (rtt !== null) {
            writer.write('L_relay_fwd', rtt, context);
          }
        });
      }, intervalMs);
      return () => clearInterval(handle);
    },
    async sampleRtpStream(producer, context) {
      const rtt = await readRttFromRtpStream(producer);
      if (rtt !== null) {
        const oneWay = tHopNetworkFromRtt(rtt);
        if (oneWay !== null) {
          writer.write('t_hop_network', oneWay, { ...context, leg: 'inter-relay' });
        }
      }
    },
    startRtpStreamSampler(producer, context) {
      const intervalMs = parseInt(process.env['BENCH_SAMPLE_INTERVAL_MS'] ?? '1000', 10);
      const handle = setInterval(() => {
        void readRttFromRtpStream(producer).then((rtt) => {
          if (rtt !== null) {
            const oneWay = tHopNetworkFromRtt(rtt);
            if (oneWay !== null) {
              writer.write('t_hop_network', oneWay, { ...context, leg: 'inter-relay' });
            }
          }
        });
      }, intervalMs);
      return () => clearInterval(handle);
    },
    close() {
      writer.close();
    },
  };
}
