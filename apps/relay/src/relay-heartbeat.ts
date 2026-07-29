/**
 * App-level peer-heartbeat for the standby relay (Layer B detection).
 *
 * The standby relay pings the primary relay every intervalMs. On
 * missThreshold consecutive misses it fires onStandbyReady(roomId) exactly
 * once (idempotent), which triggers consumer.resume() + emits the internal
 * standby-ready signal to the signaling daemon.
 *
 * Protocol: HTTP GET to peerUrl/healthz.
 * Per-ping timeout: intervalMs / 2 (e.g. 500ms at default 1000ms interval).
 * On timeout or non-2xx: consecutiveMisses++.
 * On success (2xx): consecutiveMisses reset to 0.
 *
 * Requirements: REQ-RO-006
 * Contract: C4 (CONTRACTS.md)
 */

import http from 'http';
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

    const req = http.get(`${baseUrl}/healthz`, (res) => {
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
 * @param peerUrl        - HTTP base URL of the primary relay (e.g. "http://primary:4001").
 * @param onStandbyReady - Callback fired once when missThreshold misses reached.
 * @param options        - Interval + threshold overrides.
 */
export function createRelayHeartbeat(
  roomId: string,
  peerUrl: string,
  onStandbyReady: StandbyReadyCallback,
  options?: Partial<HeartbeatOptions>,
): RelayHeartbeatController {
  const intervalMs = options?.intervalMs ?? 1000;
  const missThreshold = options?.missThreshold ?? 3;
  const pingTimeoutMs = Math.floor(intervalMs / 2);

  let consecutiveMisses = 0;
  let fired = false;
  let firstMissAt = 0;
  let handle: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    const ok = await ping(peerUrl, pingTimeoutMs);

    if (ok) {
      consecutiveMisses = 0;
    } else {
      if (consecutiveMisses === 0) firstMissAt = Date.now();
      consecutiveMisses++;
      if (consecutiveMisses >= missThreshold && !fired) {
        fired = true;
        recordFailoverPhase('detect', (Date.now() - firstMissAt) / 1000);
        onStandbyReady(roomId);
      }
    }
  }

  return {
    start(): void {
      if (handle !== null) return; // idempotent
      handle = setInterval(() => {
        void tick();
      }, intervalMs);
    },

    stop(): void {
      if (handle !== null) {
        clearInterval(handle);
        handle = null;
      }
    },
  };
}
