/**
 * Shared Prometheus metrics primitives.
 *
 * Mirrors `healthz.ts`'s shape/style: a plain `node:http` server, no framework,
 * gated by the SAME `isBearerAuthorized` helper the bot control server uses
 * (open-when-unset, same as `apps/relay/src/metrics-server.ts`'s
 * `METRICS_AUTH_TOKEN` convention). `collectDefaultMetrics` gives every daemon
 * CPU/RSS/heap/event-loop-lag gauges for free — this satisfies the
 * "CPU utilization" + "memory usage" leg of the requested metric list without
 * any daemon-specific wiring.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Registry, Gauge, collectDefaultMetrics } from 'prom-client';
import { isBearerAuthorized } from './bearer-auth.js';
import type { Logger } from './logger.js';

export type { Registry } from 'prom-client';

/** Build a fresh per-service `prom-client` registry with default metrics wired. */
export function createMetricsRegistry(service: string): Registry {
  const registry = new Registry();
  registry.setDefaultLabels({ service });
  collectDefaultMetrics({ register: registry });
  return registry;
}

export type PromMetricsServerOptions = {
  /** Port to listen on; `0` lets the OS pick (used by tests). */
  port: number;
  /** Service name, echoed in default-label metrics + startup logs. */
  service: string;
  /** The registry to serve on `GET /metrics`. */
  registry: Registry;
  /** Bearer token gating `GET /metrics`. Empty/undefined = auth disabled (logs a warning). */
  token?: string;
  /** Structured logger (startup + auth warnings). */
  logger?: Logger;
};

export type PromMetricsServerHandle = {
  /** The actual bound port (resolved when `port: 0` was requested). */
  port: number;
  /** Stop the server. */
  close: () => Promise<void>;
};

/** Start the Prometheus scrape server. Resolves once it is listening. */
export function startPromMetricsServer(
  opts: PromMetricsServerOptions,
): Promise<PromMetricsServerHandle> {
  const token = opts.token ?? '';
  if (token === '') {
    opts.logger?.warn(
      { service: opts.service },
      'startPromMetricsServer: no auth token configured — /metrics is OPEN',
    );
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      if (token !== '' && !isBearerAuthorized(req, token)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      opts.registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(body);
        })
        .catch((err: unknown) => {
          opts.logger?.error({ err }, 'startPromMetricsServer: /metrics render failed');
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal_error' }));
        });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      const port = (server.address() as AddressInfo).port;
      opts.logger?.info({ port, service: opts.service }, 'Prometheus metrics server listening');
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

export type ConcurrencyGauge = {
  /** Set the current active-session count for this service. */
  setActiveSessions: (n: number) => void;
};

/** `dvconf_active_sessions{service}` gauge wrapper. */
export function createConcurrencyGauge(registry: Registry, service: string): ConcurrencyGauge {
  const gauge = new Gauge({
    name: 'dvconf_active_sessions',
    help: 'Current active session/work-item count for this service',
    labelNames: ['service'],
    registers: [registry],
  });
  return {
    setActiveSessions: (n: number) => gauge.set({ service }, n),
  };
}
