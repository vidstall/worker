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
import { Registry, Gauge, Histogram, Counter, collectDefaultMetrics } from 'prom-client';
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

export type RegistrationGauge = {
  /** Record this service instance's current on-chain registration state. */
  setRegistered: (registered: boolean) => void;
};

/**
 * `dvconf_registered` 0/1 gauge -- replaces the old SSH-grepped
 * `docker logs | grep 'operator address|node_id=|bootstrap failed'` status
 * check (cli/infra/inventory.py's `registry_status()`) with a real
 * Prometheus series, so `vidctl scenario run`'s telemetry snapshot can read
 * registration state through the observation system instead of SSH. No
 * `service` label needed -- each app already has its own Prometheus `job`
 * name (see IaC/ansible/roles/docker_service/templates/prometheus.yml.j2),
 * which disambiguates across relay/signaling/cp-daemon/validator-daemon.
 * Call `setRegistered(true)` once `ensureRegistered()` resolves;
 * `setRegistered(false)` on a non-fatal registration failure path if one
 * exists, so the gauge stays an explicit 0/1 rather than an absent series
 * (Prometheus reads "absent" as no data, not as 0).
 */
export function createRegistrationGauge(registry: Registry): RegistrationGauge {
  const gauge = new Gauge({
    name: 'dvconf_registered',
    help: 'Whether this service instance is currently registered on-chain (1) or not (0)',
    registers: [registry],
  });
  return {
    setRegistered: (registered: boolean) => gauge.set(registered ? 1 : 0),
  };
}

/**
 * Returns the raw `prom-client` `Gauge` for any metric name/label set other
 * than `dvconf_active_sessions` (which `createConcurrencyGauge` above
 * already owns) -- individual apps don't depend on `prom-client` directly
 * (only `packages/shared` does), so this is the generic escape hatch for
 * e.g. `dvconf_rooms_active` or `dvconf_rtc_jitter_ms`.
 */
export function createGauge(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[],
): Gauge<string> {
  return new Gauge({ name, help, labelNames, registers: [registry] });
}

// Default buckets skew toward sub-second latencies (chain polls, WS admission)
// while still covering multi-second tails (chain tx confirmation, failover
// rebuild) -- callers measuring something with a genuinely different scale
// (e.g. a multi-minute quorum wait) should pass explicit buckets instead.
const DEFAULT_DURATION_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

/**
 * Returns the raw `prom-client` `Histogram` (not a bespoke wrapper, unlike
 * `createConcurrencyGauge`) -- call sites need the full `.startTimer()`/
 * `.observe()` API with differing label combinations (chain-tx method,
 * failover phase, bot join-phase, ...), so wrapping it would just recreate
 * that API under a different name.
 */
export function createDurationHistogram(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[],
  buckets: number[] = DEFAULT_DURATION_BUCKETS,
): Histogram<string> {
  return new Histogram({ name, help, labelNames, buckets, registers: [registry] });
}

/** Returns the raw `prom-client` `Counter` -- see `createDurationHistogram`'s note on why this isn't wrapped further. */
export function createCounter(
  registry: Registry,
  name: string,
  help: string,
  labelNames: string[],
): Counter<string> {
  return new Counter({ name, help, labelNames, registers: [registry] });
}

export type PushGatewayMetric = {
  /** Prometheus metric name, e.g. `dvconf_loadtest_step_participants`. */
  name: string;
  help: string;
  /** Bare gauge value -- one-shot eval-harness results, never a running counter. */
  value: number;
  /** Extra labels beyond the job/instance/grouping key path already carries. */
  labels?: Record<string, string>;
};

/**
 * One-shot push of eval-harness results to the observer host's Pushgateway
 * (see `IaC/ansible/roles/docker_service/templates/observer-caddyfile.j2`'s
 * bearer-gated `pushgateway.<ip>.sslip.io` site block). Used by
 * `scripts/eval/{measure-onchain-cost,measure-chain-latency,run-scale-ramp}.ts`
 * -- none of these run continuously, so they can't be scraped directly the way
 * daemons are; Pushgateway is the standard Prometheus pattern for batch/one-
 * shot job results. Uses PUT (not
 * POST) so each call fully replaces the metric set under this grouping key,
 * matching Pushgateway's own recommended semantics for a single job run.
 */
export async function pushToGateway(opts: {
  /** Base URL, e.g. `https://pushgateway.1-2-3-4.sslip.io`. */
  baseUrl: string;
  /** Pushgateway `job` label -- groups related runs, e.g. `xaisen_loadtest`. */
  job: string;
  /** Pushgateway `instance` label -- distinguishes runs within a job, e.g. a run_id. */
  instance: string;
  /** Extra grouping-key path segments beyond job/instance (Pushgateway supports arbitrary extra labels this way). */
  groupingLabels?: Record<string, string>;
  metrics: PushGatewayMetric[];
  /** Bearer token for the Caddy-fronted push route; omit for a direct/internal pushgateway URL. */
  token?: string;
}): Promise<void> {
  const groupingPath = Object.entries(opts.groupingLabels ?? {})
    .map(([k, v]) => `/${encodeURIComponent(k)}/${encodeURIComponent(v)}`)
    .join('');
  const url = `${opts.baseUrl}/metrics/job/${encodeURIComponent(opts.job)}/instance/${encodeURIComponent(opts.instance)}${groupingPath}`;

  const body = opts.metrics
    .map((m) => {
      const labelStr = m.labels
        ? Object.entries(m.labels)
            .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
            .join(',')
        : '';
      const labelPart = labelStr ? `{${labelStr}}` : '';
      return `# HELP ${m.name} ${m.help}\n# TYPE ${m.name} gauge\n${m.name}${labelPart} ${m.value}`;
    })
    .join('\n');

  const headers: Record<string, string> = { 'content-type': 'text/plain; version=0.0.4' };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(url, { method: 'PUT', headers, body: body + '\n' });
  if (!res.ok) {
    throw new Error(`pushToGateway: PUT ${url} failed with ${res.status} ${res.statusText}`);
  }
}
