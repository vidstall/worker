/**
 * W5 M1 Phase 7 — receiver-transport BWE backstop cap (REQ-MCS-005).
 *
 * CONTRACTS.md C0 / C4 (FROZEN):
 *   `recvTransport.setMaxIncomingBitrate(cap)` is a SERVER-SIDE mediasoup call
 *   applied on the RECEIVE transport only (the consuming side), NOT on the send
 *   transport. The cap value comes from the `RELAY_MAX_INCOMING_BITRATE` env knob
 *   (placeholder pending the P9 bench; default ~4 Mbps). This is NOT a wire
 *   message — it is a relay-internal call that bounds aggregate downlink, preventing
 *   a client from requesting high simulcast layers for every tile and saturating its
 *   downlink.
 *
 * These tests drive the full WS protocol (join → createTransport(recv|send)) against
 * a MOCKED MediasoupManager (mirrors pause-resume-consumer.test.ts). The apply-logic
 * under test: `setMaxIncomingBitrate` is called exactly once on the recv transport
 * and NEVER on the send transport.
 *
 * Requirements: REQ-MCS-005
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types ───────────────────────────────────────────────────────

let lastTransport: ReturnType<typeof mockTransport> | undefined;
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
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'video', rtpParameters: {}, close: vi.fn() }),
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
      const t = mockTransport(`transport-${transportCounter}`);
      lastTransport = t;
      return t;
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function startServer(): Promise<{ wss: WebSocketServer; port: number }> {
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
      resolve({ wss, port });
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

const tick = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['RELAY_MAX_INCOMING_BITRATE'];
  lastTransport = undefined;
  transportCounter = 0;
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env['RELAY_MAX_INCOMING_BITRATE'];
  } else {
    process.env['RELAY_MAX_INCOMING_BITRATE'] = savedEnv;
  }
  if (server) {
    server.close();
    server = undefined;
  }
  lastTransport = undefined;
  transportCounter = 0;
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Relay recv-transport BWE backstop cap (REQ-MCS-005)', () => {
  it('calls setMaxIncomingBitrate on the recv transport with the env cap', async () => {
    process.env['RELAY_MAX_INCOMING_BITRATE'] = '5000000';

    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // join
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-bwe-1', peerId: 'peer-1' }));
    await joinReply;

    // createTransport(recv) — cap should be applied on THIS transport
    const recvReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    const recvMsg = await recvReply;
    expect(recvMsg['type']).toBe('transportCreated');

    await tick();

    expect(lastTransport).toBeDefined();
    expect(lastTransport!.setMaxIncomingBitrate).toHaveBeenCalledTimes(1);
    expect(lastTransport!.setMaxIncomingBitrate).toHaveBeenCalledWith(5_000_000);

    ws.close();
  });

  it('does NOT call setMaxIncomingBitrate on the send transport', async () => {
    process.env['RELAY_MAX_INCOMING_BITRATE'] = '4000000';

    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    // join
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-bwe-2', peerId: 'peer-2' }));
    await joinReply;

    // createTransport(send) — cap must NOT be applied
    const sendReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    const sendMsg = await sendReply;
    expect(sendMsg['type']).toBe('transportCreated');

    await tick();

    expect(lastTransport).toBeDefined();
    expect(lastTransport!.setMaxIncomingBitrate).not.toHaveBeenCalled();

    ws.close();
  });

  it('uses the default cap (~4 Mbps) when RELAY_MAX_INCOMING_BITRATE is unset', async () => {
    delete process.env['RELAY_MAX_INCOMING_BITRATE'];

    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-bwe-3', peerId: 'peer-3' }));
    await joinReply;

    const recvReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    const recvMsg = await recvReply;
    expect(recvMsg['type']).toBe('transportCreated');

    await tick();

    expect(lastTransport!.setMaxIncomingBitrate).toHaveBeenCalledTimes(1);
    // Default is 4_000_000 bps (PLACEHOLDER — bench-tuned at P9)
    expect(lastTransport!.setMaxIncomingBitrate).toHaveBeenCalledWith(4_000_000);

    ws.close();
  });

  it('skips setMaxIncomingBitrate gracefully when cap env is 0 (opt-out)', async () => {
    process.env['RELAY_MAX_INCOMING_BITRATE'] = '0';

    const { wss, port } = await startServer();
    server = wss;

    const ws = await connect(port);

    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-bwe-4', peerId: 'peer-4' }));
    await joinReply;

    const recvReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    const recvMsg = await recvReply;
    expect(recvMsg['type']).toBe('transportCreated');

    await tick();

    // cap=0 → opt-out → setMaxIncomingBitrate must NOT be called (don't pass 0 bps)
    expect(lastTransport!.setMaxIncomingBitrate).not.toHaveBeenCalled();

    ws.close();
  });
});
