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
 *   GET  /api/probe        — standby-liveness channel (RO-020)
 *   GET  /healthz          — heartbeat channel (RO-020 / NG-8)
 *
 * Default port: 4001 (configurable via METRICS_PORT env var).
 *
 * Requirements: Phase 14 IC-5, RO-020
 */

import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { Gauge } from 'prom-client';
import {
  type Logger,
  healthzBody,
  readTraceId,
  traceChild,
  createMetricsRegistry,
  type Registry,
} from '@dvconf/shared';
import type { MetricsTracker } from './metrics.js';
import { PeerStatsWindow, type PeerQualitySample } from './stats-window.js';
import type { RoomState } from './room-handler.js';

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

// ── POST /stats/report — client-reported per-peer call-quality ingestion ──
//
// Auth is NOT the METRICS_AUTH_TOKEN bearer — it is admission-membership: the
// reporting peerId must be a peer CURRENTLY admitted into roomId (live
// room-handler.ts state, injected via `getRoom`). Body capped ~2KB (413 over);
// rate-limited to ~1 report / 2s per peerId (204 no-op on violation, not an
// error — a chatty/misbehaving client should not see failures).

const STATS_REPORT_MAX_BODY_BYTES = 2048;
const STATS_REPORT_MIN_INTERVAL_MS = 2000;

interface StatsReportBody {
  roomId: string;
  peerId: string;
  sample: PeerQualitySample;
}

/** Resolves the live room state a peer must be admitted into. Injected by index.ts. */
export type GetRoomFn = (roomId: string) => RoomState | undefined;

/**
 * Reads the request body up to `STATS_REPORT_MAX_BODY_BYTES`. Resolves
 * `{ ok: false, status: 413 }` the moment the cap is exceeded (destroys the
 * socket read, does not buffer past the cap) rather than after the fact.
 */
function readCappedJsonBody(
  req: IncomingMessage,
): Promise<{ ok: true; body: unknown } | { ok: false; status: 413 | 400 }> {
  return new Promise((resolve) => {
    let received = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > STATS_REPORT_MAX_BODY_BYTES) {
        settled = true;
        // Don't destroy() the socket — that resets the connection before the
        // 413 response can be written. Just stop retaining chunks; subsequent
        // 'data' events are dropped by the `settled` guard above.
        resolve({ ok: false, status: 413 });
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({ ok: false, status: 400 });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(text) });
      } catch {
        resolve({ ok: false, status: 400 });
      }
    });

    req.on('error', () => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, status: 400 });
    });
  });
}

const REQUIRED_SAMPLE_FIELDS: ReadonlyArray<keyof PeerQualitySample> = [
  'latencyMs',
  'packetLoss',
  'jitterMs',
  'bitrateUpKbps',
  'bitrateDownKbps',
  'resolutionWidth',
  'resolutionHeight',
  'framerate',
  'packetReorderingRate',
  'encodeLatencyMs',
  'decodeLatencyMs',
  'freezeCount',
  'pauseCount',
  'connectionSetupMs',
  'iceSuccess',
  'reconnectMs',
];

/** Structural validator for the POST /stats/report body. Pure — no I/O. */
function parseStatsReportBody(body: unknown): StatsReportBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b['roomId'] !== 'string' || b['roomId'] === '') return null;
  if (typeof b['peerId'] !== 'string' || b['peerId'] === '') return null;
  const sample = b['sample'];
  if (typeof sample !== 'object' || sample === null) return null;
  const s = sample as Record<string, unknown>;
  for (const field of REQUIRED_SAMPLE_FIELDS) {
    const v = s[field];
    if (field === 'iceSuccess') {
      if (typeof v !== 'boolean') return null;
    } else if (typeof v !== 'number' || !Number.isFinite(v)) {
      return null;
    }
  }
  return { roomId: b['roomId'], peerId: b['peerId'], sample: s as unknown as PeerQualitySample };
}

/** Per-field Prometheus gauges for the `/metrics/prom` peer-quality export. */
interface PeerQualityGauges {
  latencyMs: Gauge<'roomId' | 'peerId'>;
  packetLoss: Gauge<'roomId' | 'peerId'>;
  jitterMs: Gauge<'roomId' | 'peerId'>;
  bitrateUpKbps: Gauge<'roomId' | 'peerId'>;
  bitrateDownKbps: Gauge<'roomId' | 'peerId'>;
  resolutionWidth: Gauge<'roomId' | 'peerId'>;
  resolutionHeight: Gauge<'roomId' | 'peerId'>;
  framerate: Gauge<'roomId' | 'peerId'>;
  packetReorderingRate: Gauge<'roomId' | 'peerId'>;
  encodeLatencyMs: Gauge<'roomId' | 'peerId'>;
  decodeLatencyMs: Gauge<'roomId' | 'peerId'>;
  freezeCount: Gauge<'roomId' | 'peerId'>;
  pauseCount: Gauge<'roomId' | 'peerId'>;
  connectionSetupMs: Gauge<'roomId' | 'peerId'>;
  iceSuccess: Gauge<'roomId' | 'peerId'>;
  reconnectMs: Gauge<'roomId' | 'peerId'>;
}

function buildPeerQualityGauges(registry: Registry): PeerQualityGauges {
  const mk = (name: string, help: string): Gauge<'roomId' | 'peerId'> =>
    new Gauge({ name, help, labelNames: ['roomId', 'peerId'], registers: [registry] });
  return {
    latencyMs: mk('dvconf_relay_peer_latency_ms', 'Client-reported RTT/latency, ms'),
    packetLoss: mk('dvconf_relay_peer_packet_loss', 'Client-reported packet loss'),
    jitterMs: mk('dvconf_relay_peer_jitter_ms', 'Client-reported jitter, ms'),
    bitrateUpKbps: mk('dvconf_relay_peer_bitrate_up_kbps', 'Client-reported uplink bitrate, kbps'),
    bitrateDownKbps: mk('dvconf_relay_peer_bitrate_down_kbps', 'Client-reported downlink bitrate, kbps'),
    resolutionWidth: mk('dvconf_relay_peer_resolution_width', 'Client-reported video width, px'),
    resolutionHeight: mk('dvconf_relay_peer_resolution_height', 'Client-reported video height, px'),
    framerate: mk('dvconf_relay_peer_framerate', 'Client-reported framerate, fps'),
    packetReorderingRate: mk(
      'dvconf_relay_peer_packet_reordering_rate',
      'Client-reported APPROXIMATE packet reordering rate',
    ),
    encodeLatencyMs: mk('dvconf_relay_peer_encode_latency_ms', 'Client-reported encode latency, ms'),
    decodeLatencyMs: mk('dvconf_relay_peer_decode_latency_ms', 'Client-reported decode latency, ms'),
    freezeCount: mk('dvconf_relay_peer_freeze_count', 'Client-reported cumulative freeze count'),
    pauseCount: mk('dvconf_relay_peer_pause_count', 'Client-reported cumulative pause count'),
    connectionSetupMs: mk(
      'dvconf_relay_peer_connection_setup_ms',
      'Client-reported connection-setup time, ms',
    ),
    iceSuccess: mk('dvconf_relay_peer_ice_success', 'Client-reported ICE success (1) / failure (0)'),
    reconnectMs: mk('dvconf_relay_peer_reconnect_ms', 'Client-reported reconnect time, ms'),
  };
}

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
 * @returns The HTTP server instance (for graceful shutdown).
 */
export function startMetricsServer(
  metrics: MetricsTracker,
  logger: Logger,
  probeState?: ProbeStateProvider,
  getRoom?: GetRoomFn,
): Server {
  const port = parseInt(process.env['METRICS_PORT'] ?? '4001', 10);

  // REQ-MCS-007: Read once at startup so the gate is consistent for this
  // server lifetime. Empty string = token unset = OPEN (backward-compat).
  const metricsAuthToken = process.env['METRICS_AUTH_TOKEN'] ?? '';

  // Call-quality feature: one stats window + prom registry per server instance
  // (NOT a module singleton) so tests that spin up multiple servers stay isolated.
  const statsWindow = new PeerStatsWindow();
  const promRegistry = createMetricsRegistry('relay');
  const peerGauges = buildPeerQualityGauges(promRegistry);
  const activeSessionsGauge = new Gauge({
    name: 'dvconf_relay_active_sessions',
    help: 'Active relay sessions (MetricsTracker)',
    registers: [promRegistry],
  });
  const roomCountGauge = new Gauge({
    name: 'dvconf_relay_room_count',
    help: 'Active room count (MetricsTracker)',
    registers: [promRegistry],
  });
  const bytesForwardedGauge = new Gauge({
    name: 'dvconf_relay_bytes_forwarded_total',
    help: 'Cumulative bytes forwarded across all sessions (MetricsTracker)',
    registers: [promRegistry],
  });

  // `/stats/report` rate limit: last-accepted-report wall-clock ts per peerId.
  const lastReportAt = new Map<string, number>();

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

  function refreshPromGauges(): void {
    const globalMetrics = metrics.getGlobalMetrics();
    activeSessionsGauge.set(globalMetrics.activeSessions);
    roomCountGauge.set(globalMetrics.roomCount);
    bytesForwardedGauge.set(Number(globalMetrics.totalBytesForwarded));

    for (const gauge of Object.values(peerGauges)) {
      gauge.reset();
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
    }
  }

  function buildSummary(): {
    workerId: string;
    activeSessions: number;
    cpuPercent: number;
    memMB: number;
    peers: Array<{ peerId: string; roomId: string } & PeerQualitySample>;
  } {
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

  async function handleStatsReport(req: IncomingMessage, reqLog: Logger): Promise<{
    status: number;
    body?: unknown;
  }> {
    const read = await readCappedJsonBody(req);
    if (!read.ok) {
      return { status: read.status, body: { error: read.status === 413 ? 'payload_too_large' : 'bad_request' } };
    }
    const parsed = parseStatsReportBody(read.body);
    if (!parsed) {
      return { status: 400, body: { error: 'invalid_body' } };
    }
    const { roomId, peerId, sample } = parsed;

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

    statsWindow.push(roomId, peerId, sample, now);
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
    });

    return { status: 204 };
  }

  const server = createServer((req, res) => {
    // Capture request-arrival time for the /api/probe server-handling RTT.
    const startedAt = performance.now();

    const url = req.url ?? '/';

    // F63 (DOH-003): honor the inbound x-trace-id (the validator's measurement-cycle
    // id on the /metrics + /api/probe legs) so the relay's request logs correlate to
    // the validator cycle and the on-chain proof — this is the demo-path continuity.
    const reqLog = traceChild(logger, readTraceId(req.headers));

    // Route: POST /stats/report — client-reported per-peer quality sample.
    if (req.method === 'POST' && url === '/stats/report') {
      handleStatsReport(req, reqLog)
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
        refreshPromGauges();
        promRegistry
          .metrics()
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
        res.end(JSON.stringify(buildSummary()));
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
