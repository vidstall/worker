/**
 * Regression: a relay can be PROMOTED to primary mid-session (cp-daemon
 * reassignment after the old primary dies) and then receive a REAL local
 * produce (handleProduce) from a peer reconnecting there. That producer lands
 * in room.peers[*].producers, NOT in the inter-relay pipe registry (which only
 * holds producers piped in FROM an upstream primary).
 *
 * The browser's standby-cutover fast path sends `{ type:'consume',
 * rtpCapabilities }` WITHOUT a producerId, trusting the relay to resolve it
 * from room context (G1 client-consume reconciliation, media-handler-consume.ts).
 * Before this fix, that resolution only checked the inter-relay registry, so a
 * promoted relay with a genuine local producer replied "not ready" forever —
 * even after the producer existed — because it never looked at room.peers.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-BOT-1', kind: 'video', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'video', rtpParameters: {}, close: vi.fn() }),
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

function startServer(interRelay: InterRelayContext): Promise<{ wss: WebSocketServer; port: number }> {
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

function collect(ws: WebSocket): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  ws.on('message', (d) => out.push(JSON.parse(d.toString()) as Record<string, unknown>));
  return out;
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) { server.close(); server = undefined; }
  transportCounter = 0;
});

describe('promoted-standby blind consume resolves a LOCALLY-produced room producer', () => {
  it('a fresh peer blind-consuming (no producerId) succeeds once ANOTHER peer has produced locally, even though the inter-relay registry has nothing for the room', async () => {
    // interRelay present with role 'standby' (matches the promoted-relay scenario) and
    // an EMPTY registry — no pipe announce ever arrived, because the producer below is
    // produced DIRECTLY on this relay, not piped in from an upstream primary.
    const interRelay: InterRelayContext = {
      role: 'standby',
      registry: new InterRelayProducerRegistry(),
      announceProducer: vi.fn(),
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    // The bot reconnects and produces directly on this (promoted) relay.
    const bot = await connect(port);
    const botJoin = waitForMessage(bot);
    bot.send(JSON.stringify({ type: 'join', roomId: 'promoted-1', peerId: 'bot-1' }));
    await botJoin;
    const botT = waitForMessage(bot);
    bot.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
    await botT;
    const botP = waitForMessage(bot);
    bot.send(JSON.stringify({ type: 'produce', transportId: 'transport-1', kind: 'video', rtpParameters: {} }));
    await botP;
    await tick(120);

    // The browser cuts over to this relay and blind-consumes (no producerId), exactly
    // like the standby-cutover fast path does.
    const client = await connect(port);
    const clientMsgs = collect(client);
    const clientJoin = waitForMessage(client);
    client.send(JSON.stringify({ type: 'join', roomId: 'promoted-1', peerId: 'guest-1' }));
    await clientJoin;
    const clientT = waitForMessage(client);
    client.send(JSON.stringify({ type: 'createTransport', direction: 'recv' }));
    await clientT;
    client.send(JSON.stringify({ type: 'consume', rtpCapabilities: {} }));
    await tick(150);

    const consumed = clientMsgs.find((m) => m['type'] === 'consumed');
    const notReady = clientMsgs.find(
      (m) => m['type'] === 'error' && m['message'] === 'No producer available for room yet',
    );
    expect(notReady, 'blind consume must NOT report "not ready" once a local producer exists').toBeUndefined();
    expect(consumed, 'blind consume must resolve the locally-produced room producer').toBeTruthy();
    expect(consumed?.['producerId']).toBe('producer-BOT-1');

    bot.close();
    client.close();
  });
});
