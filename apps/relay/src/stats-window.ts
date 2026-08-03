/**
 * Client-reported call-quality ring buffer, keyed by peerId.
 *
 * The relay has no server-side visibility into most of these fields (encode/
 * decode latency, freeze count, connection-setup time, ICE success, etc. are
 * only observable from inside the client's WebRTC stack) — they arrive
 * already-aggregated from the client via `POST /stats/report` (metrics-server.ts)
 * at roughly a 2s cadence. This module just retains a short rolling window
 * (~5 samples / ~10s) per peer and derives a single "current" reading: the
 * latest value for counters/discrete fields, a short moving average for
 * latency/jitter-like fields that benefit from smoothing.
 *
 * `packetReorderingRate` is an APPROXIMATION — the client computes it from its
 * own jitter-buffer stats, not from raw RTP sequence numbers observed here.
 */

export interface PeerQualitySample {
  latencyMs: number;
  packetLoss: number;
  jitterMs: number;
  bitrateUpKbps: number;
  bitrateDownKbps: number;
  resolutionWidth: number;
  resolutionHeight: number;
  framerate: number;
  /** Approximate — client-reported, not derived from raw RTP here. */
  packetReorderingRate: number;
  encodeLatencyMs: number;
  decodeLatencyMs: number;
  freezeCount: number;
  pauseCount: number;
  connectionSetupMs: number;
  iceSuccess: boolean;
  reconnectMs: number;
  /**
   * Client-computed audio-vs-video sync offset, ms (see useConnectionStats.ts's
   * avSyncDriftMs doc). Positive => audio playing out ahead of video. 0 is
   * overloaded ("no drift" AND "browser doesn't support estimatedPlayoutTimestamp
   * yet" AND "no video track"), same tradeoff the other 0-defaulted fields
   * above already accept -- see RoomPage.tsx's POST-boundary comment.
   */
  avSyncDriftMs: number;
}

interface WindowedSample {
  roomId: string;
  sample: PeerQualitySample;
  ts: number;
}

/**
 * Client-computed cumulative avg/min/max per field, since the peer joined the
 * room (see useConnectionStats.ts / RoomPage.tsx's aggregator ref) -- NOT the
 * relay's own SMOOTHED_FIELDS moving average below, which is a separate,
 * short (~5-sample) server-side smoothing mechanism. Optional: older/bot
 * clients that never send an `aggregates` body simply never populate this.
 */
export type PeerQualityAggregates = Record<keyof PeerQualitySample, { avg: number; min: number; max: number }>;

/** Fields smoothed via a short moving average across the retained window. */
const SMOOTHED_FIELDS = [
  'latencyMs',
  'jitterMs',
  'encodeLatencyMs',
  'decodeLatencyMs',
  'avSyncDriftMs',
] as const satisfies ReadonlyArray<keyof PeerQualitySample>;

const MAX_SAMPLES_PER_PEER = 5;

export class PeerStatsWindow {
  private windows = new Map<string, WindowedSample[]>();
  private aggregates = new Map<string, PeerQualityAggregates>();

  /** Push a new sample for `peerId`, evicting the oldest once the window is full. */
  push(
    roomId: string,
    peerId: string,
    sample: PeerQualitySample,
    now: number = Date.now(),
    aggregates?: PeerQualityAggregates,
  ): void {
    let buf = this.windows.get(peerId);
    if (!buf) {
      buf = [];
      this.windows.set(peerId, buf);
    }
    buf.push({ roomId, sample, ts: now });
    if (buf.length > MAX_SAMPLES_PER_PEER) {
      buf.shift();
    }
    if (aggregates) {
      this.aggregates.set(peerId, aggregates);
    }
  }

  /**
   * The latest client-reported cumulative avg/min/max for `peerId`, or
   * `undefined` if this peer has never sent an `aggregates` body.
   */
  currentAggregates(peerId: string): PeerQualityAggregates | undefined {
    return this.aggregates.get(peerId);
  }

  /**
   * Current derived reading for `peerId`: latest raw sample with the
   * latency/jitter-like fields replaced by their moving average over the
   * retained window. Returns `undefined` if no sample has been pushed.
   */
  current(peerId: string): (PeerQualitySample & { roomId: string; lastUpdatedAt: number }) | undefined {
    const buf = this.windows.get(peerId);
    if (!buf || buf.length === 0) return undefined;

    const latest = buf[buf.length - 1]!;
    const derived: PeerQualitySample = { ...latest.sample };

    for (const field of SMOOTHED_FIELDS) {
      let sum = 0;
      for (const w of buf) sum += w.sample[field];
      derived[field] = sum / buf.length;
    }

    return { ...derived, roomId: latest.roomId, lastUpdatedAt: latest.ts };
  }

  /** All peerIds with at least one retained sample. */
  peerIds(): string[] {
    return [...this.windows.keys()];
  }

  /** Drop a peer's window entirely (e.g. on disconnect). */
  clear(peerId: string): void {
    this.windows.delete(peerId);
    this.aggregates.delete(peerId);
  }
}

let globalWindow: PeerStatsWindow | null = null;

/** Process-wide singleton, mirroring `metrics.ts`'s single-tracker convention. */
export function getGlobalStatsWindow(): PeerStatsWindow {
  if (!globalWindow) {
    globalWindow = new PeerStatsWindow();
  }
  return globalWindow;
}

/** Test-only reset of the module singleton. */
export function resetGlobalStatsWindowForTests(): void {
  globalWindow = null;
}
