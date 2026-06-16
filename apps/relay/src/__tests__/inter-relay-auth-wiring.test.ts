/**
 * G3.2b — signaling-server inter-relay auth gate + cross-daemon link wiring.
 *
 * Verifies createSignalingServer with INTER_RELAY_TOKEN:
 *   1. DROPS a server-side `pipe-producer` from an UNTAGGED (client) socket when
 *      a token is configured (a client cannot poison the standby registry).
 *   2. RECORDS a `pipe-producer` from a TAGGED inter-relay peer (valid Bearer).
 *   3. token UNSET → untagged pipe-producer still recorded (backward-compat;
 *      single-host / in-process bench path unchanged).
 *   4. attachPeerSocket(socket) fires for a tagged peer; attachPeerSocket(null)
 *      on its close (single-box detach).
 *   5. onStandbyRoomReady(roomId, router) fires once on the standby first join.
 *   6. END-TO-END: a standby openInterRelayLink → primary announce → the frame
 *      crosses a REAL socket → the standby records it (the production loop).
 *
 * Mocked MediasoupManager (real mediasoup workers gated to the relay-integration
 * suite). Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS wiring + auth).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  createWsInterRelaySender,
  handleInboundInterRelayFrame,
  INTER_RELAY_SUBPROTOCOL,
  type InterRelaySocketLike,
} from '../inter-relay.js';
import { openInterRelayLink } from '../inter-relay-link.js';

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockResolvedValue({
      id: 't', iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      connect: vi.fn(), produce: vi.fn(), consume: vi.fn(), setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
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

/** Start a relay signaling server on port 0 with an optional INTER_RELAY_TOKEN. */
function startServer(
  interRelay: InterRelayContext,
  token?: string,
): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    if (token === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = token;

    const { wss } = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    );

    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;

    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port });
    });
  });
}

function connectPlain(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function connectWithToken(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, INTER_RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
});

describe('inter-relay auth gate (G3.2b)', () => {
  it('DROPS a pipe-producer from an untagged client when INTER_RELAY_TOKEN is set', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: vi.fn() };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port); // no Bearer header → untagged
    ws.send(JSON.stringify({ type: 'pipe-producer', roomId: 'r-drop', producerId: 'p', kind: 'audio' }));
    await tick();

    expect(registry.resolve('r-drop')).toBeNull(); // dropped, not recorded
    ws.close();
  });

  it('RECORDS a pipe-producer from a tagged inter-relay peer (valid Bearer)', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: vi.fn() };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectWithToken(port, 'relay-secret');
    ws.send(JSON.stringify({ type: 'pipe-producer', roomId: 'r-keep', producerId: 'p-real', kind: 'video' }));
    await tick();

    expect(registry.resolve('r-keep')?.producerId).toBe('p-real');
    ws.close();
  });

  it('records an untagged pipe-producer when INTER_RELAY_TOKEN is UNSET (backward-compat)', async () => {
    const registry = new InterRelayProducerRegistry();
    const interRelay: InterRelayContext = { role: 'standby', registry, announceProducer: vi.fn() };
    const { wss, port } = await startServer(interRelay, undefined); // token unset
    server = wss;

    const ws = await connectPlain(port);
    ws.send(JSON.stringify({ type: 'pipe-producer', roomId: 'r-compat', producerId: 'p-compat', kind: 'audio' }));
    await tick();

    expect(registry.resolve('r-compat')?.producerId).toBe('p-compat');
    ws.close();
  });

  it('calls attachPeerSocket with the accepted socket for a tagged peer, then null on close', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectWithToken(port, 'relay-secret');
    await tick();
    expect(attachPeerSocket).toHaveBeenCalledTimes(1);
    expect(attachPeerSocket.mock.calls[0]![0]).not.toBeNull();

    ws.close();
    await tick();
    // last call detaches (single-box)
    const lastArg = attachPeerSocket.mock.calls.at(-1)![0];
    expect(lastArg).toBeNull();
  });

  it('does NOT attach an untagged client as an inter-relay peer', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port); // a normal client
    await tick();
    expect(attachPeerSocket).not.toHaveBeenCalled();
    ws.close();
  });

  it('fires onStandbyRoomReady(roomId, router) once on the standby first peer join', async () => {
    const onStandbyRoomReady = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port);
    const reply = new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-S', peerId: 'peer-1' }));
    await reply;
    await tick();

    expect(onStandbyRoomReady).toHaveBeenCalledTimes(1);
    expect(onStandbyRoomReady.mock.calls[0]![0]).toBe('room-S');
    expect(onStandbyRoomReady.mock.calls[0]![1]).toBeDefined(); // the room router
    ws.close();
  });

  it('does NOT fire onStandbyRoomReady when this relay is primary', async () => {
    const onStandbyRoomReady = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws = await connectPlain(port);
    const reply = new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-P', peerId: 'peer-1' }));
    await reply;
    await tick();

    expect(onStandbyRoomReady).not.toHaveBeenCalled();
    ws.close();
  });

  it('fires onStandbyRoomReady ONCE across two joins to the SAME room (per-room)', async () => {
    const onStandbyRoomReady = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws1 = await connectPlain(port);
    const r1 = new Promise((r) => ws1.once('message', r));
    ws1.send(JSON.stringify({ type: 'join', roomId: 'room-twice', peerId: 'p1' }));
    await r1;

    const ws2 = await connectPlain(port);
    const r2 = new Promise((r) => ws2.once('message', r));
    ws2.send(JSON.stringify({ type: 'join', roomId: 'room-twice', peerId: 'p2' }));
    await r2;
    await tick();

    // Room created once (first join) → the warm pipe opens once, not per joiner.
    expect(onStandbyRoomReady).toHaveBeenCalledTimes(1);
    ws1.close();
    ws2.close();
  });

  it('a second tagged peer displaces the first; the first peer close does NOT detach the second', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;

    const ws1 = await connectWithToken(port, 'relay-secret');
    await tick();
    const ws2 = await connectWithToken(port, 'relay-secret');
    await tick();

    // Both tagged → attached; the latest call is the second (non-null) socket.
    expect(attachPeerSocket.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(attachPeerSocket.mock.calls.at(-1)![0]).not.toBeNull();

    // Close the FIRST peer → must NOT detach (the attached socket is ws2).
    const before = attachPeerSocket.mock.calls.length;
    ws1.close();
    await tick();
    const detachedAfterWs1 = attachPeerSocket.mock.calls.slice(before).some((c) => c[0] === null);
    expect(detachedAfterWs1).toBe(false);

    // Close the SECOND (attached) peer → detaches (single-box null).
    ws2.close();
    await tick();
    expect(attachPeerSocket.mock.calls.at(-1)![0]).toBeNull();
  });
});

describe('inter-relay cross-daemon link END-TO-END (G3.2b)', () => {
  it('standby openInterRelayLink → primary announce → standby registry records over a real socket', async () => {
    const TOKEN = 'e2e-secret';
    // PRIMARY: holds the accepted standby socket; its sender transmits over it.
    const primaryBox: { socket: InterRelaySocketLike | null } = { socket: null };
    const primarySender = createWsInterRelaySender(() => primaryBox.socket, mockLogger());
    const announceProducer = createInterRelayAnnouncer(primarySender);
    const primaryInterRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: (roomId, producer) => announceProducer(roomId, producer),
      attachPeerSocket: (s) => { primaryBox.socket = s; },
    };
    const { wss, port } = await startServer(primaryInterRelay, TOKEN);
    server = wss;

    // STANDBY: open the real outbound link + route inbound frames to the handler.
    const standbyRegistry = new InterRelayProducerRegistry();
    const onAnnounce = vi.fn();
    const link = openInterRelayLink({
      url: `ws://127.0.0.1:${port}`,
      token: TOKEN,
      onFrame: (raw) => handleInboundInterRelayFrame(raw, { registry: standbyRegistry, onAnnounce }),
      logger: mockLogger(),
    });
    await tick(200); // link open + primary attach

    // PRIMARY produces → announces the REAL producerId across the live socket.
    primaryInterRelay.announceProducer('room-E2E', { id: 'producer-REAL-e2e', kind: 'audio' });
    await tick(200);

    expect(standbyRegistry.resolve('room-E2E')?.producerId).toBe('producer-REAL-e2e');
    expect(onAnnounce).toHaveBeenCalledWith('room-E2E');

    link.close();
  });
});
