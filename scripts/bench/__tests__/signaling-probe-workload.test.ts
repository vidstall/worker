import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  buildBenchPong,
  parseSignalingFrame,
  runSignalingProbeWorkload,
} from '../signaling-probe-workload.js';

const servers: WebSocketServer[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe('signaling probe workload', () => {
  it('echoes only finite timestamped bench pings', () => {
    expect(buildBenchPong({ type: 'bench-ping', send_ts: 123 })).toBe(
      '{"type":"bench-pong","send_ts":123}',
    );
    expect(buildBenchPong({ type: 'bench-ping' })).toBeNull();
    expect(buildBenchPong({ type: 'bench-ping', send_ts: Number.NaN })).toBeNull();
    expect(buildBenchPong({ type: 'offer', send_ts: 123 })).toBeNull();
  });

  it('parses string/buffer frames and rejects malformed values', () => {
    expect(parseSignalingFrame('{"type":"welcome","peerId":"p-1"}')).toMatchObject({
      type: 'welcome',
      peerId: 'p-1',
    });
    expect(parseSignalingFrame(Buffer.from('{"type":"bench-ping","send_ts":4}'))).toMatchObject({
      type: 'bench-ping',
      send_ts: 4,
    });
    expect(parseSignalingFrame('{bad')).toBeNull();
    expect(parseSignalingFrame('{"type":4}')).toBeNull();
  });

  it('keeps a fixed offer workload and returns actual pong/delivery counters', async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const sockets = new Map<string, WebSocket>();
    let nextId = 0;
    let pongCount = 0;

    server.on('connection', (ws) => {
      const peerId = `p-${nextId++}`;
      sockets.set(peerId, ws);
      ws.send(JSON.stringify({ type: 'welcome', peerId }));
      ws.send(JSON.stringify({ type: 'bench-ping', send_ts: 42 }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as {
          type: string;
          targetPeerId?: string;
          sdp?: unknown;
        };
        if (msg.type === 'bench-pong') pongCount++;
        if (msg.type === 'offer' && msg.targetPeerId !== undefined) {
          sockets.get(msg.targetPeerId)?.send(
            JSON.stringify({ type: 'offer', sdp: msg.sdp, fromPeerId: peerId }),
          );
        }
      });
    });

    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('missing test port');
    const result = await runSignalingProbeWorkload({
      url: `ws://127.0.0.1:${address.port}`,
      roomId: 'room-test',
      connections: 2,
      durationMs: 250,
      messageIntervalMs: 25,
      messagesPerPeer: 3,
    });

    expect(result.requestedUserMessages).toBe(6);
    expect(result.sentUserMessages).toBe(6);
    expect(result.deliveredUserMessages).toBe(6);
    expect(result.droppedUserMessages).toBe(0);
    expect(result.benchPongsSent).toBe(2);
    expect(pongCount).toBe(2);
    expect(result.errors).toEqual([]);
  });
});
