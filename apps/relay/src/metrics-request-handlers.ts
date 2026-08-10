/**
 * HTTP metrics server for relay daemon — request handlers.
 *
 * Pure extraction from metrics-server.ts: the POST body-ingestion handlers,
 * the Prometheus gauge refresh, and the /metrics/summary builder. Each
 * function takes an explicit deps object (previously closed over
 * startMetricsServer's local scope) so it's independently testable and
 * metrics-server.ts stays a thin route dispatcher.
 */

import type { IncomingMessage } from 'node:http';
import type { Gauge, Counter } from 'prom-client';
import type { Logger } from '@dvconf/shared';
import type { types as msTypes } from 'mediasoup';
import type { MetricsTracker } from './metrics.js';
import type { PeerStatsWindow, PeerQualitySample } from './stats-window.js';
import {
  readCappedJsonBody,
  parseStatsReportBody,
  parseLogsReportBody,
  parseRelayDownHintBody,
  LOGS_REPORT_MAX_BODY_BYTES,
  STATS_REPORT_MIN_INTERVAL_MS,
  LOGS_REPORT_MIN_INTERVAL_MS,
  RELAY_DOWN_HINT_TTL_MS,
  RELAY_DOWN_HINT_MIN_INTERVAL_MS,
} from './metrics-body-validators.js';
import { PEER_QUALITY_METRIC_INFO, type GetRoomFn, type PeerQualityGauges } from './metrics-server-types.js';
import type { RelayGauges } from './metrics-prom-gauges.js';

/** True iff roomId has a hint recorded within the last RELAY_DOWN_HINT_TTL_MS. */
export function hasFreshRelayDownHint(
  relayDownHints: Map<string, { reportedAtMs: number }>,
  roomId: string,
  now: number,
): boolean {
  const hint = relayDownHints.get(roomId);
  return hint !== undefined && now - hint.reportedAtMs < RELAY_DOWN_HINT_TTL_MS;
}

type HandlerResult = { status: number; body?: unknown };

// ── POST /stats/report ────────────────────────────────────────────────────

export interface StatsReportDeps {
  getRoom?: GetRoomFn;
  lastReportAt: Map<string, number>;
  statsWindow: PeerStatsWindow;
  metrics: MetricsTracker;
}

export async function handleStatsReport(
  req: IncomingMessage,
  reqLog: Logger,
  deps: StatsReportDeps,
): Promise<HandlerResult> {
  const { getRoom, lastReportAt, statsWindow, metrics } = deps;
  const read = await readCappedJsonBody(req);
  if (!read.ok) {
    return { status: read.status, body: { error: read.status === 413 ? 'payload_too_large' : 'bad_request' } };
  }
  const parsed = parseStatsReportBody(read.body);
  if (!parsed) {
    return { status: 400, body: { error: 'invalid_body' } };
  }
  const { roomId, peerId, sample, aggregates } = parsed;

  const room = getRoom?.(roomId);
  if (!room) {
    reqLog.warn({ roomId, peerId }, 'stats/report: unknown room (404)');
    return { status: 404, body: { error: 'room_not_found' } };
  }
  if (!room.peers.has(peerId)) {
    reqLog.warn({ roomId, peerId }, 'stats/report: peer not admitted (403)');
    return { status: 403, body: { error: 'peer_not_admitted' } };
  }

  const now = Date.now();
  const last = lastReportAt.get(peerId);
  if (last !== undefined && now - last < STATS_REPORT_MIN_INTERVAL_MS) {
    // Rate-limited: silently no-op (not the caller's fault, don't error).
    return { status: 204 };
  }
  lastReportAt.set(peerId, now);

  statsWindow.push(roomId, peerId, sample, now, aggregates);
  metrics.updateQuality(roomId, peerId, sample.packetLoss, sample.jitterMs, {
    latencyMs: sample.latencyMs,
    bitrateUpKbps: sample.bitrateUpKbps,
    bitrateDownKbps: sample.bitrateDownKbps,
    resolutionWidth: sample.resolutionWidth,
    resolutionHeight: sample.resolutionHeight,
    framerate: sample.framerate,
    packetReorderingRate: sample.packetReorderingRate,
    encodeLatencyMs: sample.encodeLatencyMs,
    decodeLatencyMs: sample.decodeLatencyMs,
    freezeCount: sample.freezeCount,
    pauseCount: sample.pauseCount,
    connectionSetupMs: sample.connectionSetupMs,
    iceSuccess: sample.iceSuccess,
    reconnectMs: sample.reconnectMs,
    avSyncDriftMs: sample.avSyncDriftMs,
  });

  return { status: 204 };
}

// ── POST /logs/report ─────────────────────────────────────────────────────

export interface LogsReportDeps {
  getRoom?: GetRoomFn;
  lastLogsReportAt: Map<string, number>;
}

export async function handleLogsReport(
  req: IncomingMessage,
  reqLog: Logger,
  deps: LogsReportDeps,
): Promise<HandlerResult> {
  const { getRoom, lastLogsReportAt } = deps;
  const read = await readCappedJsonBody(req, LOGS_REPORT_MAX_BODY_BYTES);
  if (!read.ok) {
    return { status: read.status, body: { error: read.status === 413 ? 'payload_too_large' : 'bad_request' } };
  }
  const parsed = parseLogsReportBody(read.body);
  if (!parsed) {
    return { status: 400, body: { error: 'invalid_body' } };
  }
  const { roomId, peerId, entries } = parsed;

  const room = getRoom?.(roomId);
  if (!room) {
    reqLog.warn({ roomId, peerId }, 'logs/report: unknown room (404)');
    return { status: 404, body: { error: 'room_not_found' } };
  }
  if (!room.peers.has(peerId)) {
    reqLog.warn({ roomId, peerId }, 'logs/report: peer not admitted (403)');
    return { status: 403, body: { error: 'peer_not_admitted' } };
  }

  const now = Date.now();
  const last = lastLogsReportAt.get(peerId);
  if (last !== undefined && now - last < LOGS_REPORT_MIN_INTERVAL_MS) {
    // Rate-limited: silently no-op (not the caller's fault, don't error).
    return { status: 204 };
  }
  lastLogsReportAt.set(peerId, now);

  // The entire shipping mechanism: one structured JSON line per entry on
  // this process's own stdout, already tailed to Loki by Docker's `loki`
  // logging driver — no separate transport/secret needed.
  for (const entry of entries) {
    console.log(JSON.stringify({ source: 'frontend', roomId, peerId, ...entry }));
  }

  return { status: 204 };
}

// ── POST /relay-down-hint ─────────────────────────────────────────────────

export interface RelayDownHintDeps {
  getRoom?: GetRoomFn;
  lastRelayDownHintAt: Map<string, number>;
  relayDownHints: Map<string, { reportedAtMs: number }>;
  relayDownHintTotalCounter: Counter<string>;
  relayDownHintLastAtGauge: Gauge<string>;
}

export async function handleRelayDownHint(
  req: IncomingMessage,
  reqLog: Logger,
  deps: RelayDownHintDeps,
): Promise<HandlerResult> {
  const { getRoom, lastRelayDownHintAt, relayDownHints, relayDownHintTotalCounter, relayDownHintLastAtGauge } = deps;
  const read = await readCappedJsonBody(req);
  if (!read.ok) {
    return { status: read.status, body: { error: read.status === 413 ? 'payload_too_large' : 'bad_request' } };
  }
  const parsed = parseRelayDownHintBody(read.body);
  if (!parsed) {
    return { status: 400, body: { error: 'invalid_body' } };
  }
  const { roomId, peerId } = parsed;

  const room = getRoom?.(roomId);
  if (!room) {
    reqLog.warn({ roomId, peerId }, 'relay-down-hint: unknown room (404)');
    return { status: 404, body: { error: 'room_not_found' } };
  }
  if (!room.peers.has(peerId)) {
    reqLog.warn({ roomId, peerId }, 'relay-down-hint: peer not admitted (403)');
    return { status: 403, body: { error: 'peer_not_admitted' } };
  }

  const now = Date.now();
  const last = lastRelayDownHintAt.get(peerId);
  if (last !== undefined && now - last < RELAY_DOWN_HINT_MIN_INTERVAL_MS) {
    // Rate-limited: silently no-op (not the caller's fault, don't error).
    return { status: 204 };
  }
  lastRelayDownHintAt.set(peerId, now);

  relayDownHints.set(roomId, { reportedAtMs: now });
  relayDownHintTotalCounter.inc();
  relayDownHintLastAtGauge.set(now / 1000);
  reqLog.warn({ roomId, peerId }, 'relay-down-hint: client reported its primary relay down');
  return { status: 204 };
}

// ── Prometheus gauge refresh (GET /metrics/prom) ──────────────────────────

export interface RefreshPromGaugesDeps {
  metrics: MetricsTracker;
  getWorkerDiedCount?: () => number;
  getWorkers?: () => msTypes.Worker[];
  logger: Logger;
  gauges: RelayGauges;
  peerGauges: PeerQualityGauges;
  peerAggregateGauges: Record<'avg' | 'min' | 'max', PeerQualityGauges>;
  statsWindow: PeerStatsWindow;
  getRoomParticipantCounts?: () => Array<{ roomId: string; count: number }>;
  relayDownHints: Map<string, { reportedAtMs: number }>;
}

export async function refreshPromGauges(deps: RefreshPromGaugesDeps): Promise<void> {
  const {
    metrics,
    getWorkerDiedCount,
    getWorkers,
    logger,
    gauges,
    peerGauges,
    peerAggregateGauges,
    statsWindow,
    getRoomParticipantCounts,
    relayDownHints,
  } = deps;

  const globalMetrics = metrics.getGlobalMetrics();
  gauges.activeSessionsGauge.set(globalMetrics.activeSessions);
  gauges.roomCountGauge.set(globalMetrics.roomCount);
  gauges.bytesForwardedGauge.set(Number(globalMetrics.totalBytesForwarded));
  gauges.workerDiedGauge.set(getWorkerDiedCount?.() ?? 0);

  // Monitoring-redesign gap #5: per-worker CPU/RSS, best-effort -- a single
  // worker's getResourceUsage() rejecting (e.g. mid-close) must not drop
  // the whole scrape.
  gauges.workerRuUtimeGauge.reset();
  gauges.workerRuStimeGauge.reset();
  gauges.workerRuMaxrssGauge.reset();
  const workers = getWorkers?.() ?? [];
  await Promise.all(
    workers.map(async (worker, index) => {
      try {
        const ru = await worker.getResourceUsage();
        const label = { worker: String(worker.pid ?? index) };
        gauges.workerRuUtimeGauge.set(label, ru.ru_utime);
        gauges.workerRuStimeGauge.set(label, ru.ru_stime);
        gauges.workerRuMaxrssGauge.set(label, ru.ru_maxrss);
      } catch (err) {
        logger.warn({ err, workerPid: worker.pid }, 'getResourceUsage() failed for worker; skipping');
      }
    }),
  );

  for (const gauge of Object.values(peerGauges)) {
    gauge.reset();
  }
  for (const g of Object.values(peerAggregateGauges)) {
    for (const gauge of Object.values(g)) {
      gauge.reset();
    }
  }
  gauges.roomParticipantsGauge.reset();
  for (const { roomId, count } of getRoomParticipantCounts?.() ?? []) {
    gauges.roomParticipantsGauge.set({ roomId }, count);
  }
  gauges.relayDownHintGauge.reset();
  const gaugeNow = Date.now();
  for (const [roomId] of relayDownHints) {
    gauges.relayDownHintGauge.set({ roomId }, hasFreshRelayDownHint(relayDownHints, roomId, gaugeNow) ? 1 : 0);
  }
  for (const peerId of statsWindow.peerIds()) {
    const current = statsWindow.current(peerId);
    if (!current) continue;
    const labels = { roomId: current.roomId, peerId };
    peerGauges.latencyMs.set(labels, current.latencyMs);
    peerGauges.packetLoss.set(labels, current.packetLoss);
    peerGauges.jitterMs.set(labels, current.jitterMs);
    peerGauges.bitrateUpKbps.set(labels, current.bitrateUpKbps);
    peerGauges.bitrateDownKbps.set(labels, current.bitrateDownKbps);
    peerGauges.resolutionWidth.set(labels, current.resolutionWidth);
    peerGauges.resolutionHeight.set(labels, current.resolutionHeight);
    peerGauges.framerate.set(labels, current.framerate);
    peerGauges.packetReorderingRate.set(labels, current.packetReorderingRate);
    peerGauges.encodeLatencyMs.set(labels, current.encodeLatencyMs);
    peerGauges.decodeLatencyMs.set(labels, current.decodeLatencyMs);
    peerGauges.freezeCount.set(labels, current.freezeCount);
    peerGauges.pauseCount.set(labels, current.pauseCount);
    peerGauges.connectionSetupMs.set(labels, current.connectionSetupMs);
    peerGauges.iceSuccess.set(labels, current.iceSuccess ? 1 : 0);
    peerGauges.reconnectMs.set(labels, current.reconnectMs);
    peerGauges.avSyncDriftMs.set(labels, current.avSyncDriftMs);

    // Cumulative-since-join avg/min/max (RoomPage.tsx's aggregator) --
    // absent for peers that never sent an `aggregates` body (e.g. the bot).
    const aggregates = statsWindow.currentAggregates(peerId);
    if (aggregates) {
      for (const field of Object.keys(PEER_QUALITY_METRIC_INFO) as Array<keyof PeerQualitySample>) {
        const { avg, min, max } = aggregates[field];
        peerAggregateGauges.avg[field].set(labels, avg);
        peerAggregateGauges.min[field].set(labels, min);
        peerAggregateGauges.max[field].set(labels, max);
      }
    }
  }
}

// ── GET /metrics/summary ──────────────────────────────────────────────────

export interface BuildSummaryDeps {
  workerId: string;
  metrics: MetricsTracker;
  statsWindow: PeerStatsWindow;
  sampleCpuPercent: () => number;
}

export function buildSummary(deps: BuildSummaryDeps): {
  workerId: string;
  activeSessions: number;
  cpuPercent: number;
  memMB: number;
  peers: Array<{ peerId: string; roomId: string } & PeerQualitySample>;
} {
  const { workerId, metrics, statsWindow, sampleCpuPercent } = deps;
  const peers: Array<{ peerId: string; roomId: string } & PeerQualitySample> = [];
  for (const peerId of statsWindow.peerIds()) {
    const current = statsWindow.current(peerId);
    if (!current) continue;
    const { lastUpdatedAt: _lastUpdatedAt, ...sample } = current;
    peers.push({ peerId, ...sample });
  }
  return {
    workerId,
    activeSessions: metrics.getActiveSessionCount(),
    cpuPercent: sampleCpuPercent(),
    memMB: process.memoryUsage().rss / (1024 * 1024),
    peers,
  };
}
