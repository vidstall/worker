/**
 * HTTP metrics server for relay daemon.
 *
 * Exposes per-room metrics for validator probing and a global health endpoint.
 * Uses Node.js built-in http module (no Express).
 *
 * Endpoints:
 *   GET /metrics/:roomId  — per-room metrics (IC-5)
 *   GET /metrics          — global health summary
 *   GET /api/probe        — standby-liveness channel (RO-020)
 *   GET /healthz          — heartbeat channel (RO-020 / NG-8)
 *
 * Default port: 4001 (configurable via METRICS_PORT env var).
 *
 * Requirements: Phase 14 IC-5, RO-020
 */

import { createServer, type Server } from 'node:http';
import type { Logger } from '@dvconf/shared';
import type { MetricsTracker } from './metrics.js';

/**
 * Snapshot of this relay's standby-liveness state for a /api/probe response.
 *
 * Resolved lazily on each probe so it always reflects current topology (the
 * RoomAssigned poller flips `role`; the warm-pipe coordinator sets the pipe
 * consumer). All fields are plain booleans/strings — no mediasoup types leak
 * across the HTTP boundary.
 */
export interface ProbeState {
  /** 'primary' (relay_ids[0]) or 'standby' (relay_ids[1..]) for this relay. */
  role: 'primary' | 'standby' | 'unknown';
  /**
   * The standby's pipe consumer is open (warm pipe established). A dead/absent
   * pipe consumer => the standby cannot resume media => not live.
   */
  pipeConsumerAlive: boolean;
  /** RTCP keepalive is flowing on the warm pipe (REQ-RO-005). */
  rtcpAlive: boolean;
}

/**
 * Resolves the current {@link ProbeState}. Injected by the daemon wiring
 * (index.ts) so the metrics server stays decoupled from topology state.
 * Returns `undefined` when probe state is not available (no provider wired).
 */
export type ProbeStateProvider = () => ProbeState | undefined;

/** Liveness JSON returned by GET /api/probe (RO-020 standby contract). */
export interface ProbeResponse {
  /**
   * Standby liveness verdict. true ONLY when role==='standby' AND the pipe
   * consumer is alive AND RTCP keepalive is flowing. The validator gates the
   * standby SessionProof's duration_seconds on this: ok:true => duration > 0;
   * ok:false (or an unanswered probe) => duration_seconds = 0.
   * A primary always answers ok:true (it is the live media path).
   */
  ok: boolean;
  /** This relay's role for the room ('primary' | 'standby' | 'unknown'). */
  role: 'primary' | 'standby' | 'unknown';
  /** Wall-clock timestamp (ms epoch) the probe was answered. */
  ts: number;
  /**
   * SERVER-HANDLING round-trip in ms (time spent building this response) — NOT
   * the media-plane RTP RTT. Lets the validator record handling latency without
   * mistaking it for a media measurement.
   */
  latency_ms: number;
  /** Whether the standby's warm-pipe consumer is open. */
  pipe_consumer_alive: boolean;
  /** Whether RTCP keepalive is flowing on the warm pipe. */
  rtcp_alive: boolean;
}

/**
 * Compute the {@link ProbeResponse} from the resolved probe state.
 *
 * Liveness rule (RO-020 / RO-016 standby-liveness gate):
 *   - primary  => ok:true (it IS the live media path).
 *   - standby  => ok:true IFF pipeConsumerAlive AND rtcpAlive.
 *   - unknown / no provider => ok:false (validator gates duration=0; honest).
 */
function buildProbeResponse(state: ProbeState | undefined, startedAt: number): ProbeResponse {
  const role = state?.role ?? 'unknown';
  const pipeConsumerAlive = state?.pipeConsumerAlive ?? false;
  const rtcpAlive = state?.rtcpAlive ?? false;
  const ok =
    role === 'primary' || (role === 'standby' && pipeConsumerAlive && rtcpAlive);
  return {
    ok,
    role,
    ts: Date.now(),
    // Server-handling RTT: monotonic elapsed since the request landed.
    latency_ms: Math.max(0, performance.now() - startedAt),
    pipe_consumer_alive: pipeConsumerAlive,
    rtcp_alive: rtcpAlive,
  };
}

/**
 * Start the metrics HTTP server.
 *
 * @param metrics        - Per-room/global metrics tracker (IC-5).
 * @param logger         - Structured logger.
 * @param probeState     - Optional resolver for RO-020 standby-liveness state.
 *                         When omitted, /api/probe answers ok:false (unknown).
 * @returns The HTTP server instance (for graceful shutdown).
 */
export function startMetricsServer(
  metrics: MetricsTracker,
  logger: Logger,
  probeState?: ProbeStateProvider,
): Server {
  const port = parseInt(process.env['METRICS_PORT'] ?? '4001', 10);

  const server = createServer((req, res) => {
    // Capture request-arrival time for the /api/probe server-handling RTT.
    const startedAt = performance.now();

    // Only allow GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const url = req.url ?? '/';

    try {
      // Route: GET /healthz — heartbeat channel (RO-020 / NG-8).
      // relay-heartbeat.ts (M1) already pings this; the relay never served it.
      if (url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Route: GET /api/probe — standby-liveness channel (RO-020).
      // The validator calls this BEFORE building the standby SessionProof; a
      // SUCCESSFUL probe (ok:true) lets the standby proof carry
      // duration_seconds > 0, an ok:false (or unanswered) probe => duration = 0.
      if (url === '/api/probe') {
        const body = buildProbeResponse(probeState?.(), startedAt);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
        return;
      }

      // Route: GET /metrics/:roomId
      const roomMatch = url.match(/^\/metrics\/([a-fA-F0-9x]+)$/);
      if (roomMatch) {
        const roomId = roomMatch[1]!;
        const roomMetrics = metrics.getRoomMetrics(roomId);

        if (!roomMetrics) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Room not found' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(roomMetrics));
        return;
      }

      // Route: GET /metrics
      if (url === '/metrics') {
        const globalMetrics = metrics.getGlobalMetrics();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(globalMetrics));
        return;
      }

      // 404 for unknown routes
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    } catch (err) {
      logger.error({ err, url }, 'Metrics server error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  server.listen(port, () => {
    logger.info({ port }, 'Metrics HTTP server listening');
  });

  return server;
}
