/**
 * Server-side WebRTC quality gauges for the academic-eval "Media Quality"
 * dashboard row. Fed from the SAME getStats() polls the byteSampler loop in
 * signaling/index.ts already performs every RELAY_BYTE_SAMPLE_MS (default
 * 3000ms) -- this module adds zero new polling, only reads more fields off
 * an already-fetched stats object.
 *
 * Distinct from the `dvconf_relay_peer_*` gauges in metrics-server.ts, which
 * are fed by CLIENT-reported (POST /stats/report, opt-in) samples. These
 * gauges are a SERVER-observed, always-on signal (mediasoup's own RTP stream
 * stats), so the two can disagree -- that disagreement is itself informative
 * (e.g. client-perceived jitter vs. relay-observed jitter).
 */
import { createGauge, type Registry } from '@dvconf/shared';
import type { Gauge } from 'prom-client';

export type RtcDirection = 'up' | 'down';
export type RtcMediaKind = 'audio' | 'video';

export interface RtcQualitySample {
  jitterMs?: number;
  packetLossRatio?: number;
  bitrateKbps?: number;
  rttMs?: number;
}

type Labels = 'roomId' | 'peerId' | 'direction' | 'kind';

interface State {
  jitter: Gauge<Labels>;
  packetLoss: Gauge<Labels>;
  bitrate: Gauge<Labels>;
  rtt: Gauge<Labels>;
}

let state: State | null = null;

/** Wire the `dvconf_rtc_*` gauges -- call once at relay startup. */
export function registerRtcQualityMetrics(registry: Registry): void {
  state = {
    jitter: createGauge(
      registry,
      'dvconf_rtc_jitter_ms',
      'RTP jitter observed server-side by mediasoup, converted from RTP timestamp units via the stream codec clockRate',
      ['roomId', 'peerId', 'direction', 'kind'],
    ),
    packetLoss: createGauge(
      registry,
      'dvconf_rtc_packet_loss_ratio',
      'RTP fractionLost observed server-side by mediasoup (0..1)',
      ['roomId', 'peerId', 'direction', 'kind'],
    ),
    bitrate: createGauge(
      registry,
      'dvconf_rtc_bitrate_kbps',
      'RTP stream bitrate observed server-side by mediasoup, kbps',
      ['roomId', 'peerId', 'direction', 'kind'],
    ),
    rtt: createGauge(
      registry,
      'dvconf_rtc_rtt_ms',
      'RTP stream round-trip time observed server-side by mediasoup (undefined on most consumer/producer stats -- only set when present)',
      ['roomId', 'peerId', 'direction', 'kind'],
    ),
  };
}

/**
 * direction: 'down' = relay->peer (Consumer), 'up' = peer->relay (Producer).
 * kind: 'audio' | 'video' -- a peer has ONE Consumer/Producer per media kind
 * sharing the same (roomId, peerId, direction) triple, so `kind` MUST be part
 * of the gauge's label set. It previously wasn't: audio and video samples for
 * the same peer/direction landed on the exact same labelset and each `.set()`
 * silently clobbered the other (last-polled-in-the-loop wins), making the
 * old dvconf_rtc_* numbers neither a true per-kind reading nor a real
 * average of both -- just whichever kind's getStats() happened to resolve
 * last that tick.
 */
export function recordRtcQuality(
  roomId: string,
  peerId: string,
  direction: RtcDirection,
  kind: RtcMediaKind,
  sample: RtcQualitySample,
): void {
  if (!state) return;
  const labels = { roomId, peerId, direction, kind };
  if (sample.jitterMs !== undefined) state.jitter.set(labels, sample.jitterMs);
  if (sample.packetLossRatio !== undefined) state.packetLoss.set(labels, sample.packetLossRatio);
  if (sample.bitrateKbps !== undefined) state.bitrate.set(labels, sample.bitrateKbps);
  if (sample.rttMs !== undefined) state.rtt.set(labels, sample.rttMs);
}
