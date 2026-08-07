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
 */

import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { IncomingMessage } from 'node:http';
import { Gauge, Counter } from 'prom-client';
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
  type Registry,
} from '@dvconf/shared';
import { registerFailoverMetrics } from './failover-metrics.js';
import { registerRtcQualityMetrics } from './rtc-quality-metrics.js';
import type { MetricsTracker } from './metrics.js';
import { PeerStatsWindow, type PeerQualitySample, type PeerQualityAggregates } from './stats-window.js';
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
  /**
   * Client-computed cumulative avg/min/max per field since the peer joined
   * this room (RoomPage.tsx's aggregator ref) -- OPTIONAL: absent for any
   * client (e.g. the bot's stats-reporter.ts) that doesn't maintain one.
   */
  aggregates?: PeerQualityAggregates;
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
  maxBodyBytes: number = STATS_REPORT_MAX_BODY_BYTES,
): Promise<{ ok: true; body: unknown } | { ok: false; status: 413 | 400 }> {
  return new Promise((resolve) => {
    let received = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBodyBytes) {
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
  'avSyncDriftMs',
];

// ── POST /logs/report — client-reported frontend log batch ingestion ──
//
// Same admission gate as /stats/report (peerId must be a currently-admitted
// member of roomId) — no separate auth mechanism. The entire "shipping"
// mechanism is `console.log`-ing each accepted entry as one structured JSON
// line: every worker container's stdout/stderr is already tailed to Loki via
// Docker's `loki` logging driver (see run_container.yml), so this needs no
// new infra, secrets, or Loki-side changes. Body capped larger than
// /stats/report's since this carries a batch of entries, not one sample;
// entry count is separately capped to bound worst-case payload size.

const LOGS_REPORT_MAX_BODY_BYTES = 8192;
const LOGS_REPORT_MAX_ENTRIES = 20;
const LOGS_REPORT_MIN_INTERVAL_MS = 2000;

interface ClientLogEntry {
  level: string;
  module: string;
  message: string;
  context?: unknown;
  timestamp: string;
}

interface LogsReportBody {
  roomId: string;
  peerId: string;
  entries: ClientLogEntry[];
}

/** Structural validator for a single frontend log entry. Pure — no I/O. */
function parseClientLogEntry(entry: unknown): ClientLogEntry | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e['level'] !== 'string' || e['level'] === '') return null;
  if (typeof e['module'] !== 'string' || e['module'] === '') return null;
  if (typeof e['message'] !== 'string') return null;
  if (typeof e['timestamp'] !== 'string' || e['timestamp'] === '') return null;
  return { level: e['level'], module: e['module'], message: e['message'], context: e['context'], timestamp: e['timestamp'] };
}

/** Structural validator for the POST /logs/report body. Pure — no I/O. */
function parseLogsReportBody(body: unknown): LogsReportBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b['roomId'] !== 'string' || b['roomId'] === '') return null;
  if (typeof b['peerId'] !== 'string' || b['peerId'] === '') return null;
  const rawEntries = b['entries'];
  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null;
  const entries: ClientLogEntry[] = [];
  for (const rawEntry of rawEntries.slice(0, LOGS_REPORT_MAX_ENTRIES)) {
    const parsed = parseClientLogEntry(rawEntry);
    if (!parsed) return null;
    entries.push(parsed);
  }
  return { roomId: b['roomId'], peerId: b['peerId'], entries };
}

// ── POST /relay-down-hint — client-reported "primary relay just died" hint ──
//
// A best-effort, LOW-TRUST accelerant: it never itself triggers a liveness
// vote or ejection (that stays exclusively validator-daemon's own actively-
// probed conclusion, see liveness-sweep.ts). It only makes validator-daemon
// re-probe the room's primary sooner than its normal ~60s cycle. Admission
// gate mirrors /stats/report: peerId must be a currently-admitted member of
// roomId ON THE RELAY RECEIVING THE POST (i.e. the still-alive standby —
// the client never tells us which relay died, and doesn't need to: the
// receiving relay's own identity is enough for validator-daemon to resolve
// the room's primary/standby pair).

const RELAY_DOWN_HINT_TTL_MS = 70_000;
const RELAY_DOWN_HINT_MIN_INTERVAL_MS = 2000;

interface RelayDownHintBody {
  roomId: string;
  peerId: string;
}

/** Structural validator for the POST /relay-down-hint body. Pure — no I/O. */
function parseRelayDownHintBody(body: unknown): RelayDownHintBody | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b['roomId'] !== 'string' || b['roomId'] === '') return null;
  if (typeof b['peerId'] !== 'string' || b['peerId'] === '') return null;
  return { roomId: b['roomId'], peerId: b['peerId'] };
}

/**
 * Structural validator for an OPTIONAL `aggregates` body field: when present,
 * requires `{avg, min, max}` (all finite numbers) for every one of the
 * REQUIRED_SAMPLE_FIELDS (iceSuccess included -- as a 0/1-valued field for
 * aggregation purposes, not a boolean here). Returns `null` on ANY
 * malformed field (rejects the whole body, same strictness as `sample`);
 * the field itself being entirely ABSENT from the body is handled by the
 * caller, not here.
 */
function parseAggregates(aggregates: unknown): PeerQualityAggregates | null {
  if (typeof aggregates !== 'object' || aggregates === null) return null;
  const a = aggregates as Record<string, unknown>;
  const out = {} as Record<string, { avg: number; min: number; max: number }>;
  for (const field of REQUIRED_SAMPLE_FIELDS) {
    const entry = a[field];
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    const { avg, min, max } = e;
    if (
      typeof avg !== 'number' || !Number.isFinite(avg) ||
      typeof min !== 'number' || !Number.isFinite(min) ||
      typeof max !== 'number' || !Number.isFinite(max)
    ) {
      return null;
    }
    out[field] = { avg, min, max };
  }
  return out as unknown as PeerQualityAggregates;
}

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

  let aggregates: PeerQualityAggregates | undefined;
  if (b['aggregates'] !== undefined) {
    const parsed = parseAggregates(b['aggregates']);
    if (!parsed) return null;
    aggregates = parsed;
  }

  return {
    roomId: b['roomId'],
    peerId: b['peerId'],
    sample: s as unknown as PeerQualitySample,
    ...(aggregates ? { aggregates } : {}),
  };
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
  avSyncDriftMs: Gauge<'roomId' | 'peerId'>;
}

/**
 * Base Prometheus metric name + help text per `PeerQualitySample` field —
 * the single source of truth both the current-value gauges below AND the
 * cumulative avg/min/max gauges (`buildPeerQualityAggregateGauges`) are
 * generated from, so the two stay in sync without hand-duplicating 17
 * name/help pairs three times over.
 */
const PEER_QUALITY_METRIC_INFO: Record<keyof PeerQualitySample, { name: string; help: string }> = {
  latencyMs: { name: 'dvconf_relay_peer_latency_ms', help: 'Client-reported RTT/latency, ms' },
  packetLoss: { name: 'dvconf_relay_peer_packet_loss', help: 'Client-reported packet loss' },
  jitterMs: { name: 'dvconf_relay_peer_jitter_ms', help: 'Client-reported jitter, ms' },
  bitrateUpKbps: { name: 'dvconf_relay_peer_bitrate_up_kbps', help: 'Client-reported uplink bitrate, kbps' },
  bitrateDownKbps: {
    name: 'dvconf_relay_peer_bitrate_down_kbps',
    help: 'Client-reported downlink bitrate, kbps',
  },
  resolutionWidth: { name: 'dvconf_relay_peer_resolution_width', help: 'Client-reported video width, px' },
  resolutionHeight: {
    name: 'dvconf_relay_peer_resolution_height',
    help: 'Client-reported video height, px',
  },
  framerate: { name: 'dvconf_relay_peer_framerate', help: 'Client-reported framerate, fps' },
  packetReorderingRate: {
    name: 'dvconf_relay_peer_packet_reordering_rate',
    help: 'Client-reported APPROXIMATE packet reordering rate',
  },
  encodeLatencyMs: { name: 'dvconf_relay_peer_encode_latency_ms', help: 'Client-reported encode latency, ms' },
  decodeLatencyMs: { name: 'dvconf_relay_peer_decode_latency_ms', help: 'Client-reported decode latency, ms' },
  freezeCount: { name: 'dvconf_relay_peer_freeze_count', help: 'Client-reported cumulative freeze count' },
  pauseCount: { name: 'dvconf_relay_peer_pause_count', help: 'Client-reported cumulative pause count' },
  connectionSetupMs: {
    name: 'dvconf_relay_peer_connection_setup_ms',
    help: 'Client-reported connection-setup time, ms',
  },
  iceSuccess: {
    name: 'dvconf_relay_peer_ice_success',
    help: 'Client-reported ICE success (1) / failure (0)',
  },
  reconnectMs: { name: 'dvconf_relay_peer_reconnect_ms', help: 'Client-reported reconnect time, ms' },
  avSyncDriftMs: {
    name: 'dvconf_relay_peer_av_sync_drift_ms',
    help: "Client-reported audio-vs-video sync offset, ms (audio playout timestamp minus video's; positive = audio ahead)",
  },
};

function buildPeerQualityGauges(registry: Registry): PeerQualityGauges {
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
function buildPeerQualityAggregateGauges(
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
  const workerDiedGauge = new Gauge({
    name: 'dvconf_relay_worker_died_total',
    help: 'Cumulative count of mediasoup Worker died events (F61 health signal, DOH-014)',
    registers: [promRegistry],
  });
  // Monitoring-redesign gap #5: mediasoup Worker resource usage was never
  // scraped (only the 'died' event count above). ru_utime/ru_stime are
  // already reported in ms by mediasoup's WorkerResourceUsage type (not raw
  // timeval structs); ru_maxrss is KB per the underlying getrusage(2) convention.
  const workerRuUtimeGauge = new Gauge({
    name: 'dvconf_relay_worker_ru_utime_ms',
    help: 'mediasoup Worker user CPU time, ms (getResourceUsage().ru_utime)',
    labelNames: ['worker'],
    registers: [promRegistry],
  });
  const workerRuStimeGauge = new Gauge({
    name: 'dvconf_relay_worker_ru_stime_ms',
    help: 'mediasoup Worker system CPU time, ms (getResourceUsage().ru_stime)',
    labelNames: ['worker'],
    registers: [promRegistry],
  });
  const workerRuMaxrssGauge = new Gauge({
    name: 'dvconf_relay_worker_ru_maxrss_kb',
    help: 'mediasoup Worker max resident set size, KB (getResourceUsage().ru_maxrss)',
    labelNames: ['worker'],
    registers: [promRegistry],
  });
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

  // `/logs/report` rate limit: separate map, same pattern as `/stats/report`.
  const lastLogsReportAt = new Map<string, number>();

  // `/relay-down-hint` state: fresh-hint-per-room store + its own (separate)
  // per-peerId rate limit map.
  const relayDownHints = new Map<string, { reportedAtMs: number }>();
  const lastRelayDownHintAt = new Map<string, number>();
  const relayDownHintGauge = new Gauge({
    name: 'dvconf_relay_down_hint_active',
    help: 'Client-reported relay-down hint currently fresh for this room (1) or not (0)',
    labelNames: ['roomId'],
    registers: [promRegistry],
  });
  // Liveness-experiment support (academic-eval "Fault Tolerance" dashboard,
  // vidctl utils worker stop/start): a bare (unlabeled) cumulative counter +
  // last-seen gauge so an external correlator (cli/observer/worker_liveness.py)
  // can compute "seconds from kill to first client noticing" and "how many
  // clients have noticed so far" for THIS relay instance, without needing
  // per-room cardinality (Prometheus already scopes by job/instance).
  const relayDownHintTotalCounter = new Counter({
    name: 'dvconf_relay_down_hint_total',
    help: 'Cumulative client-reported relay-down hints received by this relay instance',
    registers: [promRegistry],
  });
  const relayDownHintLastAtGauge = new Gauge({
    name: 'dvconf_relay_down_hint_last_at_seconds',
    help: 'Unix timestamp (seconds) of the most recent client-reported relay-down hint',
    registers: [promRegistry],
  });

  /** True iff roomId has a hint recorded within the last RELAY_DOWN_HINT_TTL_MS. */
  function hasFreshRelayDownHint(roomId: string, now: number): boolean {
    const hint = relayDownHints.get(roomId);
    return hint !== undefined && now - hint.reportedAtMs < RELAY_DOWN_HINT_TTL_MS;
  }

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

  async function refreshPromGauges(): Promise<void> {
    const globalMetrics = metrics.getGlobalMetrics();
    activeSessionsGauge.set(globalMetrics.activeSessions);
    roomCountGauge.set(globalMetrics.roomCount);
    bytesForwardedGauge.set(Number(globalMetrics.totalBytesForwarded));
    workerDiedGauge.set(getWorkerDiedCount?.() ?? 0);

    // Monitoring-redesign gap #5: per-worker CPU/RSS, best-effort -- a single
    // worker's getResourceUsage() rejecting (e.g. mid-close) must not drop
    // the whole scrape.
    workerRuUtimeGauge.reset();
    workerRuStimeGauge.reset();
    workerRuMaxrssGauge.reset();
    const workers = getWorkers?.() ?? [];
    await Promise.all(
      workers.map(async (worker, index) => {
        try {
          const ru = await worker.getResourceUsage();
          const label = { worker: String(worker.pid ?? index) };
          workerRuUtimeGauge.set(label, ru.ru_utime);
          workerRuStimeGauge.set(label, ru.ru_stime);
          workerRuMaxrssGauge.set(label, ru.ru_maxrss);
        } catch (err) {
          logger.warn({ err, workerPid: worker.pid }, 'getResourceUsage() failed for worker; skipping');
        }
      }),
    );

    for (const gauge of Object.values(peerGauges)) {
      gauge.reset();
    }
    for (const gauges of Object.values(peerAggregateGauges)) {
      for (const gauge of Object.values(gauges)) {
        gauge.reset();
      }
    }
    relayDownHintGauge.reset();
    const gaugeNow = Date.now();
    for (const [roomId] of relayDownHints) {
      relayDownHintGauge.set({ roomId }, hasFreshRelayDownHint(roomId, gaugeNow) ? 1 : 0);
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

  async function handleLogsReport(req: IncomingMessage, reqLog: Logger): Promise<{
    status: number;
    body?: unknown;
  }> {
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

  async function handleRelayDownHint(req: IncomingMessage, reqLog: Logger): Promise<{
    status: number;
    body?: unknown;
  }> {
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

    // Route: POST /logs/report — client-reported frontend log batch ingestion.
    if (req.method === 'POST' && url === '/logs/report') {
      handleLogsReport(req, reqLog)
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
      handleRelayDownHint(req, reqLog)
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
        refreshPromGauges()
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
        res.end(
          JSON.stringify(
            hasFreshRelayDownHint(roomId, Date.now())
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
