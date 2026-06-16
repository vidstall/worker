/**
 * P17 M2b-P6 (DOH-021) — relay graceful-drain accessors on createSignalingServer.
 *
 * The F60 graceful shutdown (runGracefulShutdown, @dvconf/chain-event-listener)
 * needs two relay-side primitives, wired at P8:
 *   - setAccepting(false): refuse NEW client upgrades while draining, WITHOUT
 *     severing the G3.2b inter-relay warm-pipe (tagged peers stay exempt).
 *   - closeRooms(): force-close the remaining client peer sockets; the existing
 *     ws.on('close') → handleDisconnect path does the room teardown (no double-free).
 *
 * Mocked MediasoupManager (native workers gated to the integration suite).
 * Requirements: DOH-021.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import {
  createSignalingServer,
  type InterRelayContext,
} from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry } from '../inter-relay.js';
import { INTER_RELAY_SUBPROTOCOL } from '../inter-relay.js';

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockResolvedValue({
      id: 't', iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      connect: vi.fn(), produce: vi.fn(), consume: vi.fn(), close: vi.fn(),
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

/** Start the relay signaling server on port 0, returning the full accessor set. */
function startServer(
  interRelay?: InterRelayContext,
  token?: string,
): Promise<{
  wss: WebSocketServer;
  port: number;
  getRoomCount: () => number;
  setAccepting: (accepting: boolean) => void;
  closeRooms: () => void;
}> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    if (token === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = token;

    const api = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    );

    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;

    api.wss.on('listening', () => {
      const addr = api.wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ ...api, port });
    });
  });
}

/** Connect a plain client and resolve with the close code if the server closes it. */
function connectCapturingClose(port: number): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
    ws.on('open', () => resolve({ ws, closed }));
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

describe('relay graceful-drain accessors (DOH-021)', () => {
  it('accepts new client connections by default (setAccepting defaults true — non-regression)', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws } = await connectCapturingClose(port);
    await tick(60);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('setAccepting(false) refuses a NEW client connection with close code 1001', async () => {
    const { wss, port, setAccepting } = await startServer();
    server = wss;

    setAccepting(false);

    const { closed } = await connectCapturingClose(port);
    const code = await closed;
    expect(code).toBe(1001);
  });

  it('setAccepting(false) does NOT refuse an inter-relay tagged peer (warm-pipe exempt)', async () => {
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port, setAccepting } = await startServer(interRelay, 'relay-secret');
    server = wss;

    setAccepting(false);

    const ws = await connectWithToken(port, 'relay-secret');
    await tick();
    expect(ws.readyState).toBe(WebSocket.OPEN);     // not refused
    expect(attachPeerSocket).toHaveBeenCalledTimes(1); // attached as the announce socket
    ws.close();
  });

  it('setAccepting(true) re-enables accepting after a stop', async () => {
    const { wss, port, setAccepting } = await startServer();
    server = wss;

    setAccepting(false);
    setAccepting(true);

    const { ws } = await connectCapturingClose(port);
    await tick(60);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('closeRooms() force-closes client peers (1001) and drains their rooms', async () => {
    const { wss, port, getRoomCount, closeRooms } = await startServer();
    server = wss;

    const { ws, closed } = await connectCapturingClose(port);
    const joinReply = new Promise((r) => ws.once('message', r));
    ws.send(JSON.stringify({ type: 'join', roomId: 'room-drain', peerId: 'peer-1' }));
    await joinReply;
    expect(getRoomCount()).toBe(1);

    closeRooms();

    const code = await closed;
    expect(code).toBe(1001);
    await tick(200);
    expect(getRoomCount()).toBe(0); // existing ws.on('close') → handleDisconnect drained it
  }, 15000); // real-socket join+close+tick; guard against a cold-run timeout flake

  it('closeRooms() does NOT close the inter-relay warm-pipe peer (only client rooms)', async () => {
    // Structural exemption: inter-relay peers are never inserted into wsToRoom
    // (they announce, never `join`), so closeRooms — which iterates wsToRoom —
    // must leave the standby's warm-pipe link OPEN while it drains client rooms.
    const attachPeerSocket = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
      attachPeerSocket,
    };
    const { wss, port, getRoomCount, closeRooms } = await startServer(interRelay, 'relay-secret');
    server = wss;

    // A tagged inter-relay peer (attached, NOT in wsToRoom)…
    const interPeer = await connectWithToken(port, 'relay-secret');
    await tick();
    expect(attachPeerSocket).toHaveBeenCalledTimes(1);

    // …and a real client that joins a room (lands in wsToRoom).
    const { ws: client } = await connectCapturingClose(port);
    const joinReply = new Promise((r) => client.once('message', r));
    client.send(JSON.stringify({ type: 'join', roomId: 'room-mixed', peerId: 'peer-1' }));
    await joinReply;
    expect(getRoomCount()).toBe(1);

    closeRooms();
    await tick(200);

    expect(getRoomCount()).toBe(0);                       // client room drained
    expect(interPeer.readyState).toBe(WebSocket.OPEN);    // warm-pipe peer untouched
    // closeRooms never closed the inter-relay socket → no detach fired.
    const detached = attachPeerSocket.mock.calls.slice(1).some((c) => c[0] === null);
    expect(detached).toBe(false);

    interPeer.close();
  }, 15000);
});
