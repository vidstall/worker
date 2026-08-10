/**
 * App-level peer-heartbeat for the standby relay (Layer B detection).
 *
 * The standby relay pings the primary relay every intervalMs. On
 * missThreshold consecutive misses it fires onStandbyReady(roomId) exactly
 * once (idempotent). Wired from apps/relay/src/index.ts: onStandbyReady
 * resumes this room's paused warm-pipe consumer and flips local role
 * bookkeeping (the same state transition the on-chain RelayPromoted handler
 * performs, kept idempotent against a later duplicate promotion) — purely a
 * local data-plane action, no chain transaction is submitted from here.
 *
 * Protocol: HTTP(S) GET to peerUrl/healthz. peerUrl is normalized from
 * whatever scheme it was resolved in (ws://, wss://, http://, https://) via
 * toHealthzBase before pinging.
 * Per-ping timeout: intervalMs / 2 (e.g. 500ms at default 1000ms interval).
 * On timeout or non-2xx: consecutiveMisses++.
 * On success (2xx): consecutiveMisses reset to 0.
 *
 * Requirements: REQ-RO-006
 * Contract: C4 (CONTRACTS.md)
 */

import http from 'http';
import https from 'https';
import type { Logger } from '@dvconf/shared';
import { recordFailoverPhase } from './failover-metrics.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface HeartbeatOptions {
  /** Env: HEARTBEAT_INTERVAL_MS, default 1000ms */
  intervalMs: number;
  /** Number of consecutive misses before firing onStandbyReady. Default: 3. */
  missThreshold: number;
}

export type StandbyReadyCallback = (roomId: string) => void;

export interface RelayHeartbeatController {
  /** Start pinging the peer relay. Non-blocking. */
  start(): void;
  /** Stop the ping loop (cleanup on shutdown or room close). */
  stop(): void;
}

// ── Test seam ─────────────────────────────────────────────────────────
// Allows unit tests to inject a deterministic ping function without
// mocking the Node http module at the ESM level (avoids fake-timer /
// hoisting conflicts in vitest). Set to null in production paths.

type PingFn = (url: string, timeoutMs: number) => Promise<boolean>;

let _testPingFn: PingFn | null = null;

/**
 * For unit tests only — inject a deterministic ping replacement.
 * Call setTestPingFn(null) in afterEach to restore production behaviour.
 */
export function setTestPingFn(fn: PingFn | null): void {
  _testPingFn = fn;
}

// ── URL normalization ────────────────────────────────────────────────

/**
 * Normalizes a relay endpoint to a pingable HTTP(S) base. relay_registry's
 * on-chain endpoint_url (and the room-assignment-resolved primaryUrl passed
 * in from index.ts) is a ws://(wss://) WebSocket URL, but /healthz is a
 * plain HTTP(S) route on that SAME origin+path -- mirrors the exact
 * scheme-swap already used by the client's probeWorkerHealthz
 * (useWorkerHealthCheck.ts). Swaps protocol only, keeps the origin's own
 * host+port AND path (path-based Caddy routing means multiple workers share
 * one host -- dropping the path would ping a DIFFERENT worker's /healthz,
 * or a route that doesn't exist at all, see Caddyfile.j2). Any trailing
 * slash on the path is trimmed so the caller's own `${base}/healthz` never
 * doubles up. http:/https: URLs pass through unchanged (test fixtures + any
 * future plain-HTTP deployment). Falls back to the raw input on a malformed
 * URL so a bad primaryUrl fails the ping (and so surfaces as a miss) instead
 * of throwing out of createRelayHeartbeat.
 */
function toHealthzBase(peerUrl: string): string {
  try {
    const parsed = new URL(peerUrl);
    const protocol =
      parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
    const path = parsed.pathname.replace(/\/$/, '');
    return `${protocol}//${parsed.host}${path}`;
  } catch {
    return peerUrl;
  }
}

// ── Internal ping ─────────────────────────────────────────────────────

/**
 * Sends a single ping to `${baseUrl}/healthz`.
 * Resolves true on 2xx, false on error / timeout / non-2xx.
 */
function ping(baseUrl: string, timeoutMs: number): Promise<boolean> {
  // Test seam — injected by setTestPingFn in tests
  if (_testPingFn !== null) {
    return _testPingFn(`${baseUrl}/healthz`, timeoutMs);
  }

  // Production relay endpoints are public wss:// (-> https:// here) —
  // Node's http module can't speak TLS, so route by scheme.
  const client = baseUrl.startsWith('https:') ? https : http;

  return new Promise((resolve) => {
    let settled = false;

    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(ok);
    };

    const timeoutHandle = setTimeout(() => {
      req.destroy();
      settle(false);
    }, timeoutMs);

    const req = client.get(`${baseUrl}/healthz`, (res) => {
      settle((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      // Drain body to prevent memory leak
      res.resume();
    });

    req.on('error', () => settle(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      settle(false);
    });
  });
}

// ── createRelayHeartbeat ───────────────────────────────────────────────

/**
 * Factory. Creates an app-level heartbeat controller for the standby relay.
 *
 * @param roomId         - Room this heartbeat monitors (passed to onStandbyReady).
 * @param peerUrl        - The primary relay's endpoint URL, in WHATEVER scheme
 *                         it was resolved in (ws://, wss://, http://, https://
 *                         all accepted -- normalized once here via
 *                         toHealthzBase to a pingable HTTP(S) origin).
 * @param onStandbyReady - Callback fired once when missThreshold misses reached.
 * @param options        - Interval + threshold overrides.
 * @param logger         - Optional. Previously this loop was completely
 *                         silent (no log line for start/miss/recover/fire),
 *                         which made a stuck-in-standby relay indistinguishable
 *                         from "never started" or "always passing" from the
 *                         logs alone -- confirmed live: a standby that never
 *                         promoted left zero trace of why. Every state
 *                         transition below is now logged when provided.
 */
export function createRelayHeartbeat(
  roomId: string,
  peerUrl: string,
  onStandbyReady: StandbyReadyCallback,
  options?: Partial<HeartbeatOptions>,
  logger?: Logger,
): RelayHeartbeatController {
  const intervalMs = options?.intervalMs ?? 1000;
  const missThreshold = options?.missThreshold ?? 3;
  const pingTimeoutMs = Math.floor(intervalMs / 2);
  const healthzBase = toHealthzBase(peerUrl);

  let consecutiveMisses = 0;
  let fired = false;
  let firstMissAt = 0;
  let handle: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const ok = await ping(healthzBase, pingTimeoutMs);

    if (ok) {
      if (consecutiveMisses > 0) {
        logger?.info(
          { module: 'relay-heartbeat', roomId, healthzBase, misses: consecutiveMisses },
          'REQ-RO-006: primary heartbeat recovered — resetting miss count',
        );
      }
      consecutiveMisses = 0;
    } else {
      if (consecutiveMisses === 0) firstMissAt = Date.now();
      consecutiveMisses++;
      logger?.warn(
        { module: 'relay-heartbeat', roomId, healthzBase, misses: consecutiveMisses, missThreshold },
        'REQ-RO-006: primary heartbeat miss',
      );
      if (consecutiveMisses >= missThreshold && !fired) {
        fired = true;
        const detectSeconds = (Date.now() - firstMissAt) / 1000;
        recordFailoverPhase('detect', detectSeconds);
        logger?.warn(
          { module: 'relay-heartbeat', roomId, healthzBase, misses: consecutiveMisses, detectSeconds },
          'REQ-RO-006: primary heartbeat threshold reached — promoting to primary',
        );
        onStandbyReady(roomId);
      }
    }
  }

  return {
    start(): void {
      if (handle !== null) return; // idempotent
      logger?.info(
        { module: 'relay-heartbeat', roomId, healthzBase, intervalMs, missThreshold },
        'REQ-RO-006: starting standby heartbeat loop',
      );
      handle = setInterval(() => {
        void tick();
      }, intervalMs);
    },

    stop(): void {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
        logger?.info({ module: 'relay-heartbeat', roomId, healthzBase }, 'REQ-RO-006: stopped standby heartbeat loop');
      }
    },
  };
}
