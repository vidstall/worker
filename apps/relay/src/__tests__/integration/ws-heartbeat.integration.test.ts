/**
 * WS ping/pong liveness heartbeat (ghost-peer cleanup).
 *
 * The relay's client-facing signaling server only ever cleaned up a peer via
 * `ws.on('close', ...)`. A socket whose TCP connection dies without a clean
 * close handshake was never detected -- its peer/producers stayed in room
 * state forever as "ghost" producers, endlessly re-announced to every future
 * joiner (join-handler.ts) but never delivering real media. This adds a
 * standard `ws` ping/pong interval (signaling/index.ts) that `ws.terminate()`s
 * a socket that misses a pong, reusing the EXISTING close-based teardown path.
 *
 * Mirrors promoted-standby-blind-consume.test.ts's real-`ws`-server pattern
 * (createSignalingServer + WS_PORT=0 + real ws client sockets), with
 * WS_HEARTBEAT_INTERVAL_MS overridden very low for fast ticks.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../../metrics.js';
import { createSignalingServer } from '../../signaling/index.js';
import type { MediasoupManager } from '../../mediasoup-manager.js';

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-1', kind: 'video', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'video', rtpParameters: {}, close: vi.fn() }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockImplementation(async () => mockTransport('transport-1')),
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

/** Overrides WS_PORT (+ optional extra env) for the duration of server
 *  construction only, mirroring promoted-standby-blind-consume.test.ts. */
function startServer(extraEnv: Record<string, string> = {}): Promise<{
  wss: WebSocketServer;
  port: number;
  stopWsHeartbeat: () => void;
}> {
  return new Promise((resolve) => {
    const prior: Record<string, string | undefined> = { WS_PORT: process.env['WS_PORT'] };
    process.env['WS_PORT'] = '0';
    for (const [k, v] of Object.entries(extraEnv)) {
      prior[k] = process.env[k];
      process.env[k] = v;
    }
    const { wss, stopWsHeartbeat } = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(),
    );
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, stopWsHeartbeat });
    });
  });
}

function connect(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, headers ? { headers } : undefined);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
let stopHeartbeat: (() => void) | undefined;
afterEach(() => {
  stopHeartbeat?.();
  stopHeartbeat = undefined;
  if (server) { server.close(); server = undefined; }
});

describe('WS ping/pong liveness heartbeat', () => {
  it('terminates a socket that never gets a real ping sent (simulated silent death) and runs normal room teardown', async () => {
    const { wss, port, stopWsHeartbeat } = await startServer({ WS_HEARTBEAT_INTERVAL_MS: '40' });
    server = wss;
    stopHeartbeat = stopWsHeartbeat;

    const dying = await connect(port);
    dying.send(JSON.stringify({ type: 'join', roomId: 'hb-1', peerId: 'peer-dying' }));
    await tick(30);

    const survivor = await connect(port);
    const survivorMsgs: Record<string, unknown>[] = [];
    survivor.on('message', (d) => survivorMsgs.push(JSON.parse(d.toString())));
    survivor.send(JSON.stringify({ type: 'join', roomId: 'hb-1', peerId: 'peer-survivor' }));
    await tick(30);

    // Simulate a connection that silently died: stub the SERVER-side socket's
    // ping() so no real ping frame is ever sent -- the client-side automatic
    // pong-on-ping-receipt (built into `ws`) then has nothing to respond to,
    // deterministically reproducing "never gets a pong back" without racing
    // the underlying TCP/WS protocol's own error detection.
    // `wss.clients` is a Set, which preserves insertion order -- `dying`
    // connected first, so it's the first entry.
    const dyingServerWs = [...wss.clients][0]!;
    (dyingServerWs as unknown as { ping: () => void }).ping = () => {};

    // Two heartbeat ticks: first flips isAlive=false + (no-op) ping, second
    // finds isAlive still false and terminates.
    await tick(40 * 3);

    expect(dyingServerWs.readyState).toBe(WebSocket.CLOSED);
    // Normal close-path teardown ran: the survivor was told the dying peer left.
    const peerLeft = survivorMsgs.find((m) => m['type'] === 'peerLeft' && m['peerId'] === 'peer-dying');
    expect(peerLeft, 'ws.terminate() must reuse the existing close-based teardown (peerLeft broadcast)').toBeTruthy();

    dying.close();
    survivor.close();
  });

  it('does not terminate a healthy socket across multiple heartbeat ticks', async () => {
    const { wss, port, stopWsHeartbeat } = await startServer({ WS_HEARTBEAT_INTERVAL_MS: '40' });
    server = wss;
    stopHeartbeat = stopWsHeartbeat;

    const healthy = await connect(port);
    healthy.send(JSON.stringify({ type: 'join', roomId: 'hb-2', peerId: 'peer-healthy' }));
    await tick(30);

    // `ws` clients auto-respond to protocol-level ping frames with pong by
    // default -- no special handling needed for the healthy case.
    await tick(40 * 4);

    expect(healthy.readyState).toBe(WebSocket.OPEN);

    healthy.close();
  });

  it('stopWsHeartbeat() clears the interval so no further terminations happen', async () => {
    const { wss, port, stopWsHeartbeat } = await startServer({ WS_HEARTBEAT_INTERVAL_MS: '30' });
    server = wss;

    const ws = await connect(port);
    ws.send(JSON.stringify({ type: 'join', roomId: 'hb-3', peerId: 'peer-a' }));
    await tick(20);

    const serverWs = [...wss.clients][0]!;
    (serverWs as unknown as { ping: () => void }).ping = () => {}; // would-be-dying

    stopWsHeartbeat();
    stopHeartbeat = undefined; // already stopped, afterEach no-op is fine either way

    await tick(30 * 3);

    // Never terminated -- the interval was cleared before it could act.
    expect(serverWs.readyState).toBe(WebSocket.OPEN);

    ws.close();
  });

  it('exempts an inter-relay-tagged peer from ping/pong termination', async () => {
    const { wss, port, stopWsHeartbeat } = await startServer({
      WS_HEARTBEAT_INTERVAL_MS: '40',
      INTER_RELAY_TOKEN: 'test-token',
    });
    server = wss;
    stopHeartbeat = stopWsHeartbeat;

    const interRelayPeer = await connect(port, { Authorization: 'Bearer test-token' });
    await tick(20);

    const serverWs = [...wss.clients][0]!;
    (serverWs as unknown as { ping: () => void }).ping = () => {}; // would-be-dying, if not exempt

    await tick(40 * 3);

    expect(serverWs.readyState).toBe(WebSocket.OPEN);

    interRelayPeer.close();
  });

  it('terminates a pre-join socket (never sent join) on timeout without throwing', async () => {
    const { wss, port, stopWsHeartbeat } = await startServer({ WS_HEARTBEAT_INTERVAL_MS: '40' });
    server = wss;
    stopHeartbeat = stopWsHeartbeat;

    const preJoin = await connect(port); // never sends 'join'
    await tick(10);

    const serverWs = [...wss.clients][0]!;
    (serverWs as unknown as { ping: () => void }).ping = () => {};

    await tick(40 * 3);

    expect(serverWs.readyState).toBe(WebSocket.CLOSED);

    preJoin.close();
  });
});
