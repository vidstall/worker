/**
 * HTTP metrics server for relay daemon — Prometheus gauge/counter builders.
 *
 * Pure extraction from metrics-server.ts: the per-peer-quality gauge sets and
 * the standalone relay-level gauges/counters, all built once per server
 * instance (NOT module singletons) so tests spinning up multiple servers
 * stay isolated.
 */

import { Gauge, Counter } from 'prom-client';
import type { Registry } from '@dvconf/shared';
import type { PeerQualitySample } from './stats-window.js';
import { PEER_QUALITY_METRIC_INFO, type PeerQualityGauges } from './metrics-server-types.js';

export function buildPeerQualityGauges(registry: Registry): PeerQualityGauges {
  const mk = (name: string, help: string): Gauge<'roomId' | 'peerId'> =>
    new Gauge({ name, help, labelNames: ['roomId', 'peerId'], registers: [registry] });
  const gauges = {} as PeerQualityGauges;
  for (const field of Object.keys(PEER_QUALITY_METRIC_INFO) as Array<keyof PeerQualitySample>) {
    const { name, help } = PEER_QUALITY_METRIC_INFO[field];
    gauges[field] = mk(name, help);
  }
  return gauges;
}

/**
 * Client-computed cumulative avg/min/max per field (RoomPage.tsx's
 * aggregator ref, since the peer joined the room) — one NEW, separately
 * named gauge per field per stat (e.g. `dvconf_relay_peer_latency_ms_avg`),
 * NOT a label variant of the existing current-value gauges above, so no
 * existing dashboard query needs to change.
 */
export function buildPeerQualityAggregateGauges(
  registry: Registry,
): Record<'avg' | 'min' | 'max', PeerQualityGauges> {
  const mk = (name: string, help: string): Gauge<'roomId' | 'peerId'> =>
    new Gauge({ name, help, labelNames: ['roomId', 'peerId'], registers: [registry] });
  const stats = ['avg', 'min', 'max'] as const;
  const result = {} as Record<'avg' | 'min' | 'max', PeerQualityGauges>;
  for (const stat of stats) {
    const gauges = {} as PeerQualityGauges;
    for (const field of Object.keys(PEER_QUALITY_METRIC_INFO) as Array<keyof PeerQualitySample>) {
      const { name, help } = PEER_QUALITY_METRIC_INFO[field];
      gauges[field] = mk(`${name}_${stat}`, `${help} (cumulative ${stat} since room join)`);
    }
    result[stat] = gauges;
  }
  return result;
}

/** The standalone (non-per-peer-quality) relay-level gauges + counters. */
export interface RelayGauges {
  workerDiedGauge: Gauge<string>;
  workerRuUtimeGauge: Gauge<'worker'>;
  workerRuStimeGauge: Gauge<'worker'>;
  workerRuMaxrssGauge: Gauge<'worker'>;
  activeSessionsGauge: Gauge<string>;
  roomCountGauge: Gauge<string>;
  bytesForwardedGauge: Gauge<string>;
  roomParticipantsGauge: Gauge<'roomId'>;
  relayDownHintGauge: Gauge<'roomId'>;
  relayDownHintTotalCounter: Counter<string>;
  relayDownHintLastAtGauge: Gauge<string>;
}

/**
 * Builds every standalone relay-level Prometheus series startMetricsServer
 * registers, once per server instance (mirrors buildPeerQualityGauges' own
 * per-instance-registry discipline).
 */
export function buildRelayGauges(registry: Registry): RelayGauges {
  const workerDiedGauge = new Gauge({
    name: 'dvconf_relay_worker_died_total',
    help: 'Cumulative count of mediasoup Worker died events (F61 health signal, DOH-014)',
    registers: [registry],
  });
  // Monitoring-redesign gap #5: mediasoup Worker resource usage was never
  // scraped (only the 'died' event count above). ru_utime/ru_stime are
  // already reported in ms by mediasoup's WorkerResourceUsage type (not raw
  // timeval structs); ru_maxrss is KB per the underlying getrusage(2) convention.
  const workerRuUtimeGauge = new Gauge({
    name: 'dvconf_relay_worker_ru_utime_ms',
    help: 'mediasoup Worker user CPU time, ms (getResourceUsage().ru_utime)',
    labelNames: ['worker'],
    registers: [registry],
  });
  const workerRuStimeGauge = new Gauge({
    name: 'dvconf_relay_worker_ru_stime_ms',
    help: 'mediasoup Worker system CPU time, ms (getResourceUsage().ru_stime)',
    labelNames: ['worker'],
    registers: [registry],
  });
  const workerRuMaxrssGauge = new Gauge({
    name: 'dvconf_relay_worker_ru_maxrss_kb',
    help: 'mediasoup Worker max resident set size, KB (getResourceUsage().ru_maxrss)',
    labelNames: ['worker'],
    registers: [registry],
  });
  const activeSessionsGauge = new Gauge({
    name: 'dvconf_relay_active_sessions',
    help: 'Active relay sessions (MetricsTracker)',
    registers: [registry],
  });
  const roomCountGauge = new Gauge({
    name: 'dvconf_relay_room_count',
    help: 'Active room count (MetricsTracker)',
    registers: [registry],
  });
  const bytesForwardedGauge = new Gauge({
    name: 'dvconf_relay_bytes_forwarded_total',
    help: 'Cumulative bytes forwarded across all sessions (MetricsTracker)',
    registers: [registry],
  });
  // Rooms-dashboard metrics migration (formerly owned by the now-deleted
  // `apps/signaling/src/rooms.ts`'s `registerRoomMetrics`) -- relay emits
  // participant count since it sees every join/leave directly on its own
  // WebSocket connections (best visibility of the 3 daemon types). Wire-
  // compatible name/labels with what Grafana's Rooms dashboard already
  // expects; only the emitting job (now relay's `xaisen` scrape job instead
  // of `xaisen-signaling`) changes.
  const roomParticipantsGauge = new Gauge({
    name: 'dvconf_room_participants',
    help: 'Current participant count for this room',
    labelNames: ['roomId'],
    registers: [registry],
  });
  const relayDownHintGauge = new Gauge({
    name: 'dvconf_relay_down_hint_active',
    help: 'Client-reported relay-down hint currently fresh for this room (1) or not (0)',
    labelNames: ['roomId'],
    registers: [registry],
  });
  // Vestigial: a bare (unlabeled) cumulative counter + last-seen gauge for
  // THIS relay instance's client-reported down-hints, without per-room
  // cardinality. The browser now pushes its relay-down-hint directly to
  // Pushgateway instead (see services/client/client/src/lib/relay-down-hint.ts),
  // so nothing currently calls `POST /relay-down-hint` -- left in place
  // rather than removed since it's a working, harmless endpoint.
  const relayDownHintTotalCounter = new Counter({
    name: 'dvconf_relay_down_hint_total',
    help: 'Cumulative client-reported relay-down hints received by this relay instance',
    registers: [registry],
  });
  const relayDownHintLastAtGauge = new Gauge({
    name: 'dvconf_relay_down_hint_last_at_seconds',
    help: 'Unix timestamp (seconds) of the most recent client-reported relay-down hint',
    registers: [registry],
  });

  return {
    workerDiedGauge,
    workerRuUtimeGauge,
    workerRuStimeGauge,
    workerRuMaxrssGauge,
    activeSessionsGauge,
    roomCountGauge,
    bytesForwardedGauge,
    roomParticipantsGauge,
    relayDownHintGauge,
    relayDownHintTotalCounter,
    relayDownHintLastAtGauge,
  };
}
