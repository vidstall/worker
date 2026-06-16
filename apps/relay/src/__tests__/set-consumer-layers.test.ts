/**
 * W5 M1 Phase 3 — relay server-apply of `setConsumerLayers` (REQ-MCS-002).
 *
 * The load-bearing rule (CONTRACTS.md C0): `consumer.setPreferredLayers(...)` is
 * a SERVER-SIDE mediasoup call. The client NEVER calls it — it sends a
 * `setConsumerLayers` WS request and the relay looks up the stored Consumer on
 * the peer (`peer.consumers`, pushed in createConsumer at room-handler.ts:189) by
 * `consumerId` and calls `consumer.setPreferredLayers({ spatialLayer, temporalLayer })`.
 *
 * These tests drive the full WS protocol (join → createTransport(recv) → consume →
 * setConsumerLayers) against a MOCKED MediasoupManager (mirrors signaling.test.ts —
 * mediasoup native workers are unavailable on Windows CI). The real-mediasoup
 * MECHANISM proof (a low layer actually forwards fewer RTP bytes) is already
 * established by the P1 spike (simulcast-layer-bench-spike.integration.test.ts);
 * this file proves the APPLY-LOGIC dispatch: the WS request reaches the stored
 * Consumer and forwards the right layer args.
 *
 * Message shape (CONTRACTS.md C2.1, FROZEN):
 *   { type:'setConsumerLayers', consumerId, spatialLayer, temporalLayer }
 *   omit-semantics: temporalLayer absent → relay keeps current temporal (passes
 *   only { spatialLayer } to setPreferredLayers).
 *
 * Requirements: REQ-MCS-002
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (mirror signaling.test.ts) ─────────────────

/** A consumer mock with a setPreferredLayers spy — the call under test. */
function mockConsumer(id: string) {
  return {
    id,
    kind: 'video',
    rtpParameters: {},
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

describe('Relay setConsumerLayers server-apply (REQ-MCS-002)', () => {
  it('looks up the stored Consumer by consumerId and calls setPreferredLayers with both layers', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws, consumerId } = await joinAndConsume(port, 'room-scl-1', 'peer-1');
    expect(consumerId).toBe('consumer-1');
    expect(lastConsumer).toBeDefined();

    ws.send(
      JSON.stringify({
        type: 'setConsumerLayers',
        consumerId,
        spatialLayer: 2,
        temporalLayer: 1,
      }),
    );
    await tick(150);

    expect(lastConsumer!.setPreferredLayers).toHaveBeenCalledTimes(1);
    expect(lastConsumer!.setPreferredLayers).toHaveBeenCalledWith({
      spatialLayer: 2,
      temporalLayer: 1,
    });

    ws.close();
  });

  it('omit-semantics: temporalLayer absent → passes only spatialLayer (keeps current temporal)', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws, consumerId } = await joinAndConsume(port, 'room-scl-2', 'peer-2');

    ws.send(
      JSON.stringify({
        type: 'setConsumerLayers',
        consumerId,
        spatialLayer: 0,
        // temporalLayer omitted
      }),
    );
    await tick(150);

    expect(lastConsumer!.setPreferredLayers).toHaveBeenCalledTimes(1);
    expect(lastConsumer!.setPreferredLayers).toHaveBeenCalledWith({ spatialLayer: 0 });

    ws.close();
  });

  it('unknown consumerId → warns and ignores (no setPreferredLayers, no crash)', async () => {
    const { wss, port, logger } = await startServer();
    server = wss;

    const { ws } = await joinAndConsume(port, 'room-scl-3', 'peer-3');

    ws.send(
      JSON.stringify({
        type: 'setConsumerLayers',
        consumerId: 'does-not-exist',
        spatialLayer: 1,
        temporalLayer: 1,
      }),
    );
    await tick(150);

    // The real (stored) consumer must NOT have had setPreferredLayers called.
    expect(lastConsumer!.setPreferredLayers).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();

    // Server still alive — a fresh connection still works.
    const ws2 = await connect(port);
    expect(ws2.readyState).toBe(WebSocket.OPEN);

    ws.close();
    ws2.close();
  });
});
