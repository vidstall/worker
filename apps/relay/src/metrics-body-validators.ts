/**
 * HTTP metrics server for relay daemon — request body reading + validation.
 *
 * Pure extraction from metrics-server.ts: the capped-body reader, the
 * structural `parse*` validators for each POST endpoint's body, the
 * METRICS_AUTH_TOKEN bearer check, and the RO-020 probe-response builder.
 */

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { PeerQualitySample, PeerQualityAggregates } from './stats-window.js';
import {
  REQUIRED_SAMPLE_FIELDS,
  type ProbeState,
  type ProbeResponse,
  type StatsReportBody,
  type ClientLogEntry,
  type LogsReportBody,
  type RelayDownHintBody,
} from './metrics-server-types.js';

export const STATS_REPORT_MAX_BODY_BYTES = 2048;
export const STATS_REPORT_MIN_INTERVAL_MS = 2000;

export const LOGS_REPORT_MAX_BODY_BYTES = 8192;
export const LOGS_REPORT_MAX_ENTRIES = 20;
export const LOGS_REPORT_MIN_INTERVAL_MS = 2000;

export const RELAY_DOWN_HINT_TTL_MS = 70_000;
export const RELAY_DOWN_HINT_MIN_INTERVAL_MS = 2000;

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
export function isMetricsAuthorized(req: IncomingMessage, expectedToken: string): boolean {
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
export function buildProbeResponse(state: ProbeState | undefined, startedAt: number): ProbeResponse {
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

/**
 * Reads the request body up to `maxBodyBytes` (default
 * `STATS_REPORT_MAX_BODY_BYTES`). Resolves `{ ok: false, status: 413 }` the
 * moment the cap is exceeded (destroys the socket read, does not buffer past
 * the cap) rather than after the fact.
 */
export function readCappedJsonBody(
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
export function parseLogsReportBody(body: unknown): LogsReportBody | null {
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

/** Structural validator for the POST /relay-down-hint body. Pure — no I/O. */
export function parseRelayDownHintBody(body: unknown): RelayDownHintBody | null {
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
export function parseStatsReportBody(body: unknown): StatsReportBody | null {
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
