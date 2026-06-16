/**
 * Shared liveness server (P17 M1 / F65, DOH-008/009/010).
 *
 * Always-on, unauthenticated, and CHEAP — no chain RPC, no dependency check, no
 * shared-state read — per the k8s liveness convention. Mounted by cp-daemon,
 * signaling, and validator-daemon on a dedicated `${SERVICE}_HEALTHZ_PORT`. relay
 * already serves /healthz from its metrics-server (RO-020) and only extends the body.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type HealthzOptions = {
  /** Port to listen on; `0` lets the OS pick (used by tests). */
  port: number;
  /** Service name echoed in the body (e.g. 'cp-daemon'). */
  service: string;
  /**
   * Optional readiness predicate (P17 M2b-P7, DOH-027). When supplied and it
   * returns `false`, GET /healthz answers `503` + `{...body, status:'not_ready'}`
   * instead of `200`/`alive`. Omitted (the default) keeps the always-200 liveness
   * behaviour — the capability is opt-in, wired per daemon at P8-P10. Used by
   * cp/sig/validator ONLY (their /healthz is not peer-polled); the relay's
   * /healthz stays always-2xx (F1 = Option A, RO-020 standby heartbeat).
   */
  isLive?: () => boolean;
};

/**
 * Shared response headers for every /healthz reply (P17 M2b-P7, DOH-029).
 * `access-control-allow-origin: *` lets the browser dashboard's `useDaemonHealthz`
 * hook fetch each daemon's /healthz cross-origin.
 */
const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
} as const;

export type HealthzHandle = {
  /** The actual bound port (resolved when `port: 0` was requested). */
  port: number;
  /** Stop the server. */
  close: () => Promise<void>;
};

/** Build the liveness body. Pure + synchronous — no awaited dependencies. */
export function healthzBody(service: string): {
  status: 'alive';
  uptime_seconds: number;
  pid: number;
  service: string;
} {
  return {
    status: 'alive',
    uptime_seconds: Math.round(process.uptime()),
    pid: process.pid,
    service,
  };
}

/** Start the always-on liveness server. Resolves once it is listening. */
export function startHealthzServer(opts: HealthzOptions): Promise<HealthzHandle> {
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
      // DOH-027: a wired `isLive` predicate gates readiness — false ⇒ 503 +
      // `status:'not_ready'` (body stays the same 4 keys, status overridden).
      if (opts.isLive && !opts.isLive()) {
        res.writeHead(503, JSON_HEADERS);
        res.end(JSON.stringify({ ...healthzBody(opts.service), status: 'not_ready' }));
        return;
      }
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(healthzBody(opts.service)));
      return;
    }
    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}
