/**
 * Integration-style tests for the relay mediasoup signaling server.
 *
 * Starts a real WebSocket server with a mocked MediasoupManager (mediasoup
 * native workers are unavailable on Windows CI). Verifies the full signaling
 * protocol: join, createTransport, leave, disconnect cleanup.
 *
 * Requirements: RELAY-05
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types ────────────────────────────────────────────

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [{ foundation: '1', priority: 1, ip: '127.0.0.1', port: 10000, type: 'host', protocol: 'udp' }],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-1', kind: 'audio', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, close: vi.fn() }),
    close: vi.fn(),
  };
}

let transportCounter = 0;

function mockRouter() {
  return {
    rtpCapabilities: {
      codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
      headerExtensions: [],
    },
    createWebRtcTransport: vi.fn().mockImplementation(async () => {
      transportCounter++;
      return mockTransport(`transport-${transportCounter}`);
    }),
    canConsume: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}

function createMockManager(): MediasoupManager {
  const router = mockRouter();
  return {
    workers: [{ pid: 1 } as any],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Start the relay signaling server on a random port. */
function startServer(
  manager?: MediasoupManager,
): Promise<{ wss: WebSocketServer; port: number; getRoomCount: () => number }> {
  return new Promise((resolve) => {
    // Use port 0 so the OS picks a random available port.
    // createSignalingServer reads WS_PORT from env, so we set it to 0.
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';

    const mgr = manager ?? createMockManager();
    const metrics = new MetricsTracker();
    const logger = mockLogger();

    const { wss, getRoomCount } = createSignalingServer(mgr, metrics, logger);

    // Restore env immediately (server already bound)
    process.env['WS_PORT'] = originalPort;

    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, getRoomCount });
    });
  });
}

/** Connect a raw WebSocket client to the server. */
function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Wait for the next JSON message on a WebSocket. */
function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

/** Small delay for async processing. */
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// ── Tests ───────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;

afterEach(() => {
  if (server) {
    server.close();
    server = undefined;
  }
});

describe('Relay signaling server', () => {
  beforeEach(() => {
    transportCounter = 0;
  });

  it('starts and accepts connections', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('join message returns routerRtpCapabilities', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);
    const msgPromise = waitForMessage(ws);

    ws.send(JSON.stringify({ type: 'join', roomId: 'room-1', peerId: 'peer-1' }));

    const msg = await msgPromise;
    expect(msg['type']).toBe('routerRtpCapabilities');
    expect(msg['rtpCapabilities']).toBeDefined();
    expect(msg['mode']).toBeDefined();
    ws.close();
  });

  it('createTransport (send) returns transportCreated with params', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // Must join first
    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-2', peerId: 'peer-2' }));
    await joinPromise;

    // Request send transport
    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));

    const msg = await transportPromise;
    expect(msg['type']).toBe('transportCreated');
    expect(msg['id']).toBeDefined();
    expect(msg['iceParameters']).toBeDefined();
    expect(msg['iceCandidates']).toBeDefined();
    expect(msg['dtlsParameters']).toBeDefined();
    ws.close();
  });

  it('createTransport (recv) returns transportCreated', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-3', peerId: 'peer-3' }));
    await joinPromise;

    const transportPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));

    const msg = await transportPromise;
    expect(msg['type']).toBe('transportCreated');
    expect(msg['id']).toBeDefined();
    ws.close();
  });

  it('peer disconnect cleans up room', async () => {
    const { wss, port, getRoomCount } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-4', peerId: 'peer-4' }));
    await joinPromise;

    expect(getRoomCount()).toBe(1);

    // Close connection — should trigger cleanup
    ws.close();
    await tick(200);

    expect(getRoomCount()).toBe(0);
  });

  it('two peers join same room and both get capabilities', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws1 = await connect(port);
    const ws2 = await connect(port);

    const msg1Promise = waitForMessage(ws1);
    ws1.send(JSON.stringify({ type: 'join', roomId: 'room-5', peerId: 'peer-A' }));
    const msg1 = await msg1Promise;
    expect(msg1['type']).toBe('routerRtpCapabilities');

    const msg2Promise = waitForMessage(ws2);
    ws2.send(JSON.stringify({ type: 'join', roomId: 'room-5', peerId: 'peer-B' }));
    const msg2 = await msg2Promise;
    expect(msg2['type']).toBe('routerRtpCapabilities');

    ws1.close();
    ws2.close();
  });

  it('invalid JSON message does not crash the server', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // Send garbage
    ws.send('this is not json{{{');
    await tick();

    // Server should still accept new connections
    const ws2 = await connect(port);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws.close();
    ws2.close();
  });

  it('leave message removes peer from room', async () => {
    const { wss, port, getRoomCount } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-6', peerId: 'peer-6' }));
    await joinPromise;

    expect(getRoomCount()).toBe(1);

    // Send explicit leave
    ws.send(JSON.stringify({ type: 'leave' }));
    await tick(200);

    // Room should be cleaned up (only peer left)
    expect(getRoomCount()).toBe(0);

    ws.close();
  });
});
