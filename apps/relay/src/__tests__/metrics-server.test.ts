/**
 * RO-020 — relay /api/probe standby-liveness channel + /healthz tests.
 *
 * The validator (RO-019b) calls GET /api/probe BEFORE building the standby
 * SessionProof. A SUCCESSFUL probe (200 + ok:true) lets the standby proof
 * carry duration_seconds > 0; an unanswered/failed probe omits it OR sets
 * duration_seconds = 0 (FROZEN Phase-1 standby-liveness contract).
 *
 * latency_ms is the SERVER-HANDLING RTT (time to build the response), NOT the
 * media-plane RTP RTT — documented in the body shape so the validator does not
 * mistake it for a media measurement.
 *
 * /healthz is the heartbeat channel that relay-heartbeat.ts (M1) already pings
 * but the relay never served (latent M1 gap, NG-8).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { MetricsTracker } from '../metrics.js';
import { startMetricsServer, type ProbeStateProvider } from '../metrics-server.js';

const logger = createLogger('test:metrics-server');

/** GET helper returning { status, json }. */
async function getJson(
  port: number,
  path: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

describe('RO-020 relay /api/probe + /healthz', () => {
  let server: Server;
  let port: number;

  /** Start the server on an ephemeral port with the given probe-state provider. */
  function start(provider?: ProbeStateProvider): void {
    // METRICS_PORT=0 => OS assigns a free ephemeral port (no collisions in CI).
    process.env['METRICS_PORT'] = '0';
    server = startMetricsServer(new MetricsTracker(), logger, provider);
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    delete process.env['METRICS_PORT'];
  });

  afterEach(() => {
    server?.close();
    delete process.env['METRICS_PORT'];
  });

  it('GET /healthz returns 200 ok (heartbeat channel)', async () => {
    start();
    const { status, json } = await getJson(port, '/healthz');
    expect(status).toBe(200);
    expect((json as { ok: boolean }).ok).toBe(true);
  });

  it('GET /api/probe returns 200 + liveness body (standby answered)', async () => {
    start(() => ({ role: 'standby', pipeConsumerAlive: true, rtcpAlive: true }));
    const { status, json } = await getJson(port, '/api/probe');
    expect(status).toBe(200);

    const body = json as {
      ok: boolean;
      role: string;
      ts: number;
      latency_ms: number;
      pipe_consumer_alive: boolean;
      rtcp_alive: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.role).toBe('standby');
    expect(typeof body.ts).toBe('number');
    expect(body.pipe_consumer_alive).toBe(true);
    expect(body.rtcp_alive).toBe(true);
  });

  it('GET /api/probe latency_ms is server-handling RTT (>= 0, non-negative)', async () => {
    start(() => ({ role: 'standby', pipeConsumerAlive: true, rtcpAlive: true }));
    const { json } = await getJson(port, '/api/probe');
    const body = json as { latency_ms: number };
    expect(typeof body.latency_ms).toBe('number');
    expect(body.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/probe reports role:primary when this relay is primary', async () => {
    start(() => ({ role: 'primary', pipeConsumerAlive: false, rtcpAlive: false }));
    const { status, json } = await getJson(port, '/api/probe');
    expect(status).toBe(200);
    expect((json as { role: string }).role).toBe('primary');
  });

  it('GET /api/probe ok:false when the pipe consumer is dead (standby not live)', async () => {
    start(() => ({ role: 'standby', pipeConsumerAlive: false, rtcpAlive: false }));
    const { status, json } = await getJson(port, '/api/probe');
    // The endpoint still answers (200) but signals non-liveness so the
    // validator gates duration_seconds = 0.
    expect(status).toBe(200);
    expect((json as { ok: boolean }).ok).toBe(false);
  });

  it('GET /api/probe still answers when no provider is wired (defaults)', async () => {
    start();
    const { status, json } = await getJson(port, '/api/probe');
    expect(status).toBe(200);
    // No provider => role unknown but the channel is reachable (ok present).
    expect(typeof (json as { ok: boolean }).ok).toBe('boolean');
  });

  it('existing routes unaffected: GET /metrics still returns global health', async () => {
    start();
    const { status, json } = await getJson(port, '/metrics');
    expect(status).toBe(200);
    expect(json).toHaveProperty('totalBytesForwarded');
  });
});
