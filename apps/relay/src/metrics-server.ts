/**
 * HTTP metrics server for relay daemon.
 *
 * Exposes per-room metrics for validator probing and a global health endpoint.
 * Uses Node.js built-in http module (no Express).
 *
 * Endpoints:
 *   GET  /metrics/:roomId  — per-room metrics (IC-5)
 *   GET  /metrics          — global health summary
 *   GET  /metrics/prom     — Prometheus text-format scrape (call-quality feature)
 *   GET  /metrics/summary  — JSON aggregation over live peer quality samples
 *   POST /stats/report     — client-reported per-peer quality sample ingestion
 *   POST /logs/report      — client-reported frontend log batch ingestion
 *   POST /relay-down-hint  — client-reported "my primary relay just died" hint
 *   GET  /api/probe        — standby-liveness channel (RO-020)
 *   GET  /healthz          — heartbeat channel (RO-020 / NG-8)
 *
 * Default port: 4001 (configurable via METRICS_PORT env var).
 *
 * Requirements: Phase 14 IC-5, RO-020
 *
 * Body types + POST validators live in metrics-server-types.ts /
 * metrics-body-validators.ts; the Prometheus gauge builders live in
 * metrics-prom-gauges.ts; the request handlers (stats/logs/relay-down-hint
 * ingestion, gauge refresh, summary) live in metrics-request-handlers.ts.
 * This file wires them together and owns the HTTP route dispatch.
 */

import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import type { types as msTypes } from 'mediasoup';
import {
  type Logger,
  healthzBody,
  readTraceId,
  traceChild,
  createMetricsRegistry,
  createRegistrationGauge,
  registerTxMetrics,
  registerEventPollerMetrics,
  registerRoleAssignmentMetrics,
} from '@dvconf/shared';
import { registerFailoverMetrics } from './failover-metrics.js';
import { registerRtcQualityMetrics } from './rtc-quality-metrics.js';
import type { MetricsTracker } from './metrics.js';
import { PeerStatsWindow } from './stats-window.js';
import {
  JSON_HEADERS,
  type ProbeStateProvider,
  type GetRoomFn,
} from './metrics-server-types.js';
import { isMetricsAuthorized, buildProbeResponse } from './metrics-body-validators.js';
import { buildPeerQualityGauges, buildPeerQualityAggregateGauges, buildRelayGauges } from './metrics-prom-gauges.js';
import {
  handleStatsReport,
  handleLogsReport,
  handleRelayDownHint,
  refreshPromGauges,
  buildSummary,
  hasFreshRelayDownHint,
} from './metrics-request-handlers.js';

export type { ProbeState, ProbeStateProvider, ProbeResponse, GetRoomFn } from './metrics-server-types.js';

/**
 * Start the metrics HTTP server.
 *
 * @param metrics        - Per-room/global metrics tracker (IC-5).
 * @param logger         - Structured logger.
 * @param probeState     - Optional resolver for RO-020 standby-liveness state.
 *                         When omitted, /api/probe answers ok:false (unknown).
 * @param getRoom        - Optional resolver for live room state (call-quality
 *                         feature's `/stats/report` admission check). Omitted
 *                         ⇒ `/stats/report` rejects every report (403).
 * @param getWorkerDiedCount - Optional resolver for the cumulative mediasoup
 *                         Worker 'died' count (F61/DOH-014), exposed as
 *                         `dvconf_relay_worker_died_total` for the academic-eval
 *                         "Fault Tolerance" dashboard row. Omitted ⇒ gauge stays 0.
 * @param getWorkers     - Optional resolver for the live mediasoup Worker list
 *                         (monitoring-redesign gap #5), backing per-worker
 *                         `dvconf_relay_worker_ru_{utime,stime}_ms` /
 *                         `_ru_maxrss_kb` gauges via `Worker.getResourceUsage()`.
 *                         Omitted ⇒ those gauges are simply absent (no worker rows).
 * @param statsWindow    - Optional shared `PeerStatsWindow` -- pass the SAME
 *                         instance given to `createSignalingServer` so a peer's
 *                         cached stats get cleared via `statsWindow.clear(peerId)`
 *                         on disconnect (see lifecycle-handler.ts), instead of
 *                         lingering in Prometheus forever. Omitted ⇒ a fresh,
 *                         private instance (today's behavior) -- keeps existing
 *                         tests that spin up multiple isolated servers unaffected.
 * @param getRoomParticipantCounts - Optional resolver for live per-room
 *                         participant counts (Rooms-dashboard metrics migration,
 *                         formerly `apps/signaling/src/rooms.ts`'s
 *                         `registerRoomMetrics`). Backs `dvconf_room_participants
 *                         {roomId}`. Omitted ⇒ the gauge stays empty (no rows).
 * @returns The HTTP server instance (for graceful shutdown).
 */
export function startMetricsServer(
  metrics: MetricsTracker,
  logger: Logger,
  probeState?: ProbeStateProvider,
  getRoom?: GetRoomFn,
  getWorkerDiedCount?: () => number,
  getWorkers?: () => msTypes.Worker[],
  statsWindow: PeerStatsWindow = new PeerStatsWindow(),
  getRoomParticipantCounts?: () => Array<{ roomId: string; count: number }>,
): Server {
  const port = parseInt(process.env['METRICS_PORT'] ?? '4001', 10);

  // REQ-MCS-007: Read once at startup so the gate is consistent for this
  // server lifetime. Empty string = token unset = OPEN (backward-compat).
  const metricsAuthToken = process.env['METRICS_AUTH_TOKEN'] ?? '';

  // Call-quality feature: one prom registry per server instance (NOT a module
  // singleton) so tests that spin up multiple servers stay isolated.
  const promRegistry = createMetricsRegistry('relay');
  // startMetricsServer() is only ever reached after index.ts's earlier
  // ensureRegistered() call resolves (it throws/exits the process on
  // failure -- see auto-register.ts), so registered=true unconditionally
  // here. Replaces the old SSH-grepped `docker logs | grep 'operator
  // address|node_id=|bootstrap failed'` status check
  // (cli/infra/inventory.py's registry_status()) with a real Prometheus
  // series -- see packages/shared/src/metrics-prom.ts's
  // createRegistrationGauge doc.
  createRegistrationGauge(promRegistry).setRegistered(true);
  // Academic-eval blockchain-overhead metrics -- see cp-daemon/src/index.ts's
  // identical call for why this is enough to instrument every
  // executeWithRetry() in this process (auto-register, heartbeat, ...).
  registerTxMetrics(promRegistry, 'relay');
  registerEventPollerMetrics(promRegistry, 'relay');
  registerRoleAssignmentMetrics(promRegistry, 'relay');
  registerFailoverMetrics(promRegistry);
  registerRtcQualityMetrics(promRegistry);
  const peerGauges = buildPeerQualityGauges(promRegistry);
  const peerAggregateGauges = buildPeerQualityAggregateGauges(promRegistry);
  const gauges = buildRelayGauges(promRegistry);

  // `/stats/report` rate limit: last-accepted-report wall-clock ts per peerId.
  const lastReportAt = new Map<string, number>();

  // `/logs/report` rate limit: separate map, same pattern as `/stats/report`.
  const lastLogsReportAt = new Map<string, number>();

  // `/relay-down-hint` state: fresh-hint-per-room store + its own (separate)
  // per-peerId rate limit map.
  const relayDownHints = new Map<string, { reportedAtMs: number }>();
  const lastRelayDownHintAt = new Map<string, number>();

  const workerId =
    process.env['RELAY_INSTANCE'] ?? process.env['WORKER_ID'] ?? hostname();

  let lastCpuUsage = process.cpuUsage();
  let lastCpuSampleAt = process.hrtime.bigint();
  /** Cheap CPU% sample: user+system delta / wall-clock delta since the last call. */
  function sampleCpuPercent(): number {
    const usage = process.cpuUsage();
    const now = process.hrtime.bigint();
    const userDiff = usage.user - lastCpuUsage.user;
    const sysDiff = usage.system - lastCpuUsage.system;
    const elapsedMicros = Number(now - lastCpuSampleAt) / 1000;
    lastCpuUsage = usage;
    lastCpuSampleAt = now;
    if (elapsedMicros <= 0) return 0;
    return Math.max(0, ((userDiff + sysDiff) / elapsedMicros) * 100);
  }

  const server = createServer((req, res) => {
    // Capture request-arrival time for the /api/probe server-handling RTT.
    const startedAt = performance.now();

    const url = req.url ?? '/';

    // F63 (DOH-003): honor the inbound x-trace-id (the validator's measurement-cycle
    // id on the /metrics + /api/probe legs) so the relay's request logs correlate to
    // the validator cycle and the on-chain proof — this is the demo-path continuity.
    const reqLog = traceChild(logger, readTraceId(req.headers));

    // CORS preflight: browsers issue an OPTIONS request before any cross-origin
    // POST with Content-Type: application/json (all three client-facing routes
    // below) and refuse to send the real request unless this responds with
    // Access-Control-Allow-Methods/Headers. A Node-side caller (e.g. the bot's
    // stats-reporter.ts) is never subject to this, which is why server-side
    // reporting always worked while a real browser's never got past preflight.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    // Route: POST /stats/report — client-reported per-peer quality sample.
    if (req.method === 'POST' && url === '/stats/report') {
      handleStatsReport(req, reqLog, { getRoom, lastReportAt, statsWindow, metrics })
        .then(({ status, body }) => {
          res.writeHead(status, JSON_HEADERS);
          res.end(body === undefined ? undefined : JSON.stringify(body));
        })
        .catch((err: unknown) => {
          reqLog.error({ err, url }, 'stats/report: handler error');
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      return;
    }

    // Route: POST /logs/report — client-reported frontend log batch ingestion.
    if (req.method === 'POST' && url === '/logs/report') {
      handleLogsReport(req, reqLog, { getRoom, lastLogsReportAt })
        .then(({ status, body }) => {
          res.writeHead(status, JSON_HEADERS);
          res.end(body === undefined ? undefined : JSON.stringify(body));
        })
        .catch((err: unknown) => {
          reqLog.error({ err, url }, 'logs/report: handler error');
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      return;
    }

    // Route: POST /relay-down-hint — client-reported "primary relay down" hint.
    if (req.method === 'POST' && url === '/relay-down-hint') {
      handleRelayDownHint(req, reqLog, {
        getRoom,
        lastRelayDownHintAt,
        relayDownHints,
        relayDownHintTotalCounter: gauges.relayDownHintTotalCounter,
        relayDownHintLastAtGauge: gauges.relayDownHintLastAtGauge,
      })
        .then(({ status, body }) => {
          res.writeHead(status, JSON_HEADERS);
          res.end(body === undefined ? undefined : JSON.stringify(body));
        })
        .catch((err: unknown) => {
          reqLog.error({ err, url }, 'relay-down-hint: handler error');
          res.writeHead(500, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        });
      return;
    }

    // Only allow GET for every other route.
    if (req.method !== 'GET') {
      res.writeHead(405, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    try {
      // Route: GET /healthz — heartbeat channel (RO-020 / NG-8).
      // relay-heartbeat.ts (M1) already pings this; the relay never served it.
      if (url === '/healthz') {
        // ok:true retained for RO-020 backward-compat (relay-heartbeat checks the
        // status code, not the body); standard liveness fields added (DOH-009).
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, ...healthzBody('relay') }));
        return;
      }

      // Route: GET /api/probe — standby-liveness channel (RO-020).
      // The validator calls this BEFORE building the standby SessionProof; a
      // SUCCESSFUL probe (ok:true) lets the standby proof carry
      // duration_seconds > 0, an ok:false (or unanswered) probe => duration = 0.
      if (url === '/api/probe') {
        const body = buildProbeResponse(probeState?.(), startedAt);
        reqLog.info({ url, role: body.role }, 'RO-020 probe served');
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(body));
        return;
      }

      // Route: GET /metrics/prom — Prometheus text-format scrape (call-quality
      // feature). Same bearer gate as /metrics + /metrics/:roomId.
      if (url === '/metrics/prom') {
        if (!isMetricsAuthorized(req, metricsAuthToken)) {
          reqLog.warn({ url }, 'relay metrics: unauthorized (401)');
          res.writeHead(401, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        refreshPromGauges({
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
        })
          .then(() => promRegistry.metrics())
          .then((text) => {
            res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
            res.end(text);
          })
          .catch((err: unknown) => {
            reqLog.error({ err, url }, 'Metrics server error');
            res.writeHead(500, JSON_HEADERS);
            res.end(JSON.stringify({ error: 'Internal server error' }));
          });
        return;
      }

      // Route: GET /metrics/summary — JSON aggregation over live peer samples.
      // Same bearer gate as /metrics + /metrics/:roomId.
      if (url === '/metrics/summary') {
        if (!isMetricsAuthorized(req, metricsAuthToken)) {
          reqLog.warn({ url }, 'relay metrics: unauthorized (401)');
          res.writeHead(401, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(buildSummary({ workerId, metrics, statsWindow, sampleCpuPercent })));
        return;
      }

      // Route: GET /metrics/:roomId
      const roomMatch = url.match(/^\/metrics\/([a-fA-F0-9x]+)$/);
      if (roomMatch) {
        // REQ-MCS-007: Bearer auth gate (OPEN when METRICS_AUTH_TOKEN unset).
        if (!isMetricsAuthorized(req, metricsAuthToken)) {
          reqLog.warn({ url }, 'relay metrics: unauthorized (401)');
          res.writeHead(401, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const roomId = roomMatch[1]!;
        const roomMetrics = metrics.getRoomMetrics(roomId);

        if (!roomMetrics) {
          res.writeHead(404, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Room not found' }));
          return;
        }

        reqLog.debug({ url, roomId }, 'relay metrics served');
        res.writeHead(200, JSON_HEADERS);
        res.end(
          JSON.stringify(
            hasFreshRelayDownHint(relayDownHints, roomId, Date.now())
              ? { ...roomMetrics, clientReportedDeadRelayHint: true }
              : roomMetrics,
          ),
        );
        return;
      }

      // Route: GET /metrics
      if (url === '/metrics') {
        // REQ-MCS-007: Bearer auth gate (OPEN when METRICS_AUTH_TOKEN unset).
        if (!isMetricsAuthorized(req, metricsAuthToken)) {
          reqLog.warn({ url }, 'relay metrics: unauthorized (401)');
          res.writeHead(401, JSON_HEADERS);
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const globalMetrics = metrics.getGlobalMetrics();
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify(globalMetrics));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      reqLog.error({ err, url }, 'Metrics server error');
      res.writeHead(500, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Metrics HTTP server listening');
  });

  return server;
}
