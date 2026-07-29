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

export interface RtcQualitySample {
  jitterMs?: number;
  packetLossRatio?: number;
  bitrateKbps?: number;
  rttMs?: number;
}

interface State {
  jitter: Gauge<'roomId' | 'peerId' | 'direction'>;
  packetLoss: Gauge<'roomId' | 'peerId' | 'direction'>;
  bitrate: Gauge<'roomId' | 'peerId' | 'direction'>;
  rtt: Gauge<'roomId' | 'peerId' | 'direction'>;
}

let state: State | null = null;

/** Wire the `dvconf_rtc_*` gauges -- call once at relay startup. */
export function registerRtcQualityMetrics(registry: Registry): void {
  state = {
    jitter: createGauge(
      registry,
      'dvconf_rtc_jitter_ms',
      'RTP jitter observed server-side by mediasoup, converted from RTP timestamp units via the stream codec clockRate',
      ['roomId', 'peerId', 'direction'],
    ),
    packetLoss: createGauge(
      registry,
      'dvconf_rtc_packet_loss_ratio',
      'RTP fractionLost observed server-side by mediasoup (0..1)',
      ['roomId', 'peerId', 'direction'],
    ),
    bitrate: createGauge(
      registry,
      'dvconf_rtc_bitrate_kbps',
      'RTP stream bitrate observed server-side by mediasoup, kbps',
      ['roomId', 'peerId', 'direction'],
    ),
    rtt: createGauge(
      registry,
      'dvconf_rtc_rtt_ms',
      'RTP stream round-trip time observed server-side by mediasoup (undefined on most consumer/producer stats -- only set when present)',
      ['roomId', 'peerId', 'direction'],
    ),
  };
}

/** direction: 'down' = relay->peer (Consumer), 'up' = peer->relay (Producer). */
export function recordRtcQuality(
  roomId: string,
  peerId: string,
  direction: RtcDirection,
  sample: RtcQualitySample,
): void {
  if (!state) return;
  const labels = { roomId, peerId, direction };
  if (sample.jitterMs !== undefined) state.jitter.set(labels, sample.jitterMs);
  if (sample.packetLossRatio !== undefined) state.packetLoss.set(labels, sample.packetLossRatio);
  if (sample.bitrateKbps !== undefined) state.bitrate.set(labels, sample.bitrateKbps);
  if (sample.rttMs !== undefined) state.rtt.set(labels, sample.rttMs);
}
