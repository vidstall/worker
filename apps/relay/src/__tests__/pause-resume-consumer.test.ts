/**
 * W5 M1 Phase 6 — relay server-apply of `pauseConsumer` / `resumeConsumer` (REQ-MCS-004).
 *
 * CONTRACTS.md C2.2/C2.3 (FROZEN):
 *   { type:'pauseConsumer',  consumerId: string }  → consumer.pause()
 *   { type:'resumeConsumer', consumerId: string }  → consumer.resume()
 *
 * Wire contract: unknown consumerId → warn + ignore (mirrors P3 setConsumerLayers
 * unknown-id handling). Server effect: paused consumer forwards RTCP only (~0 media bytes).
 *
 * These tests drive the full WS protocol (join → createTransport(recv) → consume →
 * pauseConsumer / resumeConsumer) against a MOCKED MediasoupManager (mirrors
 * set-consumer-layers.test.ts — mediasoup native workers unavailable on Windows CI).
 * The real-mediasoup MECHANISM proof is in the P1 spike; this file proves the
 * APPLY-LOGIC dispatch: the WS request reaches the stored Consumer and calls
 * the right method.
 *
 * Requirements: REQ-MCS-004
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (mirror set-consumer-layers.test.ts) ─────────────────

/** A consumer mock with pause/resume spies — the calls under test. */
function mockConsumer(id: string) {
  return {
    id,
    kind: 'video',
    rtpParameters: {},
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    setPreferredLayers: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

let lastConsumer: ReturnType<typeof mockConsumer> | undefined;
let transportCounter = 0;

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [
      { foundation: '1', priority: 1, ip: '127.0.0.1', port: 10000, type: 'host', protocol: 'udp' },
    ],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-1', kind: 'video', close: vi.fn() }),
    consume: vi.fn().mockImplementation(async () => {
      lastConsumer = mockConsumer('consumer-1');
      return lastConsumer;
    }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function mockRouter() {
  return {
    rtpCapabilities: {
      codecs: [{ kind: 'video', mimeType: 'video/VP8', clockRate: 90000 }],
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

function startServer(): Promise<{
  wss: WebSocketServer;
  port: number;
  logger: ReturnType<typeof mockLogger>;
}> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';

    const mgr = createMockManager();
    const metrics = new MetricsTracker();
    const logger = mockLogger();

    const { wss } = createSignalingServer(mgr, metrics, logger);
    process.env['WS_PORT'] = originalPort;

    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, logger });
    });
  });
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Drive join → createTransport(recv) → consume so the peer has a stored Consumer. */
async function joinAndConsume(
  port: number,
  roomId: string,
  peerId: string,
): Promise<{ ws: WebSocket; consumerId: string }> {
  const ws = await connect(port);

  const joinReply = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'join', roomId, peerId }));
  await joinReply;

  const txReply = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
  await txReply;

  const consumeReply = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'consume', producerId: 'producer-X', rtpCapabilities: {} }));
  const consumed = await consumeReply;
  expect(consumed['type']).toBe('consumed');

  return { ws, consumerId: consumed['consumerId'] as string };
}

// ── Tests ───────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;

afterEach(() => {
  lastConsumer = undefined;
  transportCounter = 0;
  if (server) {
    server.close();
    server = undefined;
  }
});

describe('Relay pauseConsumer server-apply (REQ-MCS-004)', () => {
  it('looks up the stored Consumer by consumerId and calls pause()', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws, consumerId } = await joinAndConsume(port, 'room-pc-1', 'peer-1');
    expect(consumerId).toBe('consumer-1');
    expect(lastConsumer).toBeDefined();

    ws.send(JSON.stringify({ type: 'pauseConsumer', consumerId }));
    await tick(150);

    expect(lastConsumer!.pause).toHaveBeenCalledTimes(1);
    expect(lastConsumer!.resume).not.toHaveBeenCalled();

    ws.close();
  });

  it('unknown consumerId → warns and ignores (no pause(), no crash)', async () => {
    const { wss, port, logger } = await startServer();
    server = wss;

    const { ws } = await joinAndConsume(port, 'room-pc-2', 'peer-2');

    ws.send(JSON.stringify({ type: 'pauseConsumer', consumerId: 'does-not-exist' }));
    await tick(150);

    // The real (stored) consumer must NOT have had pause() called.
    expect(lastConsumer!.pause).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();

    // Server still alive — a fresh connection still works.
    const ws2 = await connect(port);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws.close();
    ws2.close();
  });
});

describe('Relay resumeConsumer server-apply (REQ-MCS-004)', () => {
  it('looks up the stored Consumer by consumerId and calls resume()', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws, consumerId } = await joinAndConsume(port, 'room-rc-1', 'peer-3');
    expect(consumerId).toBe('consumer-1');
    expect(lastConsumer).toBeDefined();

    ws.send(JSON.stringify({ type: 'resumeConsumer', consumerId }));
    await tick(150);

    expect(lastConsumer!.resume).toHaveBeenCalledTimes(1);
    expect(lastConsumer!.pause).not.toHaveBeenCalled();

    ws.close();
  });

  it('unknown consumerId → warns and ignores (no resume(), no crash)', async () => {
    const { wss, port, logger } = await startServer();
    server = wss;

    const { ws } = await joinAndConsume(port, 'room-rc-2', 'peer-4');

    ws.send(JSON.stringify({ type: 'resumeConsumer', consumerId: 'does-not-exist' }));
    await tick(150);

    // The real (stored) consumer must NOT have had resume() called.
    expect(lastConsumer!.resume).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();

    // Server still alive — a fresh connection still works.
    const ws2 = await connect(port);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws.close();
    ws2.close();
  });
});
