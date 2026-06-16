/**
 * REQ-MCS-007 (daemons half) — /metrics Bearer-token auth tests.
 *
 * Design: env-gated + OPEN-when-METRICS_AUTH_TOKEN-unset (backward-compat).
 * When token SET: /metrics + /metrics/:roomId require `Authorization: Bearer <token>`.
 * /healthz + /api/probe ALWAYS stay open (RO-020 invariant).
 *
 * Auth helper mirrors G3.2b inter-relay pattern (timingSafeEqual, NOT ===).
 *
 * TDD: RED → GREEN. Run this file BEFORE the implementation is added to
 * metrics-server.ts to capture the failing-test baseline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { MetricsTracker } from '../metrics.js';
import { startMetricsServer } from '../metrics-server.js';

const logger = createLogger('test:metrics-server-auth');

const TEST_TOKEN = 'test-secret-token-abc123';

/** GET helper with optional Authorization header. */
async function getJson(
  port: number,
  path: string,
  options?: { authorization?: string },
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options?.authorization) {
    headers['Authorization'] = options.authorization;
  }
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

describe('REQ-MCS-007 — /metrics Bearer auth gate', () => {
  let server: Server;
  let port: number;
  const origToken = process.env['METRICS_AUTH_TOKEN'];

  /** Start the server on an ephemeral port. Caller pre-sets METRICS_AUTH_TOKEN. */
  function start(tracker?: MetricsTracker): void {
    process.env['METRICS_PORT'] = '0';
    server = startMetricsServer(tracker ?? new MetricsTracker(), logger);
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    delete process.env['METRICS_PORT'];
    delete process.env['METRICS_AUTH_TOKEN'];
  });

  afterEach(() => {
    server?.close();
    delete process.env['METRICS_PORT'];
    // Restore original token state
    if (origToken === undefined) delete process.env['METRICS_AUTH_TOKEN'];
    else process.env['METRICS_AUTH_TOKEN'] = origToken;
  });

  // ── Token UNSET (backward-compat = validator path preserved) ────────────

  it('token UNSET: GET /metrics returns 200 (open, backward-compat)', async () => {
    // METRICS_AUTH_TOKEN not set => gate is OPEN (validator path unbroken)
    start();
    const { status } = await getJson(port, '/metrics');
    expect(status).toBe(200);
  });

  it('token UNSET: GET /metrics/:roomId returns 200 (open, validator fetchRelayMetrics path)', async () => {
    // This is the RO-019 measurement path — must work without auth when token unset
    const tracker = new MetricsTracker();
    tracker.trackBytes('0xABCDEF', 'peer-1', 100);
    // METRICS_AUTH_TOKEN is already deleted in beforeEach
    start(tracker);
    const { status } = await getJson(port, '/metrics/0xABCDEF');
    expect(status).toBe(200);
  });

  it('token UNSET: GET /metrics/:roomId with Bearer still returns 200 (token ignored when unset)', async () => {
    const tracker = new MetricsTracker();
    tracker.trackBytes('0xABCDEF', 'peer-1', 100);
    start(tracker);
    const { status } = await getJson(port, '/metrics/0xABCDEF', {
      authorization: 'Bearer any-value',
    });
    expect(status).toBe(200);
  });

  // ── Token SET + correct Bearer → 200 ────────────────────────────────────

  it('token SET + correct Bearer: GET /metrics returns 200', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status } = await getJson(port, '/metrics', {
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(status).toBe(200);
  });

  it('token SET + correct Bearer: GET /metrics/:roomId returns 200', async () => {
    const tracker = new MetricsTracker();
    tracker.trackBytes('0xABCDEF', 'peer-1', 100);
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start(tracker);
    const { status } = await getJson(port, '/metrics/0xABCDEF', {
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(status).toBe(200);
  });

  // ── Token SET + missing/wrong Bearer → 401 ──────────────────────────────

  it('token SET + no Authorization header: GET /metrics returns 401', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status, json } = await getJson(port, '/metrics');
    expect(status).toBe(401);
    expect((json as { error: string }).error).toMatch(/unauthorized/i);
  });

  it('token SET + no Authorization header: GET /metrics/:roomId returns 401', async () => {
    const tracker = new MetricsTracker();
    tracker.trackBytes('0xABCDEF', 'peer-1', 100);
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start(tracker);
    const { status } = await getJson(port, '/metrics/0xABCDEF');
    expect(status).toBe(401);
  });

  it('token SET + wrong Bearer value: GET /metrics returns 401 (timingSafeEqual rejects)', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status } = await getJson(port, '/metrics', {
      authorization: 'Bearer wrong-token-value',
    });
    expect(status).toBe(401);
  });

  it('token SET + wrong Bearer (same length): GET /metrics returns 401 (content-check, not length-only)', async () => {
    // Ensure we're doing content comparison, not just length
    const sameLength = 'A'.repeat(TEST_TOKEN.length);
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status } = await getJson(port, '/metrics', {
      authorization: `Bearer ${sameLength}`,
    });
    expect(status).toBe(401);
  });

  it('token SET + Bearer prefix missing (just token value): GET /metrics returns 401', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status } = await getJson(port, '/metrics', {
      authorization: TEST_TOKEN,
    });
    expect(status).toBe(401);
  });

  it('401 response carries JSON_HEADERS (Access-Control-Allow-Origin: *)', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const res = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  // ── /healthz + /api/probe stay OPEN regardless of token ─────────────────

  it('token SET: GET /healthz stays 200 (always open, RO-020)', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status } = await getJson(port, '/healthz');
    expect(status).toBe(200);
  });

  it('token SET: GET /healthz stays 200 even without Authorization header', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it('token SET: GET /api/probe stays 200 (always open, RO-020 standby polling)', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const { status } = await getJson(port, '/api/probe');
    expect(status).toBe(200);
  });

  it('token SET: GET /api/probe stays 200 without Authorization header', async () => {
    process.env['METRICS_AUTH_TOKEN'] = TEST_TOKEN;
    start();
    const res = await fetch(`http://127.0.0.1:${port}/api/probe`);
    expect(res.status).toBe(200);
  });
});
