/**
 * Client-reported relay-down hint — `POST /relay-down-hint` + its effect on
 * `GET /metrics/:roomId` and `GET /metrics/prom`.
 *
 * Mirrors stats-report.test.ts's real-HTTP-server harness conventions
 * (ephemeral port via METRICS_PORT=0, `fetch` against 127.0.0.1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { MetricsTracker } from '../metrics.js';
import { startMetricsServer, type GetRoomFn } from '../metrics-server.js';
import type { RoomState, PeerState } from '../room-handler.js';

const logger = createLogger('test:relay-down-hint');

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

describe('POST /relay-down-hint', () => {
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
    vi.useRealTimers();
  });

  afterEach(() => {
    server?.close();
    delete process.env['METRICS_PORT'];
    delete process.env['METRICS_AUTH_TOKEN'];
  });

  const post = (port_: number, roomId: string, peerId: string) =>
    fetch(`http://127.0.0.1:${port_}/relay-down-hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId, peerId }),
    });

  it('OPTIONS /relay-down-hint -> 204 with CORS preflight headers', async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${port}/relay-down-hint`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Content-Type/);
  });

  it('a hint from an admitted peer -> 204', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await post(port, '0xdeadbeef', 'peer-a');
    expect(res.status).toBe(204);
  });

  it('a hint for an unknown room -> 404', async () => {
    start((_roomId) => undefined);
    const res = await post(port, 'ghost-room', 'peer-a');
    expect(res.status).toBe(404);
  });

  it('a hint from a peer NOT admitted into the room -> 403', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await post(port, '0xdeadbeef', 'peer-ghost');
    expect(res.status).toBe(403);
  });

  it('no getRoom wired at all -> every hint is rejected (404, room unresolvable)', async () => {
    start();
    const res = await post(port, '0xdeadbeef', 'peer-a');
    expect(res.status).toBe(404);
  });

  it('a malformed body -> 400', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await fetch(`http://127.0.0.1:${port}/relay-down-hint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: '0xdeadbeef' }), // missing peerId
    });
    expect(res.status).toBe(400);
  });

  it('rate-limits hints faster than ~1/2s from the same peer (204 no-op, not an error)', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));

    const first = await post(port, '0xdeadbeef', 'peer-a');
    expect(first.status).toBe(204);
    const second = await post(port, '0xdeadbeef', 'peer-a');
    expect(second.status).toBe(204); // rate-limited no-op, still 204
  });

  it('a fresh hint appears on GET /metrics/:roomId as clientReportedDeadRelayHint:true', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('0xdeadbeef', 'peer-a', 0);

    await post(port, '0xdeadbeef', 'peer-a');

    const res = await fetch(`http://127.0.0.1:${port}/metrics/0xdeadbeef`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clientReportedDeadRelayHint?: boolean };
    expect(body.clientReportedDeadRelayHint).toBe(true);
  });

  it('with no hint reported, GET /metrics/:roomId omits the field entirely (byte-identical shape)', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('0xdeadbeef', 'peer-a', 0);

    const res = await fetch(`http://127.0.0.1:${port}/metrics/0xdeadbeef`);
    const body = (await res.json()) as Record<string, unknown>;
    expect('clientReportedDeadRelayHint' in body).toBe(false);
  });

  it('an expired hint (past TTL) no longer appears on GET /metrics/:roomId', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('0xdeadbeef', 'peer-a', 0);

    const realNow = Date.now;
    let fakeNow = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);

    await post(port, '0xdeadbeef', 'peer-a');
    fakeNow += 71_000; // past the 70s TTL

    const res = await fetch(`http://127.0.0.1:${port}/metrics/0xdeadbeef`);
    const body = (await res.json()) as Record<string, unknown>;
    expect('clientReportedDeadRelayHint' in body).toBe(false);

    vi.restoreAllMocks();
  });

  it('GET /metrics/prom reflects the fresh-hint gauge for the room', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('0xdeadbeef', 'peer-a', 0);

    await post(port, '0xdeadbeef', 'peer-a');

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics/prom`)).text();
    expect(text).toMatch(/dvconf_relay_down_hint_active\{roomId="0xdeadbeef".*\} 1/);
  });

  it('GET /metrics/prom exposes a cumulative hint counter and last-seen gauge (liveness-experiment support)', async () => {
    const rooms = new Map<string, RoomState>([['0xdeadbeef', fakeRoom('0xdeadbeef', ['peer-a', 'peer-b'])]]);
    start((roomId) => rooms.get(roomId));
    tracker.trackBytes('0xdeadbeef', 'peer-a', 0);

    const before = Date.now();
    await post(port, '0xdeadbeef', 'peer-a');
    await post(port, '0xdeadbeef', 'peer-b'); // different peer, not rate-limited against peer-a

    const text = await (await fetch(`http://127.0.0.1:${port}/metrics/prom`)).text();
    expect(text).toMatch(/dvconf_relay_down_hint_total\{.*\} 2/);
    const lastAtMatch = text.match(/dvconf_relay_down_hint_last_at_seconds\{.*\} (\d+(\.\d+)?)/);
    expect(lastAtMatch).not.toBeNull();
    expect(Number(lastAtMatch?.[1])).toBeGreaterThanOrEqual(before / 1000);
  });
});
