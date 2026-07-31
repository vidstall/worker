/**
 * Client-reported relay-down hint — validator-daemon side.
 *
 * Two things exercised here, both purely additive/observational (never
 * touching the liveness-vote path):
 *   1. `fetchRelayMetrics` parses the optional `clientReportedDeadRelayHint`
 *      field from the relay's `GET /metrics/:roomId` JSON.
 *   2. `createRelayProbe`'s `onMetrics` hook fires with the raw metrics
 *      result (or null) right after the metrics leg resolves, without an
 *      extra HTTP fetch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { createRelayProbe, fetchRelayMetrics, type RelayMetricsResult, type StunProbeResult } from '../probe.js';

const ROOM_ID = '0xroom1';

describe('fetchRelayMetrics — clientReportedDeadRelayHint parsing', () => {
  let server: http.Server;

  afterEach(() => {
    server?.close();
  });

  function serveJson(body: unknown): Promise<string> {
    return new Promise((resolve) => {
      server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  const baseMetrics = {
    bytesForwarded: '100',
    uniquePeers: 1,
    packetsLost: 0,
    jitter: 0,
    duration: 10,
    activePeers: 1,
  };

  it('present + true -> RelayMetricsResult.clientReportedDeadRelayHint === true', async () => {
    const base = await serveJson({ ...baseMetrics, clientReportedDeadRelayHint: true });
    const result = await fetchRelayMetrics(base, ROOM_ID);
    expect(result?.clientReportedDeadRelayHint).toBe(true);
  });

  it('absent (today\'s common shape) -> field is undefined, not false', async () => {
    const base = await serveJson({ ...baseMetrics });
    const result = await fetchRelayMetrics(base, ROOM_ID);
    expect(result?.clientReportedDeadRelayHint).toBeUndefined();
    expect('clientReportedDeadRelayHint' in (result as object)).toBe(false);
  });
});

describe('createRelayProbe — onMetrics hook', () => {
  it('fires with the raw RelayMetricsResult right after the metrics fetch resolves', async () => {
    const observed: (RelayMetricsResult | null)[] = [];
    const metrics: RelayMetricsResult = {
      bytesForwarded: 1n,
      uniquePeers: 1n,
      packetsLost: 0n,
      jitter: 0n,
      duration: 5n,
      activePeers: 1n,
      clientReportedDeadRelayHint: true,
    };
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: 'http://standby:4001' }),
      {
        fetchMetrics: () => Promise.resolve(metrics),
        onMetrics: (m) => observed.push(m),
      },
    );

    await probe('0xstandby');

    expect(observed).toEqual([metrics]);
  });

  it('fires with null when the metrics leg is unreachable/unconfigured', async () => {
    const observed: (RelayMetricsResult | null)[] = [];
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: '' }), // no metrics leg configured
      {
        onMetrics: (m) => observed.push(m),
      },
    );

    await probe('0xstandby');

    expect(observed).toEqual([null]);
  });

  it('does not fire onMetrics until AFTER fetchMetrics resolves (no duplicate fetch)', async () => {
    const fetchMetrics = vi.fn().mockResolvedValue({
      bytesForwarded: 0n,
      uniquePeers: 0n,
      packetsLost: 0n,
      jitter: 0n,
      duration: 0n,
      activePeers: 0n,
    });
    let onMetricsCallCount = 0;
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: 'http://standby:4001' }),
      { fetchMetrics, onMetrics: () => { onMetricsCallCount += 1; } },
    );

    await probe('0xstandby');

    expect(fetchMetrics).toHaveBeenCalledTimes(1);
    expect(onMetricsCallCount).toBe(1);
  });
});

describe('createRelayProbe — onStunSample hook (monitoring-redesign gap #6)', () => {
  it('fires with the relayMinerId + raw StunProbeResult right after the STUN leg resolves', async () => {
    const observed: Array<{ relayMinerId: string; stun: StunProbeResult }> = [];
    const stunResult: StunProbeResult = {
      avgLatencyMs: 12n,
      jitterMs: 3n,
      probesSent: 10n,
      probesReceived: 9n,
      packetLossBps: 1000n,
    };
    const stunProbe = vi.fn().mockResolvedValue(stunResult);
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: '', stunHost: 'stun.example', stunPort: 3478 }),
      {
        stunProbe,
        onStunSample: (relayMinerId, stun) => observed.push({ relayMinerId, stun }),
      },
    );

    await probe('0xrelay1');

    expect(observed).toEqual([{ relayMinerId: '0xrelay1', stun: stunResult }]);
  });

  it('does not fire when the STUN leg is unconfigured (no stunHost/stunPort)', async () => {
    const observed: unknown[] = [];
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: '' }),
      { onStunSample: (...args) => observed.push(args) },
    );

    await probe('0xrelay1');

    expect(observed).toEqual([]);
  });

  it('does not fire when the STUN probe itself throws', async () => {
    const observed: unknown[] = [];
    const probe = createRelayProbe(
      ROOM_ID,
      () => ({ metricsBaseUrl: '', stunHost: 'stun.example', stunPort: 3478 }),
      {
        stunProbe: vi.fn().mockRejectedValue(new Error('udp timeout')),
        onStunSample: (...args) => observed.push(args),
      },
    );

    await probe('0xrelay1');

    expect(observed).toEqual([]);
  });
});
