/**
 * REQ-RMS-005/019 + REQ-RMS-022 (static-mesh-hardening D1) — /canary/load HTTP ROUTE branch.
 *
 * The sibling coverage-server.test.ts is PURE by convention (its header forbids booting a
 * port). This file closes the ONE branch that convention leaves uncovered and that the D1
 * live-run curl assert rides on: the actual route dispatch in startCoverageServer —
 *   - GET /canary/load with NO loadProvider  -> 404 "load feed disabled" (feed OFF)
 *   - GET /canary/load WITH a seeded provider -> 200 + the seeded relay row in the payload
 * This is a PRE-EXISTING gap (the route shipped untested at REQ-RMS-005/019); D1 only adds the
 * loadProvider that flips it 404 -> 200, so this locks the exact behavior the live curl asserts.
 *
 * Ephemeral PORT 0 (OS-assigned) so it never collides with a concurrent session — the reason the
 * sibling file stays pure. The server is closed in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startCoverageServer, type LoadStateProvider } from '../coverage-server.js';
import type { DropAccumulator } from '../loss-classifier.js';

const REPORTER = '0x' + 'a'.repeat(64); // Wallet-A reporterMinerId (value irrelevant to the route branch)

function mockLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    fatal: () => {},
    trace: () => {},
    child: () => mockLogger(),
    level: 'info',
  } as never;
}

let servers: http.Server[] = [];

/** Boot startCoverageServer on an ephemeral port; resolve once it is listening. */
function boot(loadProvider?: LoadStateProvider): Promise<number> {
  const server = startCoverageServer({
    port: 0,
    provider: () => null, // CoverageStateProvider — unused here (we only hit /canary/load)
    reporterMinerId: REPORTER,
    logger: mockLogger(),
    loadProvider,
  });
  servers.push(server);
  return new Promise((resolve) => {
    const done = () => resolve((server.address() as AddressInfo).port);
    if (server.listening) done();
    else server.once('listening', done);
  });
}

/** Raw GET helper — returns the status + parsed JSON body. */
function get(
  port: number,
  path: string,
  method = 'GET',
): Promise<{ status: number; body: { error?: string; relays?: Array<{ relayMinerId: string; attestedLoadPaths: number }> } }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : {} }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

describe('REQ-RMS-005/019 + REQ-RMS-022 (D1) — GET /canary/load route dispatch', () => {
  it('with NO loadProvider wired -> 404 "load feed disabled" (feed OFF)', async () => {
    const port = await boot(undefined);
    const res = await get(port, '/canary/load');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('load feed disabled');
  });

  it('with a seeded loadProvider -> 200 + the seeded relay row surfaces as attestedLoadPaths', async () => {
    const acc: DropAccumulator = {
      byRelay: new Map([['0xrelayRoute', { drops: 1, sends: 33, rounds: 2 }]]),
    };
    const provider: LoadStateProvider = () => ({
      acc,
      heartbeatFresh: new Map<string, number>([['0xrelayRoute', 1]]),
    });
    const port = await boot(provider);
    const res = await get(port, '/canary/load');
    expect(res.status).toBe(200);
    expect(res.body.relays).toBeDefined();
    const row = res.body.relays!.find((r) => r.relayMinerId === '0xrelayRoute');
    expect(row).toBeDefined();
    expect(row!.attestedLoadPaths).toBe(33); // cumulative sends = the forwarding-path proxy
  });

  it('an unknown path -> 404, and a non-GET method -> 405 (route guards intact under the new branch)', async () => {
    const port = await boot(undefined);
    const unknown = await get(port, '/canary/does-not-exist');
    expect(unknown.status).toBe(404);
    const wrongMethod = await get(port, '/canary/load', 'POST');
    expect(wrongMethod.status).toBe(405);
  });
});
