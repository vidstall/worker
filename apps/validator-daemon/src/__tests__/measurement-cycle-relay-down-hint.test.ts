/**
 * measurement-cycle.ts — client-reported relay-down hint re-probe (accelerant
 * only). When the STANDBY leg's metrics carry a fresh
 * `clientReportedDeadRelayHint`, `measureRoom` immediately calls `measureRelay`
 * one EXTRA time for the room's primary, in the SAME cycle — advisory only,
 * never touching `liveness-sweep.ts` / `cast_liveness_vote` (this suite
 * doesn't even import that module, by construction).
 *
 * session-proof.ts + relay-metrics-resolver.ts are mocked out (no real
 * signing/chain-read); the relay metrics HTTP legs are REAL tiny local
 * servers so the actual `createRelayProbe` -> `fetchRelayMetrics` -> onMetrics
 * chain runs unmocked end-to-end.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as http from 'node:http';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { createLogger } from '@dvconf/shared';
import type { DaemonState, ActiveRoom } from '../daemon/state.js';

vi.mock('../session-proof.js', () => ({
  buildSessionProof: vi.fn(() => ({ roomId: 'r', relayMinerId: 'x' })),
  serializeProofBcs: vi.fn(() => new Uint8Array()),
  dualKeySign: vi.fn().mockResolvedValue(undefined),
  logProofSummary: vi.fn(),
  submitSessionProof: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../relay-metrics-resolver.js', () => ({
  readRelayMetricsUrls: vi.fn().mockRejectedValue(new Error('no chain in test')),
}));

const { runMeasurementCycle } = await import('../daemon/measurement-cycle.js');

const logger = createLogger('test:measurement-cycle-hint');

const ROOM_ID = '0xroom1';
const PRIMARY_ID = '0xprimary';
const STANDBY_ID = '0xstandby';

function serveJson(handler: () => unknown): Promise<{ url: string; server: http.Server; callCount: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(handler()));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server, callCount: () => calls });
    });
  });
}

const baseMetrics = {
  bytesForwarded: '0',
  uniquePeers: 0,
  packetsLost: 0,
  jitter: 0,
  duration: 0,
  activePeers: 0,
};

function makeState(overrides: Partial<DaemonState> = {}): DaemonState {
  return {
    client: {} as never,
    mainKeypair: {} as never,
    sessionKeypair: {} as never,
    sessionAddress: '0xsession',
    config: { packageId: '0xpkg', relayRegistryId: '0xreg' } as never,
    validatorCapId: '0xcap',
    measurementTimer: null,
    eventPoller: null,
    escrowPoller: null,
    roomPoller: null,
    livenessSweep: null,
    roomHealthVoteWatcher: null,
    roomHealthExpirySweep: null,
    escrowMap: new Map(),
    activeRooms: new Map(),
    heartbeatStop: null,
    rttSamplesMs: [],
    consecutiveUnreachable: 0,
    relayStunLossBps: new Map(),
    relayMetricsUrls: new Map(),
    relayPathSamples: new Map(),
    healthMonitorStop: null,
    canaryCellLoop: null,
    canaryVerifyLoop: null,
    canaryClaimsServer: null,
    liveConsumer: null,
    coverageServer: null,
    running: true,
    inFlightMeasurement: null,
    ...overrides,
  };
}

describe('measureRoom — client-reported relay-down hint re-probe', () => {
  let primaryServer: http.Server;
  let standbyServer: http.Server;

  afterEach(() => {
    primaryServer?.close();
    standbyServer?.close();
    delete process.env['RELAY_METRICS_URL'];
    vi.clearAllMocks();
  });

  it('a fresh hint on the standby leg triggers exactly ONE extra primary probe in the same cycle', async () => {
    const primary = await serveJson(() => ({ ...baseMetrics }));
    const standby = await serveJson(() => ({ ...baseMetrics, clientReportedDeadRelayHint: true }));
    primaryServer = primary.server;
    standbyServer = standby.server;

    const room: ActiveRoom = { primaryRelayId: PRIMARY_ID, standbyRelayId: STANDBY_ID };
    const state = makeState({
      activeRooms: new Map([[ROOM_ID, room]]),
      relayMetricsUrls: new Map([
        [normalizeSuiAddress(PRIMARY_ID), primary.url],
        [normalizeSuiAddress(STANDBY_ID), standby.url],
      ]),
    });

    await runMeasurementCycle(state, 'validator-1', logger);

    // Normal cycle: 1 primary metrics fetch + 2 standby requests (liveness /api/probe
    // + metrics /metrics/:roomId, same test server). Fresh hint => 1 EXTRA primary fetch.
    expect(primary.callCount()).toBe(2);
    expect(standby.callCount()).toBe(2);
  });

  it('no hint (absent field) -> zero extra primary probes', async () => {
    const primary = await serveJson(() => ({ ...baseMetrics }));
    const standby = await serveJson(() => ({ ...baseMetrics }));
    primaryServer = primary.server;
    standbyServer = standby.server;

    const room: ActiveRoom = { primaryRelayId: PRIMARY_ID, standbyRelayId: STANDBY_ID };
    const state = makeState({
      activeRooms: new Map([[ROOM_ID, room]]),
      relayMetricsUrls: new Map([
        [normalizeSuiAddress(PRIMARY_ID), primary.url],
        [normalizeSuiAddress(STANDBY_ID), standby.url],
      ]),
    });

    await runMeasurementCycle(state, 'validator-1', logger);

    expect(primary.callCount()).toBe(1); // no extra re-probe
    expect(standby.callCount()).toBe(2); // liveness /api/probe + metrics /metrics/:roomId
  });

  it('this path never touches liveness-sweep.ts / cast_liveness_vote (not exported by this module)', async () => {
    // Structural guard: measurement-cycle.ts's hint re-probe is a plain extra
    // measureRelay call — nothing here exports/calls a liveness-vote primitive.
    const mod = await import('../daemon/measurement-cycle.js');
    expect(Object.keys(mod)).not.toContain('castLivenessVote');
    expect(Object.keys(mod)).toEqual(['handleRoomClosed', 'runMeasurementCycle']);
  });
});
