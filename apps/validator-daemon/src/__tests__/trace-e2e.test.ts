/**
 * P17 M1 / F63 (DOH-003) — E2E: the canonical defense trace path.
 *
 * A validator measurement cycle births one trace id and threads it through the
 * REAL probe primitive (createRelayProbe -> fetchRelayMetrics + fetchProbeLiveness)
 * to BOTH relay legs. This test stands up a real HTTP server and asserts both legs
 * arrive carrying the SAME x-trace-id. The relay side logging under that inbound id
 * is proven separately (relay metrics-server continuity test, P6), and the chain
 * leg is the same trace-bound logger (P5) — together: validator cycle -> relay
 * /metrics + /api/probe -> chain, one id end to end.
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { genTraceId, TRACE_HEADER } from '@dvconf/shared';
import { createRelayProbe } from '../probe.js';

let server: http.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe('F63 trace E2E — validator cycle id reaches both relay legs (DOH-003)', () => {
  it('threads one trace_id through /metrics and /api/probe', async () => {
    const seen: Record<string, string | string[] | undefined> = {};
    server = http.createServer((req, res) => {
      // Record the inbound trace id per path (this is exactly what the relay
      // metrics-server reads via readTraceId).
      const path = (req.url ?? '').startsWith('/metrics') ? 'metrics' : 'probe';
      seen[path] = req.headers[TRACE_HEADER];
      res.writeHead(200, { 'content-type': 'application/json' });
      if (path === 'metrics') {
        res.end(JSON.stringify({
          bytesForwarded: '0', uniquePeers: 0, packetsLost: 0,
          jitter: 0, duration: 1, activePeers: 0,
        }));
      } else {
        res.end(JSON.stringify({
          ok: true, role: 'standby', latency_ms: 1,
          pipe_consumer_alive: true, rtcp_alive: true,
        }));
      }
    });
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, () => resolve((server!.address() as { port: number }).port)),
    );
    const baseUrl = `http://127.0.0.1:${port}`;

    const traceId = genTraceId();
    // Standby endpoint => both the metrics leg AND the /api/probe liveness leg fire.
    const probe = createRelayProbe(
      '0xroom',
      () => ({ metricsBaseUrl: baseUrl, livenessUrl: baseUrl, stunHost: '', stunPort: undefined }),
      undefined,
      traceId,
    );
    await probe('0xrelay');

    expect(seen.metrics).toBe(traceId);
    expect(seen.probe).toBe(traceId);
  });
});
