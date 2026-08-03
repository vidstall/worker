/**
 * Call-quality feature — `POST /stats/report`, `GET /metrics/prom`,
 * `GET /metrics/summary` on the relay metrics HTTP server.
 *
 * Mirrors `metrics-server.test.ts` / `metrics-server-auth.test.ts` conventions
 * (ephemeral port via METRICS_PORT=0, `fetch` against 127.0.0.1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { MetricsTracker } from '../metrics.js';
import { startMetricsServer, type GetRoomFn } from '../metrics-server.js';
import type { RoomState, PeerState } from '../room-handler.js';
import type { PeerQualitySample, PeerQualityAggregates } from '../stats-window.js';

const logger = createLogger('test:stats-report');

function sample(overrides: Partial<PeerQualitySample> = {}): PeerQualitySample {
  return {
    latencyMs: 45,
    packetLoss: 1,
    jitterMs: 3,
    bitrateUpKbps: 900,
    bitrateDownKbps: 1800,
    resolutionWidth: 1280,
    resolutionHeight: 720,
    framerate: 30,
    packetReorderingRate: 0,
    encodeLatencyMs: 12,
    decodeLatencyMs: 9,
    freezeCount: 0,
    pauseCount: 0,
    connectionSetupMs: 300,
    iceSuccess: true,
    reconnectMs: 0,
    avSyncDriftMs: 0,
    ...overrides,
  };
}

function aggregates(overrides: Partial<PeerQualityAggregates> = {}): PeerQualityAggregates {
  const stat = { avg: 1, min: 1, max: 1 };
  return {
    latencyMs: stat,
    packetLoss: stat,
    jitterMs: stat,
    bitrateUpKbps: stat,
    bitrateDownKbps: stat,
    resolutionWidth: stat,
    resolutionHeight: stat,
    framerate: stat,
    packetReorderingRate: stat,
    encodeLatencyMs: stat,
    decodeLatencyMs: stat,
    freezeCount: stat,
    pauseCount: stat,
    connectionSetupMs: stat,
    iceSuccess: stat,
    reconnectMs: stat,
    avSyncDriftMs: stat,
    ...overrides,
  };
}

function fakePeer(peerId: string): PeerState {
  return {
    peerId,
    ws: {} as PeerState['ws'],
    sendTransport: null,
    recvTransport: null,
    producers: [],
    consumers: [],
    samplerStops: new Map(),
  };
}

function fakeRoom(roomId: string, peerIds: string[]): RoomState {
  const peers = new Map<string, PeerState>();
  for (const id of peerIds) peers.set(id, fakePeer(id));
  return { roomId, router: {} as RoomState['router'], mode: 'sfu', peers } as unknown as RoomState;
}

describe('POST /stats/report + GET /metrics/prom + GET /metrics/summary', () => {
  let server: Server;
  let port: number;
  let tracker: MetricsTracker;

  function start(getRoom?: GetRoomFn): void {
    process.env['METRICS_PORT'] = '0';
    tracker = new MetricsTracker();
    server = startMetricsServer(tracker, logger, undefined, getRoom);
    port = (server.address() as AddressInfo).port;
  }

  beforeEach(() => {
    delete process.env['METRICS_PORT'];
    delete process.env['METRICS_AUTH_TOKEN'];
  });

  afterEach(() => {
    server?.close();
    delete process.env['METRICS_PORT'];
    delete process.env['METRICS_AUTH_TOKEN'];
  });

  // ── POST /stats/report ──────────────────────────────────────────────────

  it('accepts a report from an admitted peer -> 204', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample() }),
    });
    expect(res.status).toBe(204);
  });

  it('a report for an unknown room -> 404', async () => {
    start((_roomId) => undefined);
    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'ghost-room', peerId: 'peer-a', sample: sample() }),
    });
    expect(res.status).toBe(404);
  });

  it('a report for a peer NOT admitted into the room -> 403', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-ghost', sample: sample() }),
    });
    expect(res.status).toBe(403);
  });

  it('no getRoom wired at all -> every report is rejected (404, room unresolvable)', async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample() }),
    });
    expect(res.status).toBe(404);
  });

  it('an oversized body -> 413', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const bloated = sample({ latencyMs: 0 });
    const body = JSON.stringify({
      roomId: 'room-1',
      peerId: 'peer-a',
      sample: bloated,
      padding: 'x'.repeat(4096),
    });
    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(413);
  });

  it('a malformed body -> 400', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1' }), // missing peerId/sample
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits reports faster than ~1/2s from the same peer (204 no-op, not an error)', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('room-1', 'peer-a', 0);

    const post = () =>
      fetch(`http://127.0.0.1:${port}/stats/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample({ latencyMs: 10 }) }),
      });

    const first = await post();
    expect(first.status).toBe(204);

    const second = await post();
    expect(second.status).toBe(204); // rate-limited no-op, still 204

    // Only the FIRST report's value should have landed (rate-limited second didn't overwrite).
    const session = tracker.getSessionMetrics('room-1', 'peer-a');
    expect(session?.packetsLost).toBe(1); // sample() default packetLoss
  });

  it('accepted report flows into MetricsTracker.updateQuality (single source of truth)', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('room-1', 'peer-a', 0);

    await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'room-1',
        peerId: 'peer-a',
        sample: sample({ packetLoss: 7, jitterMs: 11 }),
      }),
    });

    const session = tracker.getSessionMetrics('room-1', 'peer-a');
    expect(session?.packetsLost).toBe(7);
    expect(session?.jitter).toBe(11);
  });

  // ── POST /stats/report with `aggregates` ────────────────────────────────

  it('accepts a report WITH a full aggregates object -> 204, and the aggregate gauges populate', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'room-1',
        peerId: 'peer-a',
        sample: sample(),
        aggregates: aggregates({ latencyMs: { avg: 40, min: 20, max: 90 } }),
      }),
    });
    expect(res.status).toBe(204);

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics/prom`)).text();
    expect(text).toMatch(/dvconf_relay_peer_latency_ms_avg\{roomId="room-1",peerId="peer-a".*\} 40/);
    expect(text).toMatch(/dvconf_relay_peer_latency_ms_min\{roomId="room-1",peerId="peer-a".*\} 20/);
    expect(text).toMatch(/dvconf_relay_peer_latency_ms_max\{roomId="room-1",peerId="peer-a".*\} 90/);
  });

  it('accepts a report WITHOUT aggregates -> 204, unchanged (no aggregate gauges for that peer)', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample() }),
    });
    expect(res.status).toBe(204);

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics/prom`)).text();
    expect(text).not.toMatch(/dvconf_relay_peer_latency_ms_avg\{roomId="room-1",peerId="peer-a"/);
  });

  it('a report with an aggregates object MISSING a required field -> 400', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const incomplete = aggregates() as unknown as Record<string, unknown>;
    delete incomplete['latencyMs'];
    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample(), aggregates: incomplete }),
    });
    expect(res.status).toBe(400);
  });

  it('a report with an aggregates field entry missing avg/min/max -> 400', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        roomId: 'room-1',
        peerId: 'peer-a',
        sample: sample(),
        aggregates: { ...aggregates(), latencyMs: { avg: 1, min: 1 } },
      }),
    });
    expect(res.status).toBe(400);
  });

  // ── CORS preflight ───────────────────────────────────────────────────────

  it('OPTIONS /stats/report -> 204 with CORS preflight headers', async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${port}/stats/report`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Content-Type/);
  });

  // ── GET /metrics/prom ────────────────────────────────────────────────────

  it('GET /metrics/prom returns Prometheus content-type + expected gauge names', async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${port}/metrics/prom`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain; version=0\.0\.4/);
    const text = await res.text();
    expect(text).toMatch(/dvconf_relay_active_sessions/);
    expect(text).toMatch(/dvconf_relay_room_count/);
    expect(text).toMatch(/dvconf_relay_bytes_forwarded_total/);
    expect(text).toMatch(/process_cpu_user_seconds_total/);
  });

  it('GET /metrics/prom includes per-peer gauges after a report lands', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample() }),
    });

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics/prom`)).text();
    expect(text).toMatch(/dvconf_relay_peer_latency_ms\{roomId="room-1",peerId="peer-a".*\} 45/);
    expect(text).toMatch(/dvconf_relay_peer_ice_success\{roomId="room-1",peerId="peer-a".*\} 1/);
  });

  it('GET /metrics/prom gated by METRICS_AUTH_TOKEN when set (401 without Bearer)', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'tok-1';
    start();
    const res = await fetch(`http://127.0.0.1:${port}/metrics/prom`);
    expect(res.status).toBe(401);
  });

  it('GET /metrics/prom with correct Bearer -> 200', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'tok-1';
    start();
    const res = await fetch(`http://127.0.0.1:${port}/metrics/prom`, {
      headers: { Authorization: 'Bearer tok-1' },
    });
    expect(res.status).toBe(200);
  });

  // ── GET /metrics/summary ─────────────────────────────────────────────────

  it('GET /metrics/summary has the documented shape', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    await fetch(`http://127.0.0.1:${port}/stats/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', sample: sample() }),
    });

    const res = await fetch(`http://127.0.0.1:${port}/metrics/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workerId: string;
      activeSessions: number;
      cpuPercent: number;
      memMB: number;
      peers: Array<{ peerId: string; roomId: string; latencyMs: number }>;
    };
    expect(typeof body.workerId).toBe('string');
    expect(typeof body.activeSessions).toBe('number');
    expect(typeof body.cpuPercent).toBe('number');
    expect(typeof body.memMB).toBe('number');
    expect(Array.isArray(body.peers)).toBe(true);
    expect(body.peers).toHaveLength(1);
    expect(body.peers[0]!.peerId).toBe('peer-a');
    expect(body.peers[0]!.roomId).toBe('room-1');
    expect(typeof body.peers[0]!.latencyMs).toBe('number');
  });

  it('GET /metrics/summary gated by METRICS_AUTH_TOKEN when set', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'tok-2';
    start();
    const unauthed = await fetch(`http://127.0.0.1:${port}/metrics/summary`);
    expect(unauthed.status).toBe(401);
    const authed = await fetch(`http://127.0.0.1:${port}/metrics/summary`, {
      headers: { Authorization: 'Bearer tok-2' },
    });
    expect(authed.status).toBe(200);
  });
});
