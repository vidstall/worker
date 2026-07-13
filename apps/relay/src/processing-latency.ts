/**
 * Relay-processing latency (REQ-WLM-08) — pure correlation + summary helpers.
 *
 * The T-L latency model's per-hop term `tHop` was measured as `t_hop_network`
 * only (Lane-B, RTCP RR roundTripTime/2 = the WAN wire). It carried NO measure
 * of the latency the relay itself ADDS per hop (receive → route → re-mint →
 * enqueue-to-send), because mediasoup `getStats()` does not expose it.
 *
 * The hermetic bench (`__tests__/integration/processing-latency-bench.integration.test.ts`)
 * drives real RTP through a real mediasoup Router (DirectTransport in → same
 * Router → DirectTransport out), stamps `performance.now()` on send + on the
 * consumer `'rtp'` event, and correlates the two by an in-payload counter (RTP
 * seq is re-minted by the consumer, so seq cannot be the key; the media payload
 * is forwarded byte-identical, so an embedded counter can). These pure helpers
 * do the correlation + percentile summary so that logic is unit-tested (`pnpm
 * test`) independently of the real-worker bench.
 *
 * IMPORTANT — the measured number is a CONSERVATIVE PROXY for the tested
 * DirectTransport path, NOT a bound on production forwarding or its scheduling
 * tails: the DirectTransport in/out path crosses the JS↔C++ worker channel twice
 * (marshalling that a real UDP WebRtc/Pipe forward, which stays entirely in C++,
 * does NOT incur), so it overstates the tested path's marshalling — but production
 * adds SRTP, the real UDP stack, and load-dependent scheduling tails this
 * single-box bench cannot bound. Reported as a separately-measured term, never
 * folded into `t_hop_network`.
 *
 * Methodology + result: `docs/80-research/evaluation/star-wan-results.md`
 * (Lane-B processing term) and `docs/80-research/evaluation/evaluation-roadmap.md`
 * (REQ-WLM-08).
 */

/**
 * Nearest-rank percentile on a pre-sorted ascending array. `p` is a FRACTION
 * (0..1). Mirrors `scripts/bench/replay.ts` `percentile` exactly so every bench
 * percentile in this repo uses one convention (no interpolation, conservative).
 * Caller MUST sort ascending first. Returns NaN for empty input.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const rank = Math.ceil(p * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx]!;
}

/** One received RTP packet: the recovered in-payload counter + its recv wall-clock (ms). */
export interface RecvEvent {
  counter: number;
  recvMs: number;
}

/**
 * Correlate received packets back to their send timestamps by the embedded
 * counter, yielding one forward-latency delta (ms) per matched packet, in recv
 * order. Received counters with no send record (never sent, or evicted) are
 * skipped — the bench asserts the match count so silent loss cannot hide.
 */
export function correlateForwardLatency(
  sendAtMs: ReadonlyMap<number, number>,
  recvEvents: readonly RecvEvent[],
): number[] {
  const deltas: number[] = [];
  for (const ev of recvEvents) {
    const t0 = sendAtMs.get(ev.counter);
    if (t0 !== undefined) deltas.push(ev.recvMs - t0);
  }
  return deltas;
}

export interface ProcessingLatencySummary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
}

/** Sort + summarize forward-latency deltas (ms). Empty input → n=0, NaN stats. */
export function summarizeProcessingLatency(samples: number[]): ProcessingLatencySummary {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = n === 0 ? NaN : s.reduce((acc, x) => acc + x, 0) / n;
  return {
    n,
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    min: n === 0 ? NaN : s[0]!,
    max: n === 0 ? NaN : s[n - 1]!,
    mean,
  };
}
