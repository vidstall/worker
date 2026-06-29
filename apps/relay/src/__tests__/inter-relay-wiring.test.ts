/**
 * Integration-style tests for the inter-relay wiring in signaling.ts (G1).
 *
 * Verifies the relay WS server, when given an InterRelayContext:
 *   1. PRIMARY: announces a producer to the standby after handleProduce.
 *   2. STANDBY: records an inbound `pipe-producer` frame into the registry.
 *   3. STANDBY: a client `consume` WITHOUT producerId resolves the piped
 *      producer from room context (the announced producerId).
 *   4. Client-consume reconciliation: `{type:'consume', roomId, rtpCapabilities}`
 *      (no producerId) resolves via the registry; with producerId still works.
 *
 * Mocked MediasoupManager (mediasoup native workers unavailable on Windows CI).
 *
 * Requirements: REQ-RO-004 (G1 integration wiring)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';

// ── Mocks (mirror signaling.test.ts) ──────────────────────────────────

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-PRIMARY-1', kind: 'audio', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, close: vi.fn() }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

let transportCounter = 0;

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
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
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

function startServer(
  interRelay: InterRelayContext,
): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const { wss } = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    );
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

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

// ── Tests ─────────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
});

describe('inter-relay wiring (G1)', () => {
  beforeEach(() => { transportCounter = 0; });

  it('RED-G1-WIRE-1: PRIMARY announces a producer to the standby after produce', async () => {
    const announceProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-A', peerId: 'peer-1' }));
    await joinReply;

    // send transport
    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await tReply;

    // produce
    const pReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {},
    }));
    await pReply;
    await tick(120);

    // The primary must have announced the produced producer
    expect(announceProducer).toHaveBeenCalledOnce();
    const call = announceProducer.mock.calls[0]!;
    expect(call[0]).toBe('room-A');               // roomId
    expect(call[1]).toMatchObject({ id: 'producer-PRIMARY-1', kind: 'audio' });

    ws.close();
  });

  it('RED-RA-1: a STANDBY fires onStandbyProducer with the local publisher peerId after produce', async () => {
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'clientA' }));
    await joinReply;

    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await tReply;

    const pReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {},
    }));
    await pReply;
    await tick(120);

    // REQ-RMS-034: standby announces its LOCAL-client producer UP, threading the
    // ORIGINAL publisher peerId (mapping.peerId) for E2EE/stream fidelity.
    expect(onStandbyProducer).toHaveBeenCalledWith(
      'roomA',
      expect.anything(),
      expect.objectContaining({ id: 'producer-PRIMARY-1', kind: 'audio' }),
      'clientA',
    );

    ws.close();
  });

  it('RED-RA-1b: a PRIMARY does NOT fire onStandbyProducer (forward path byte-stable)', async () => {
    const onStandbyProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'roomA', peerId: 'clientP' }));
    await joinReply;

    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await tReply;

    const pReply = waitForMessage(ws);
    ws.send(JSON.stringify({
      type: 'produce', transportId: 'transport-1', kind: 'audio', rtpParameters: {},
    }));
    await pReply;
    await tick(120);

    // The reverse hop must fire ONLY on a standby; a primary keeps the forward leg.
    expect(onStandbyProducer).not.toHaveBeenCalled();

    ws.close();
  });

  it('RED-G1-WIRE-2: STANDBY records an inbound pipe-producer frame', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    // Inbound inter-relay announce (as if from the primary)
    ws.send(JSON.stringify({
      type: 'pipe-producer', roomId: 'room-B', producerId: 'producer-REAL-99', kind: 'video',
    }));
    await tick(120);

    const resolved = registry.resolve('room-B');
    expect(resolved?.producerId).toBe('producer-REAL-99');
    expect(resolved?.kind).toBe('video');

    ws.close();
  });

  // ── Part-3 reverse leg — PRIMARY receives a standby's reverse announce ─────
  it('RED-RA-3a: a PRIMARY receiving a pipe-producer frame fires onReverseAnnounce with the full announce', async () => {
    const onReverseAnnounce = vi.fn().mockResolvedValue(undefined);
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onReverseAnnounce,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port); // a peer that sends an inter-relay frame
    ws.send(JSON.stringify({
      type: 'pipe-producer',
      roomId: 'roomA',
      producerId: 'piped-up-1',
      kind: 'video',
      rtpParameters: { x: 1 },
      peerRelayId: 'ws://standbyA',
      producerPeerId: 'clientA',
    }));
    await tick();

    expect(onReverseAnnounce).toHaveBeenCalledWith(
      'roomA', 'piped-up-1', 'video', { x: 1 }, 'ws://standbyA', 'clientA',
    );

    ws.close();
  });

  it('RED-RA-3a-stable: a STANDBY receiving a pipe-producer frame does NOT fire onReverseAnnounce (records only; byte-stable)', async () => {
    const onReverseAnnounce = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onReverseAnnounce,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    ws.send(JSON.stringify({
      type: 'pipe-producer',
      roomId: 'roomA',
      producerId: 'p1',
      kind: 'video',
      producerPeerId: 'clientA',
    }));
    await tick();

    // standby records (existing) but never reverse-mints
    expect(onReverseAnnounce).not.toHaveBeenCalled();

    ws.close();
  });

  it('RED-G1-WIRE-3: STANDBY consume WITHOUT producerId resolves from room context', async () => {
    const registry = new InterRelayProducerRegistry();
    registry.record({ type: 'pipe-producer', roomId: 'room-C', producerId: 'producer-PIPED-7', kind: 'audio' });
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const joinReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-C', peerId: 'peer-2' }));
    await joinReply;

    // recv transport
    const tReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    await tReply;

    // consume WITHOUT producerId — standby resolves from room context (registry)
    const cReply = waitForMessage(ws);
    ws.send(JSON.stringify({ type: 'consume', rtpCapabilities: {} }));
    const msg = await cReply;

    // Should succeed (consumed), not error
    expect(msg['type']).toBe('consumed');

    ws.close();
  });

  // ── Stage B / G2 — fresh-join re-announce of forwarded producers ──────────
  it('RED-G2-WIRE-4: STANDBY re-announces forwarded (registry) producers to a FRESH joiner', async () => {
    const registry = new InterRelayProducerRegistry();
    // A forwarded/minted producer lives ONLY in the registry (it is produced by
    // the coordinator, NOT handleProduce, so it is never in room.peers[*].producers).
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-D',
      producerId: 'producer-FWD-42',
      kind: 'video',
      producerPeerId: 'publisher-X',
    });
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry,
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connect(port);
    const got: Record<string, unknown>[] = [];
    ws.on('message', (d) => got.push(JSON.parse(d.toString()) as Record<string, unknown>));

    // A FRESH browser HOMES to the standby and joins AFTER the producer was minted.
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-D', peerId: 'fresh-peer' }));
    await tick(150);

    const fwd = got.find(
      (m) => m['type'] === 'newProducer' && m['producerId'] === 'producer-FWD-42',
    );
    // RED today: handleJoin re-announce reads ONLY peer.producers (empty for a
    // forwarded producer), so the fresh joiner never learns the minted id.
    expect(
      fwd,
      'fresh joiner on a standby must receive newProducer for the forwarded producer',
    ).toBeTruthy();
    expect(fwd?.['kind']).toBe('video');
    expect(fwd?.['peerId']).toBe('publisher-X');

    ws.close();
  });
});
