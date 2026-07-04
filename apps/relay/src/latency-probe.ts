/**
 * Relay-side latency probe — Task #26 (scope B).
 *
 * Polls mediasoup `Transport.getStats()` and emits `L_relay_fwd` events.
 * Off-by-default: returns `null` when `BENCH_LATENCY` env is unset, so the
 * call sites can be wired with zero overhead in production.
 *
 * Full activation (wire-in to room-handler / signaling.ts) is deferred to
 * `#26-followup`. The module ships now so #29 (capacity/multi-room stress)
 * inherits a stable API.
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
  /** Poll one transport once and emit `L_relay_fwd`. Safe to call from a hot loop. */
  sample(
    transport: msTypes.Transport,
    context: { roomId: string; peerId: string; transportId: string; nPeers?: number },
  ): Promise<void>;
  /** Spawn a 1-second poller for the given transport. Returns a stop fn. */
  startSampler(
    transport: msTypes.Transport,
    context: { roomId: string; peerId: string; transportId: string; nPeers?: number },
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
 *     if (probe !== null) probe.startSampler(transport, {...});
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
   * Extract a forwarding-latency proxy from mediasoup transport stats.
   *
   * mediasoup `Transport.getStats()` returns an array of `TransportStat` with
   * fields including `rtt` (ms, from RTCP receiver reports) and per-direction
   * byte counters. We use `rtt` as the closest proxy for `L_relay_fwd` since
   * the mediasoup-internal ingest→egress delta is not exposed.
   *
   * If no RTCP report has arrived yet, `rtt` is undefined; we skip the sample.
   */
  async function readRttFromStats(transport: msTypes.Transport): Promise<number | null> {
    try {
      const stats = await transport.getStats();
      for (const s of stats) {
        const rtt = (s as { rtt?: number }).rtt;
        if (typeof rtt === 'number' && rtt > 0) {
          return rtt;
        }
      }
      return null;
    } catch (err) {
      logger.debug({ err }, 'Transport getStats failed (probe sample skipped)');
      return null;
    }
  }

  return {
    async sample(transport, context) {
      const rtt = await readRttFromStats(transport);
      if (rtt !== null) {
        writer.write('L_relay_fwd', rtt, context);
      }
    },
    startSampler(transport, context) {
      const intervalMs = parseInt(process.env['BENCH_SAMPLE_INTERVAL_MS'] ?? '1000', 10);
      const handle = setInterval(() => {
        void readRttFromStats(transport).then((rtt) => {
          if (rtt !== null) {
            writer.write('L_relay_fwd', rtt, context);
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
