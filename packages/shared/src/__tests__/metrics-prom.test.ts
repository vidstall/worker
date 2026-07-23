/**
 * Shared Prometheus metrics primitives — server boot/close + bearer gate.
 * Mirrors `healthz.test.ts`'s conventions (ephemeral port, close() teardown).
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import {
  createMetricsRegistry,
  startPromMetricsServer,
  createConcurrencyGauge,
  type PromMetricsServerHandle,
} from '../metrics-prom.js';

let handle: PromMetricsServerHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

function get(
  port: number,
  path: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      })
      .on('error', reject);
  });
}

describe('createMetricsRegistry', () => {
  it('wires collectDefaultMetrics (process_cpu / heap gauges present)', async () => {
    const registry = createMetricsRegistry('test-service');
    const body = await registry.metrics();
    expect(body).toMatch(/process_cpu_user_seconds_total/);
    expect(body).toMatch(/nodejs_heap_size_total_bytes/);
  });
});

describe('startPromMetricsServer', () => {
  it('GET /metrics returns 200 + Prometheus content-type (token unset = open)', async () => {
    const registry = createMetricsRegistry('svc-a');
    handle = await startPromMetricsServer({ port: 0, service: 'svc-a', registry });
    const { status, headers, body } = await get(handle.port, '/metrics');
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/text\/plain; version=0\.0\.4/);
    expect(body).toMatch(/process_cpu_user_seconds_total/);
  });

  it('404s a non-/metrics path', async () => {
    const registry = createMetricsRegistry('svc-b');
    handle = await startPromMetricsServer({ port: 0, service: 'svc-b', registry });
    const { status } = await get(handle.port, '/other');
    expect(status).toBe(404);
  });

  it('token SET: GET /metrics without Authorization returns 401', async () => {
    const registry = createMetricsRegistry('svc-c');
    handle = await startPromMetricsServer({
      port: 0,
      service: 'svc-c',
      registry,
      token: 'secret-tok',
    });
    const { status } = await get(handle.port, '/metrics');
    expect(status).toBe(401);
  });

  it('token SET: GET /metrics with correct Bearer returns 200', async () => {
    const registry = createMetricsRegistry('svc-d');
    handle = await startPromMetricsServer({
      port: 0,
      service: 'svc-d',
      registry,
      token: 'secret-tok',
    });
    const { status } = await get(handle.port, '/metrics', {
      Authorization: 'Bearer secret-tok',
    });
    expect(status).toBe(200);
  });

  it('token SET: GET /metrics with wrong Bearer returns 401', async () => {
    const registry = createMetricsRegistry('svc-e');
    handle = await startPromMetricsServer({
      port: 0,
      service: 'svc-e',
      registry,
      token: 'secret-tok',
    });
    const { status } = await get(handle.port, '/metrics', {
      Authorization: 'Bearer wrong-value',
    });
    expect(status).toBe(401);
  });

  it('close() stops the server', async () => {
    const registry = createMetricsRegistry('svc-f');
    handle = await startPromMetricsServer({ port: 0, service: 'svc-f', registry });
    const port = handle.port;
    await handle.close();
    handle = undefined;
    await expect(get(port, '/metrics')).rejects.toThrow();
  });
});

describe('createConcurrencyGauge', () => {
  it('exposes dvconf_active_sessions{service} via the registry', async () => {
    const registry = createMetricsRegistry('svc-g');
    const gauge = createConcurrencyGauge(registry, 'svc-g');
    gauge.setActiveSessions(7);
    const body = await registry.metrics();
    expect(body).toMatch(/dvconf_active_sessions\{service="svc-g"\} 7/);
  });
});
