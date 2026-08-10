/**
 * Shared mocks/helpers for the signaling.test.ts split files.
 *
 * Integration-style tests for the relay mediasoup signaling server. Starts a
 * real WebSocket server with a mocked MediasoupManager (mediasoup native
 * workers are unavailable on Windows CI).
 *
 * Requirements: RELAY-05
 */

import { vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types ────────────────────────────────────────────

export function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [{ foundation: '1', priority: 1, ip: '127.0.0.1', port: 10000, type: 'host', protocol: 'udp' }],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-1', kind: 'audio', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, close: vi.fn() }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

let transportCounter = 0;

/** Reset the module-private transport counter (call from the test file's beforeEach/inline). */
export function resetTransportCounter(): void {
  transportCounter = 0;
}

export function mockRouter() {
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

export function createMockManager(): MediasoupManager {
  const router = mockRouter();
  return {
    workers: [{ pid: 1 } as any],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

export function mockLogger() {
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
export function startServer(
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

// FIFO per-socket message queue: handleJoin (and other handlers) can send
// MULTIPLE messages back-to-back with no `await` between them (e.g.
// routerRtpCapabilities then roomMode). A one-shot `ws.once('message', ...)`
// registered AFTER awaiting the first message can lose the second message
// entirely if it was already emitted before the new listener re-attaches —
// `.once` does not buffer/queue events with no listener; they're just gone.
// A SINGLE persistent listener attached from connect() onward, buffering into
// a queue that waitForMessage drains from, makes message consumption order-
// and-timing-safe regardless of how many messages arrive before the next await.
const messageQueues = new WeakMap<WebSocket, Record<string, unknown>[]>();
const messageWaiters = new WeakMap<WebSocket, Array<(msg: Record<string, unknown>) => void>>();

/** Connect a raw WebSocket client to the server. */
export function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    messageQueues.set(ws, []);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as Record<string, unknown>;
      const waiters = messageWaiters.get(ws);
      const next = waiters?.shift();
      if (next) {
        next(msg);
      } else {
        messageQueues.get(ws)!.push(msg);
      }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Wait for the next JSON message on a WebSocket (FIFO — see messageQueues doc above). */
export function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  const queue = messageQueues.get(ws);
  const buffered = queue?.shift();
  if (buffered) return Promise.resolve(buffered);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    let waiters = messageWaiters.get(ws);
    if (!waiters) {
      waiters = [];
      messageWaiters.set(ws, waiters);
    }
    waiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
}

/** Small delay for async processing. */
export const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
