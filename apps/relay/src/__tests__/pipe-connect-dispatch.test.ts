/**
 * Dispatch tests for the inbound pipe-connect frame (REQ-RO-006 dispatch half).
 *
 * A pipe-connect frame arriving on the relay WS server must:
 *   1. route to InterRelayContext.onConnectParams(roomId, {ip,port,srtpParameters})
 *      when it passes the SAME interRelayPeers token gate that guards pipe-producer;
 *   2. be DROPPED (onConnectParams NOT called) from an untagged client when
 *      INTER_RELAY_TOKEN is set (a client cannot drive the primary's pipe);
 *   3. be recorded when the token is UNSET (single-host / bench back-compat);
 *   4. never throw on a malformed pipe-connect (the WS loop stays alive).
 *
 * Mirrors inter-relay-auth-wiring.test.ts harness (real createSignalingServer,
 * mocked MediasoupManager). Requirements: REQ-RO-006.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry, INTER_RELAY_SUBPROTOCOL } from '../inter-relay.js';

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockResolvedValue({
      id: 't', iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      connect: vi.fn(), produce: vi.fn(), consume: vi.fn(),
      setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
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
function startServer(interRelay: InterRelayContext, token?: string): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    if (token === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = token;
    const { wss } = createSignalingServer(createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay);
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
afterEach(() => { if (server) { server.close(); server = undefined; } });

describe('pipe-connect dispatch (REQ-RO-006)', () => {
  it('RED-PCD-1: routes a tagged pipe-connect to onConnectParams', async () => {
    const onConnectParams = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary', registry: new InterRelayProducerRegistry(), announceProducer: vi.fn(), onConnectParams,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;
    const ws = await connectWithToken(port, 'relay-secret');
    ws.send(JSON.stringify({ type: 'pipe-connect', roomId: 'r-go', ip: '127.0.0.1', port: 44020 }));
    await tick();
    expect(onConnectParams).toHaveBeenCalledOnce();
    expect(onConnectParams.mock.calls[0]![0]).toBe('r-go');
    expect(onConnectParams.mock.calls[0]![1]).toMatchObject({ ip: '127.0.0.1', port: 44020 });
    ws.close();
  });

  it('RED-PCD-2: DROPS a pipe-connect from an untagged client when the token is set', async () => {
    const onConnectParams = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary', registry: new InterRelayProducerRegistry(), announceProducer: vi.fn(), onConnectParams,
    };
    const { wss, port } = await startServer(interRelay, 'relay-secret');
    server = wss;
    const ws = await connectPlain(port); // no Bearer → untagged
    ws.send(JSON.stringify({ type: 'pipe-connect', roomId: 'r-drop', ip: '127.0.0.1', port: 1 }));
    await tick();
    expect(onConnectParams).not.toHaveBeenCalled();
    ws.close();
  });

  it('RED-PCD-3: routes an untagged pipe-connect when the token is UNSET (back-compat)', async () => {
    const onConnectParams = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary', registry: new InterRelayProducerRegistry(), announceProducer: vi.fn(), onConnectParams,
    };
    const { wss, port } = await startServer(interRelay, undefined);
    server = wss;
    const ws = await connectPlain(port);
    ws.send(JSON.stringify({ type: 'pipe-connect', roomId: 'r-compat', ip: '127.0.0.1', port: 9 }));
    await tick();
    expect(onConnectParams).toHaveBeenCalledOnce();
    expect(onConnectParams.mock.calls[0]![0]).toBe('r-compat');
    ws.close();
  });

  it('RED-PCD-4: a malformed pipe-connect does NOT throw / does NOT route', async () => {
    const onConnectParams = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary', registry: new InterRelayProducerRegistry(), announceProducer: vi.fn(), onConnectParams,
    };
    const { wss, port } = await startServer(interRelay, undefined);
    server = wss;
    const ws = await connectPlain(port);
    // type matches the dispatch case but the body is malformed (no ip/port)
    ws.send(JSON.stringify({ type: 'pipe-connect', roomId: 'r-bad' }));
    await tick();
    expect(onConnectParams).not.toHaveBeenCalled();
    // the socket is still alive (the server didn't crash the loop)
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
