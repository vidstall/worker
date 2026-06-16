/**
 * P17 M1 / F65 (DOH-008/009/010) — shared liveness server.
 *
 * Always-on, unauthenticated, CHEAP (no chain RPC, no dependency read). Mounted by
 * cp-daemon / signaling / validator-daemon on a dedicated port; relay keeps its own
 * metrics-server /healthz (RO-020) and only extends the body.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startHealthzServer, type HealthzHandle } from '../healthz.js';

let handle: HealthzHandle | undefined;

afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      })
      .on('error', reject);
  });
}

describe('startHealthzServer', () => {
  it('GET /healthz returns 200 + {status:alive, uptime_seconds, pid, service}', async () => {
    handle = await startHealthzServer({ port: 0, service: 'cp-daemon' });
    const { status, body } = await get(handle.port, '/healthz');
    expect(status).toBe(200);
    const json = JSON.parse(body);
    expect(json.status).toBe('alive');
    expect(typeof json.uptime_seconds).toBe('number');
    expect(json.uptime_seconds).toBeGreaterThanOrEqual(0);
    expect(json.pid).toBe(process.pid);
    expect(json.service).toBe('cp-daemon');
  });

  it('404s a non-/healthz path (minimal router, not a catch-all)', async () => {
    handle = await startHealthzServer({ port: 0, service: 'signaling' });
    const { status } = await get(handle.port, '/other');
    expect(status).toBe(404);
  });

  it('close() stops the server', async () => {
    handle = await startHealthzServer({ port: 0, service: 'validator-daemon' });
    const port = handle.port;
    await handle.close();
    handle = undefined;
    await expect(get(port, '/healthz')).rejects.toThrow();
  });
});

describe('P17 M2b-P7 — CORS + isLive capability (DOH-027/029)', () => {
  it('DOH-029: /healthz 200 carries access-control-allow-origin: * (browser viz fetch)', async () => {
    handle = await startHealthzServer({ port: 0, service: 'cp-daemon' });
    const { status, headers } = await get(handle.port, '/healthz');
    expect(status).toBe(200);
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  it('DOH-029: the 404 path also carries the CORS header (shared header object)', async () => {
    handle = await startHealthzServer({ port: 0, service: 'cp-daemon' });
    const { status, headers } = await get(handle.port, '/nope');
    expect(status).toBe(404);
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  it('DOH-027: isLive()===false ⇒ 503 + {status:not_ready}, body still the 4 keys', async () => {
    handle = await startHealthzServer({ port: 0, service: 'validator-daemon', isLive: () => false });
    const { status, body, headers } = await get(handle.port, '/healthz');
    expect(status).toBe(503);
    expect(headers['access-control-allow-origin']).toBe('*');
    const json = JSON.parse(body);
    expect(json.status).toBe('not_ready');
    // Body stays exactly the 4 keys (status overridden, no new keys).
    expect(Object.keys(json).sort()).toEqual(['pid', 'service', 'status', 'uptime_seconds']);
    expect(json.service).toBe('validator-daemon');
    expect(typeof json.uptime_seconds).toBe('number');
    expect(json.pid).toBe(process.pid);
  });

  it('DOH-027: isLive()===true ⇒ 200 + {status:alive} (capability on, healthy)', async () => {
    handle = await startHealthzServer({ port: 0, service: 'signaling', isLive: () => true });
    const { status, body } = await get(handle.port, '/healthz');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('alive');
  });

  it('default (no isLive) keeps 200 alive — capability is opt-in (P8-P10 wires it)', async () => {
    handle = await startHealthzServer({ port: 0, service: 'cp-daemon' });
    const { status, body } = await get(handle.port, '/healthz');
    expect(status).toBe(200);
    expect(JSON.parse(body).status).toBe('alive');
  });
});
