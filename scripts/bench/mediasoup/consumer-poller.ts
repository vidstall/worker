/**
 * Consumer/transport stats poller for the mediasoup-client bench harness.
 * Split out of `mediasoup-client-harness.ts` — see that file's header for
 * the harness-wide module layout notes.
 */

import {
  CAPTURE_ENCODE_RENDER_MS,
  computeG2GoptB,
  extractRelevantStats,
  extractRttOnly,
  type StatsReportLike,
} from './stats.ts';

export interface ConsumerLike {
  getStats: () => Promise<StatsReportLike>;
}

export interface TransportLike {
  getStats: () => Promise<StatsReportLike>;
}

export interface WriterLike {
  write: (
    metric: string,
    value_ms: number,
    context?: Record<string, unknown>,
  ) => void;
}

export interface ConsumerPollerOpts {
  /** Optional transport. Tried FIRST — RTCPeerConnection.getStats() may
   *  be implemented even when RTCRtpReceiver.getStats() is not (CI-20:
   *  @roamhq/wrtc on Node throws "Not yet implemented; file a feature
   *  request against node-webrtc" on receiver.getStats but the underlying
   *  PeerConnection.getStats may return candidate-pair RTT). */
  transport?: TransportLike;
}

/**
 * Poll a Consumer's getStats() at `intervalMs`, write one `L_g2g_optB` event
 * per successful poll. Returns a cancel function — call it from peer cleanup.
 * Transient `getStats()` failures are swallowed (one bad tick must not stop
 * the whole sampler).
 *
 * CI-20 (S25.C-followup): when an optional `transport` is supplied, the
 * poller tries `transport.getStats()` first — this proxies to
 * RTCPeerConnection.getStats() which @roamhq/wrtc may implement even when
 * Consumer-level (RTCRtpReceiver.getStats) is not. If only RTT is available
 * (no jitterBufferDelay), the poller emits `L_g2g_RTT_proxy` (RTT/2 + 50 ms)
 * instead of `L_g2g_optB` — a narrowed metric disclosed in ch5 §5.2.7.
 */
export function startConsumerPoller(
  consumer: ConsumerLike,
  writer: WriterLike,
  context: Record<string, unknown>,
  intervalMs = 1000,
  pollerOpts: ConsumerPollerOpts = {},
): () => void {
  let stopped = false;
  let tickCount = 0;
  let writeCount = 0;
  let nullCount = 0;
  let errCount = 0;

  const debug = process.env['BENCH_DEBUG_STATS'] === '1';
  const transport = pollerOpts.transport;

  // Try transport first if provided; on failure fall back to consumer.
  // Returns null if both sources fail or yield no usable stats.
  const fetchReport = async (): Promise<StatsReportLike | null> => {
    if (transport !== undefined) {
      try {
        return await transport.getStats();
      } catch {
        // fall through to consumer
      }
    }
    try {
      return await consumer.getStats();
    } catch {
      return null;
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    tickCount++;
    const report = await fetchReport();
    if (report === null) {
      errCount++;
      if (debug && errCount <= 2) {
        console.log(
          `[debug-poll consumer=${String(context['consumer_id'])}] tick=${tickCount} both transport+consumer getStats failed`,
        );
      }
      return;
    }
    // S25.C-followup.C decision: on Node + @roamhq/wrtc the W3C-spec'd
    // `jitterBufferDelay` unit (seconds) is mis-reported as milliseconds —
    // makes `L_g2g_optB = RTT/2 + jitter*1000 + 50` produce values in the
    // tens of millions of ms after a few seconds of streaming. The full
    // Option-B sum is therefore unreliable on this binding.
    //
    // Primary emitted metric is the **narrowed Option B**:
    //   `L_g2g_RTT_proxy = currentRoundTripTime/2 + 50 ms`
    // (capture/encode/render constant only; drops jitter contribution).
    // Bound: under-counts true L_g2g by the per-frame jitter buffer delay,
    // typically 20–60 ms per W3C reference samples. Methodology §1.3
    // already labelled the Option-B error term as ±30–80 ms; the narrowed
    // variant lands on the under-estimate side. Disclosure: ch5 §5.2.7.
    const rttOnly = extractRttOnly(report);
    if (rttOnly !== null) {
      writer.write(
        'L_g2g_RTT_proxy',
        (rttOnly * 1000) / 2 + CAPTURE_ENCODE_RENDER_MS,
        context,
      );
      writeCount++;
    } else {
      nullCount++;
    }
    // `extractRelevantStats` retained as importable helper for future
    // browser-side harness or post-binding-fix re-enable — read but not
    // emitted from Node today.
    void extractRelevantStats;
    void computeG2GoptB;
    if (debug && tickCount <= 3) {
      console.log(
        `[debug-poll consumer=${String(context['consumer_id'])}] tick=${tickCount} stats=${stats === null ? 'null' : 'ok'} writes=${writeCount} nulls=${nullCount}`,
      );
    }
  };

  const handle = setInterval(() => {
    void tick();
  }, intervalMs);

  // Fire an immediate sample so short durations capture at least one event.
  void tick();

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
