/**
 * RTCStats extraction + methodology §3.2 arithmetic for the mediasoup-client
 * bench harness. Split out of `mediasoup-client-harness.ts` — see that file's
 * header for the harness-wide module layout notes.
 */

/**
 * Methodology §3.2 capture/encode/render constant — a fixed 50 ms placeholder
 * accounting for camera-firmware capture + codec encode + decode + paint on
 * commodity hardware. Validated by Option-A cross-check in S-baseline.
 */
export const CAPTURE_ENCODE_RENDER_MS = 50;

export interface RelevantStats {
  /** WebRTC reports `currentRoundTripTime` in seconds. */
  currentRoundTripTime: number;
  /** WebRTC reports `jitterBufferDelay` as total seconds (cumulative). */
  jitterBufferDelay: number;
}

export function computeG2GoptB(stats: RelevantStats): number {
  const rttMs = stats.currentRoundTripTime * 1000;
  const jitterMs = stats.jitterBufferDelay * 1000;
  return rttMs / 2 + jitterMs + CAPTURE_ENCODE_RENDER_MS;
}

export interface StatEntry {
  type?: string;
  [k: string]: unknown;
}

export interface StatsReportLike {
  values: () => Iterable<StatEntry>;
}

/**
 * Walks a `RTCStatsReport`-shaped object, returning the rtt + jitter pair the
 * methodology needs, or `null` if either is missing (e.g. the candidate pair
 * has not yet finished probing).
 */
let statsDumpCount = 0;
const STATS_DUMP_MAX = 2;
export function extractRelevantStats(
  report: StatsReportLike,
): RelevantStats | null {
  let rtt: number | undefined;
  let jitter: number | undefined;
  const collected: StatEntry[] = [];
  for (const stat of report.values()) {
    collected.push(stat);
    if (
      stat.type === 'candidate-pair' &&
      typeof stat['currentRoundTripTime'] === 'number'
    ) {
      rtt = stat['currentRoundTripTime'] as number;
    } else if (
      stat.type === 'inbound-rtp' &&
      typeof stat['jitterBufferDelay'] === 'number'
    ) {
      jitter = stat['jitterBufferDelay'] as number;
    }
  }
  // DEBUG S25.C-followup.A — dump first 2 reports to identify field mapping.
  // Removed after triage (S25.C-followup.C).
  if (statsDumpCount < STATS_DUMP_MAX && process.env['BENCH_DEBUG_STATS'] === '1') {
    statsDumpCount++;
    const summary = collected.map((s) => ({
      type: s.type,
      keys: Object.keys(s).filter((k) => k !== 'type').slice(0, 12),
    }));
    console.log(
      `[debug-stats #${statsDumpCount}] entries=${collected.length} rtt=${rtt} jitter=${jitter}`,
    );
    console.log(`[debug-stats #${statsDumpCount}] shape=${JSON.stringify(summary)}`);
  }
  if (rtt === undefined || jitter === undefined) return null;
  return { currentRoundTripTime: rtt, jitterBufferDelay: jitter };
}

/**
 * Narrowed-metric fallback (S25.C-followup): pluck ICE `currentRoundTripTime`
 * alone from candidate-pair stats when full Option-B data is unavailable
 * (jitterBufferDelay is per-RTP-receiver and @roamhq/wrtc may not emit it).
 * Used to drive `L_g2g_RTT_proxy = RTT/2 + 50 ms`.
 *
 * Accepts RTT = 0 (valid on localhost loopback — sub-microsecond probe
 * RTT rounds to 0). Returns null only when the candidate-pair stat is
 * absent or the value is non-numeric.
 */
export function extractRttOnly(report: StatsReportLike): number | null {
  for (const stat of report.values()) {
    if (
      stat.type === 'candidate-pair' &&
      typeof stat['currentRoundTripTime'] === 'number'
    ) {
      return stat['currentRoundTripTime'] as number;
    }
  }
  return null;
}

/**
 * SMH-LIVE (D2 real-continuity): sum `bytesReceived` across every `inbound-rtp` entry in a
 * stats report. On a recv transport (RTCPeerConnection-level) this is the TOTAL inbound media
 * bytes across all of a peer's consumers; on a single Consumer it is that consumer's bytes.
 * `> 0` proves REAL media flowed through the relay mesh (not just an RPC/on-chain claim).
 */
export function extractBytesReceived(report: StatsReportLike): number {
  let total = 0;
  for (const stat of report.values()) {
    if (stat.type === 'inbound-rtp' && typeof stat['bytesReceived'] === 'number') {
      total += stat['bytesReceived'] as number;
    }
  }
  return total;
}
