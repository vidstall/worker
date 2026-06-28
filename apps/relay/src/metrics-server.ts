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
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { type Logger, healthzBody, readTraceId, traceChild } from '@dvconf/shared';
import type { MetricsTracker } from './metrics.js';

/**
 * Shared response headers (P17 M2b-P7, DOH-029). `access-control-allow-origin: *`
 * lets the browser dashboard's `useDaemonHealthz` hook fetch the relay's /healthz
 * cross-origin (parallel to the shared healthz.ts edit). CORS ONLY — the relay's
 * /healthz stays always-2xx (F1 = Option A; its standby polls it via
 * relay-heartbeat.ts:82 2xx-range, so no isLive-503 is wired here).
 */
const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
} as const;

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
  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay pipe
   * TRANSPORT (bytesReceived + bytesSent). A DIRECT live measure that cross-relay
   * active-forward RTP crossed (>0 => bytes traversed the pipe), independent of
   * the paused keepalive consumer's rtcpAlive. Defaults to 0 (additive).
   */
  pipeBytesObserved?: number;
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
  /**
   * REQ-RMS-025 byte-proof — cumulative bytes on the standby's inter-relay pipe
   * transport (bytesReceived + bytesSent). >0 proves cross-relay active-forward
   * RTP actually crossed the pipe (DIRECT live measure). 0 for primary / unwired.
   */
  pipe_bytes_observed: number;
}

// ── /metrics Bearer-token auth (REQ-MCS-007) ─────────────────────────────
//
// Design: env-gated + OPEN-when-METRICS_AUTH_TOKEN-unset (backward-compat).
// When token is SET: require `Authorization: Bearer <token>` on /metrics and
// /metrics/:roomId. Constant-time comparison mirrors the G3.2b inter-relay
// auth pattern (timingSafeEqual, NOT ===) to avoid timing side-channels.
// /healthz and /api/probe are ALWAYS open (RO-020 invariant).
//
// wss/TLS termination is a Traefik deployment concern (DA-6) — not here.

/**
 * Validate the `Authorization: Bearer <token>` header against the configured
 * METRICS_AUTH_TOKEN. Returns true (open) when `expectedToken` is empty —
 * the gate is OPEN-when-unset for backward-compatibility (validator path
 * `fetchRelayMetrics` calls /metrics/:roomId without auth when no token
 * is configured; setting the token opts-in to enforcement).
 *
 * Mirrors `isValidInterRelayToken` from inter-relay.ts (G3.2b pattern):
 * constant-time on content via `timingSafeEqual`; length-mismatch short-
 * circuits before the call (timingSafeEqual throws on unequal-length buffers
 * and the token length is not secret).
 */
function isMetricsAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  // OPEN-when-unset: if no token configured, all callers are admitted.
  if (expectedToken === '') return true;
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length);
  if (presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
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
    pipe_bytes_observed: state?.pipeBytesObserved ?? 0,
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

  // REQ-MCS-007: Read once at startup so the gate is consistent for this
  // server lifetime. Empty string = token unset = OPEN (backward-compat).
  const metricsAuthToken = process.env['METRICS_AUTH_TOKEN'] ?? '';

  const server = createServer((req, res) => {
    // Capture request-arrival time for the /api/probe server-handling RTT.
    const startedAt = performance.now();

    // Only allow GET requests
    if (req.method !== 'GET') {
      res.writeHead(405, JSON_HEADERS);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const url = req.url ?? '/';

    // F63 (DOH-003): honor the inbound x-trace-id (the validator's measurement-cycle
    // id on the /metrics + /api/probe legs) so the relay's request logs correlate to
    // the validator cycle and the on-chain proof — this is the demo-path continuity.
    const reqLog = traceChild(logger, readTraceId(req.headers));

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
        res.end(JSON.stringify(roomMetrics));
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
