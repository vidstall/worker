/**
 * S30.C — TurnContext injection tests for the relay mediasoup signaling
 * server.
 *
 * See signaling.fixtures.ts for the shared harness (mocked mediasoup types,
 * createMockManager/mockLogger, connect/waitForMessage).
 *
 * Requirements: RELAY-05
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type TurnContext } from '../signaling/index.js';
import {
  createMockManager,
  mockLogger,
  connect,
  waitForMessage,
  resetTransportCounter,
} from './signaling.fixtures.js';

// ── S30.C: TurnContext injection ────────────────────────────────────

describe('Relay signaling with turnContext (S30.C)', () => {
  let s30Server: WebSocketServer | undefined;

  afterEach(() => {
    if (s30Server) {
      s30Server.close();
      s30Server = undefined;
    }
  });

  function startWithTurnContext(
    buildIceServers: TurnContext['buildIceServers'],
  ): Promise<{ wss: WebSocketServer; port: number }> {
    return new Promise((resolve) => {
      const originalPort = process.env['WS_PORT'];
      process.env['WS_PORT'] = '0';

      const mgr = createMockManager();
      const metrics = new MetricsTracker();
      const logger = mockLogger();

      const { wss } = createSignalingServer(mgr, metrics, logger, {
        buildIceServers,
      });

      process.env['WS_PORT'] = originalPort;

      wss.on('listening', () => {
        const addr = wss.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        resolve({ wss, port });
      });
    });
  }

  it('transportCreated includes iceServers when turnContext returns an array', async () => {
    resetTransportCounter();
    const cannedIceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: ['turn:relay.example.com:3478?transport=udp'],
        username: '1700001200:peer-9',
        credential: 'mock-pw==',
      },
    ];
    const buildIceServers = vi.fn(async () => cannedIceServers);

    const { wss, port } = await startWithTurnContext(buildIceServers);
    s30Server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-turn-1', peerId: 'peer-9' }));
    await joinPromise;
    await waitForMessage(ws); // drain roomMode

    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    const msg = await transportPromise;

    expect(msg['type']).toBe('transportCreated');
    expect(msg['iceServers']).toEqual(cannedIceServers);
    expect(buildIceServers).toHaveBeenCalledWith('peer-9');
    ws.close();
  });

  it('transportCreated omits iceServers when turnContext returns null', async () => {
    resetTransportCounter();
    const buildIceServers = vi.fn(async () => null);

    const { wss, port } = await startWithTurnContext(buildIceServers);
    s30Server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-turn-2', peerId: 'peer-10' }));
    await joinPromise;
    await waitForMessage(ws); // drain roomMode

    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    const msg = await transportPromise;

    expect(msg['type']).toBe('transportCreated');
    expect(msg['iceServers']).toBeUndefined();
    ws.close();
  });

  it('transportCreated omits iceServers and still succeeds when turnContext throws', async () => {
    resetTransportCounter();
    const buildIceServers = vi.fn(async () => {
      throw new Error('cp-daemon unreachable');
    });

    const { wss, port } = await startWithTurnContext(buildIceServers);
    s30Server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-turn-3', peerId: 'peer-11' }));
    await joinPromise;
    await waitForMessage(ws); // drain roomMode

    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    const msg = await transportPromise;

    expect(msg['type']).toBe('transportCreated');
    expect(msg['iceServers']).toBeUndefined();
    ws.close();
  });
});
