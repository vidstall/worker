/**
 * Frontend log-shipping bridge — `POST /logs/report` on the relay metrics
 * HTTP server.
 *
 * Mirrors `stats-report.test.ts` conventions (ephemeral port via
 * METRICS_PORT=0, `fetch` against 127.0.0.1). The handler's entire "shipping"
 * mechanism is `console.log`-ing each accepted entry as a structured JSON
 * line (already tailed to Loki by Docker's `loki` logging driver), so the
 * tests spy on `console.log` rather than asserting against any new metrics
 * state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createLogger } from '@dvconf/shared';
import { MetricsTracker } from '../metrics.js';
import { startMetricsServer, type GetRoomFn } from '../metrics-server.js';
import type { RoomState, PeerState } from '../room-handler.js';

const logger = createLogger('test:logs-report');

interface ClientLogEntryInput {
  level?: string;
  module?: string;
  message?: string;
  context?: unknown;
  timestamp?: string;
}

function entry(overrides: ClientLogEntryInput = {}): Required<ClientLogEntryInput> {
  return {
    level: 'ERROR',
    module: 'webrtc/useRelay',
    message: 'Failed to consume producer',
    context: undefined,
    timestamp: '2026-08-03T00:00:00.000Z',
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

describe('POST /logs/report', () => {
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
  });

  afterEach(() => {
    server?.close();
    delete process.env['METRICS_PORT'];
    vi.restoreAllMocks();
  });

  it('accepts a batch from an admitted peer -> 204 and logs each entry to stdout', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', entries: [entry(), entry({ level: 'WARN' })] }),
    });
    expect(res.status).toBe(204);
    expect(logSpy).toHaveBeenCalledTimes(2);
    const first = JSON.parse(logSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(first).toMatchObject({ source: 'frontend', roomId: 'room-1', peerId: 'peer-a', level: 'ERROR' });
  });

  it('a report for an unknown room -> 404', async () => {
    start((_roomId) => undefined);
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'ghost-room', peerId: 'peer-a', entries: [entry()] }),
    });
    expect(res.status).toBe(404);
  });

  it('a report for a peer NOT admitted into the room -> 403', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-ghost', entries: [entry()] }),
    });
    expect(res.status).toBe(403);
  });

  it('no getRoom wired at all -> every report is rejected (404, room unresolvable)', async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', entries: [entry()] }),
    });
    expect(res.status).toBe(404);
  });

  it('an oversized body -> 413', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const body = JSON.stringify({
      roomId: 'room-1',
      peerId: 'peer-a',
      entries: [entry({ context: { padding: 'x'.repeat(16384) } })],
    });
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(413);
  });

  it('a malformed body -> 400', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1' }), // missing peerId/entries
    });
    expect(res.status).toBe(400);
  });

  it('an entry missing a required field -> 400', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', entries: [{ level: 'INFO' }] }),
    });
    expect(res.status).toBe(400);
  });

  it('an empty entries array -> 400', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', entries: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('OPTIONS /logs/report -> 204 with CORS preflight headers', async () => {
    start();
    const res = await fetch(`http://127.0.0.1:${port}/logs/report`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/);
    expect(res.headers.get('access-control-allow-headers')).toMatch(/Content-Type/);
  });

  it('rate-limits reports faster than ~1/2s from the same peer (204 no-op, not an error)', async () => {
    const rooms = new Map<string, RoomState>([['room-1', fakeRoom('room-1', ['peer-a'])]]);
    start((roomId) => rooms.get(roomId));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const post = () =>
      fetch(`http://127.0.0.1:${port}/logs/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room-1', peerId: 'peer-a', entries: [entry()] }),
      });

    const first = await post();
    expect(first.status).toBe(204);

    const second = await post();
    expect(second.status).toBe(204); // rate-limited no-op, still 204

    // Only the first batch's entries should have been logged.
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});
