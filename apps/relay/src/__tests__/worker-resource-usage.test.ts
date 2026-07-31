/**
 * Monitoring-redesign gap #5 — mediasoup Worker resource-usage gauges on
 * GET /metrics/prom (dvconf_relay_worker_ru_{utime,stime}_ms, _maxrss_kb).
 *
 * Mirrors metrics-server.test.ts's real-HTTP-server harness.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { MetricsTracker } from '../metrics.js';
import { startMetricsServer } from '../metrics-server.js';

const logger = createLogger('test:worker-resource-usage');

function fakeWorker(pid: number, ru: { ru_utime: number; ru_stime: number; ru_maxrss: number }) {
  return {
    pid,
    getResourceUsage: async () => ru,
  } as never;
}

describe('GET /metrics/prom — mediasoup Worker resource-usage gauges', () => {
  let server: Server;

  afterEach(() => {
    server?.close();
    delete process.env['METRICS_PORT'];
  });

  function start(getWorkers?: () => unknown[]): number {
    process.env['METRICS_PORT'] = '0';
    server = startMetricsServer(
      new MetricsTracker(),
      logger,
      undefined,
      undefined,
      undefined,
      getWorkers as never,
    );
    return (server.address() as AddressInfo).port;
  }

  it('exposes per-worker ru_utime/ru_stime/ru_maxrss gauges, labeled by pid', async () => {
    const workers = [
      fakeWorker(111, { ru_utime: 250, ru_stime: 50, ru_maxrss: 40960 }),
      fakeWorker(222, { ru_utime: 300, ru_stime: 60, ru_maxrss: 51200 }),
    ];
    const port = start(() => workers);

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics/prom`)).text();
    expect(text).toMatch(/dvconf_relay_worker_ru_utime_ms\{worker="111".*\} 250/);
    expect(text).toMatch(/dvconf_relay_worker_ru_stime_ms\{worker="111".*\} 50/);
    expect(text).toMatch(/dvconf_relay_worker_ru_maxrss_kb\{worker="111".*\} 40960/);
    expect(text).toMatch(/dvconf_relay_worker_ru_utime_ms\{worker="222".*\} 300/);
  });

  it('no getWorkers wired -> gauges simply absent, scrape still succeeds', async () => {
    const port = start();
    const res = await fetch(`http://127.0.0.1:${port}/metrics/prom`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/dvconf_relay_worker_ru_utime_ms\{/);
  });

  it("a worker whose getResourceUsage() rejects is skipped, not fatal to the scrape", async () => {
    const healthy = fakeWorker(333, { ru_utime: 10, ru_stime: 5, ru_maxrss: 1024 });
    const broken = {
      pid: 444,
      getResourceUsage: async () => {
        throw new Error('worker closing');
      },
    } as never;
    const port = start(() => [healthy, broken]);

    const res = await fetch(`http://127.0.0.1:${port}/metrics/prom`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/dvconf_relay_worker_ru_utime_ms\{worker="333".*\} 10/);
    expect(text).not.toMatch(/worker="444"/);
  });
});
