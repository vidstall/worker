/**
 * P17 M1 / F63 (DOH-003) — validator probe legs carry x-trace-id (edges 1+2).
 *
 * The validator measurement cycle births a trace id and threads it through both
 * relay probe HTTP calls so a relay can correlate the probe to the validator's
 * measurement cycle and the eventual on-chain proof submit.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { TRACE_HEADER } from '@dvconf/shared';
import { fetchRelayMetrics, fetchProbeLiveness } from '../probe.js';

let server: http.Server | undefined;
let received: Record<string, string | string[] | undefined> = {};

/** Start a stub relay that records request headers and returns the given JSON. */
function stub(body: unknown): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      received = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, () => resolve((server!.address() as { port: number }).port));
  });
}

afterEach(() => {
  server?.close();
  server = undefined;
  received = {};
});

describe('validator probe trace propagation (DOH-003)', () => {
  it('fetchRelayMetrics sends x-trace-id', async () => {
    const port = await stub({
      bytesForwarded: '0',
      uniquePeers: 0,
      packetsLost: 0,
      jitter: 0,
      duration: 1,
      activePeers: 0,
    });
    await fetchRelayMetrics(`http://127.0.0.1:${port}`, '0xroom', 'trace-abc');
    expect(received[TRACE_HEADER]).toBe('trace-abc');
  });

  it('fetchProbeLiveness sends x-trace-id', async () => {
    const port = await stub({
      ok: true,
      role: 'standby',
      latency_ms: 1,
      pipe_consumer_alive: true,
      rtcp_alive: true,
    });
    await fetchProbeLiveness(`http://127.0.0.1:${port}`, 'trace-xyz');
    expect(received[TRACE_HEADER]).toBe('trace-xyz');
  });
});
