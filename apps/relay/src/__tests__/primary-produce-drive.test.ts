/**
 * Produce-drive test (CONSISTENCY-FIX HIGH#2, REQ-RO-001/002).
 *
 * The live `handleProduce` is the ONLY place a real producerId exists, so it is
 * the ONLY place the F1 primary-half can be DRIVEN in production. Before this
 * task the produce site called `interRelay.announceProducer(roomId, producer,
 * peerId)` directly (the OLD path that announces `producer.id`), so the
 * PrimaryPipeCoordinator (constructed in Task 21 / F5 and plugged in as
 * `onPrimaryProducer`) was never invoked in the live daemon — the primary pipe
 * was DEAD live (REQ-RO-001/002 not met).
 *
 * This test stands up a REAL `createSignalingServer` (mocked MediasoupManager)
 * with an `InterRelayContext` whose `onPrimaryProducer` is a spy, joins as a
 * peer, creates a send transport, and produces. It asserts the coordinator
 * (`onPrimaryProducer`) is driven at produce with `(roomId, room.router,
 * producer)` and that the OLD direct `announceProducer` is NOT the carrier of
 * `producer.id` (the coordinator's own announcer emits the PIPED id instead —
 * keeping both would double-announce).
 *
 * Mirrors pipe-connect-dispatch.test.ts harness (real createSignalingServer,
 * mocked MediasoupManager). Requirements: REQ-RO-001, REQ-RO-002.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { InterRelayProducerRegistry } from '@dvconf/inter-relay-client';
import {
  createInterRelaySocketMap,
  type InterRelaySocketMap,
} from '../inter-relay-socket-map.js';
import type { InterRelaySocketLike } from '@dvconf/inter-relay-client';

/**
 * A mock router whose createWebRtcTransport returns a transport whose `produce`
 * resolves a real Producer-shaped object (so handleProduce reaches the
 * inter-relay announce/coordinator-drive block). createAudioLevelObserver is
 * intentionally absent (attachAudioLevelObserver is best-effort / try-caught) and
 * the test produces VIDEO, so the audio-observer arm is skipped entirely.
 */
function mockRouter() {
  let n = 0;
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockImplementation(async () => ({
      id: `transport-${++n}`,
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
      connect: vi.fn().mockResolvedValue(undefined),
      produce: vi.fn().mockResolvedValue({
        id: 'producer-REAL-drive',
        kind: 'video',
        on: vi.fn(),
        close: vi.fn(),
      }),
      consume: vi.fn(),
      setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    })),
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
  sockets?: InterRelaySocketMap,
): Promise<{ wss: WebSocketServer; port: number }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    delete process.env['INTER_RELAY_TOKEN']; // bench / single-host: gate open
    // REQ-RMS-027/028 — optional 6th param injects a PRE-POPULATED inter-relay
    // socket map so the fanout loop in handleProduce can be unit-driven (the
    // tagged-peer WS upgrade that normally populates it is not exercised here).
    const { wss } = createSignalingServer(createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay, sockets);
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
const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** Send a message and await the next inbound message of `expectType`. */
function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<any> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const reply = JSON.parse(data.toString());
      if (reply.type === expectType) {
        ws.off('message', onMessage);
        resolve(reply);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}

let server: WebSocketServer | undefined;
afterEach(() => { if (server) { server.close(); server = undefined; } });

describe('primary produce drives the PrimaryPipeCoordinator (REQ-RO-001/002)', () => {
  it('drives onPrimaryProducer(roomId, router, producer) at produce — not the direct announceProducer', async () => {
    const onPrimaryProducer = vi.fn();
    const announceProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer,
      onPrimaryProducer,
    };
    const { wss, port } = await startServer(interRelay);
    server = wss;

    const ws = await connectPlain(port);
    await sendAndAwait(ws, { type: 'join', roomId: 'room-drive', peerId: 'peer-1' }, 'routerRtpCapabilities');
    const created = await sendAndAwait(
      ws,
      { type: 'createTransport', direction: 'send' },
      'transportCreated',
    );
    await sendAndAwait(
      ws,
      { type: 'produce', transportId: created.id, kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
      'produced',
    );
    await tick();

    // The coordinator IS driven at produce with (roomId, router, producer).
    expect(onPrimaryProducer).toHaveBeenCalledOnce();
    const [roomArg, routerArg, producerArg] = onPrimaryProducer.mock.calls[0]!;
    expect(typeof roomArg).toBe('string');
    expect(roomArg).toBe('room-drive');
    expect(routerArg).toBeDefined(); // the room's Router
    expect(producerArg.id).toBeDefined(); // the real Producer

    // The coordinator (not the old direct announce) is the carrier now.
    expect(announceProducer).not.toHaveBeenCalled();

    ws.close();
  });

  // REQ-RMS-028 (Bridge A, L1.3-b) — N-1 mesh fanout. With the per-peer inter-relay
  // socket map populated (≥2 cascade peers), a single produce must drive
  // onPrimaryProducer ONCE PER PEER, threading each peerRelayId — not a single
  // default-peer call. RED before the wiring: the fanout loop + the 6th
  // createSignalingServer param do not exist, so onPrimaryProducer fires ONCE.
  it('drives onPrimaryProducer ONCE PER cascade peer when the inter-relay socket map has ≥2 peers (REQ-RMS-028)', async () => {
    const onPrimaryProducer = vi.fn();
    const announceProducer = vi.fn();
    const interRelay: InterRelayContext = {
      role: 'primary',
      registry: new InterRelayProducerRegistry(),
      announceProducer,
      onPrimaryProducer,
    };
    const sockets = createInterRelaySocketMap();
    const stub = (): InterRelaySocketLike => ({ readyState: 1, send: () => {} });
    sockets.attach('relay-B', stub());
    sockets.attach('relay-C', stub());

    const { wss, port } = await startServer(interRelay, sockets);
    server = wss;

    const ws = await connectPlain(port);
    await sendAndAwait(ws, { type: 'join', roomId: 'room-mesh', peerId: 'peer-1' }, 'routerRtpCapabilities');
    const created = await sendAndAwait(
      ws,
      { type: 'createTransport', direction: 'send' },
      'transportCreated',
    );
    await sendAndAwait(
      ws,
      { type: 'produce', transportId: created.id, kind: 'video', rtpParameters: { codecs: [], headerExtensions: [] } },
      'produced',
    );
    await tick();

    // ONE produce → ONE onPrimaryProducer call per cascade peer (N-1 mesh legs).
    expect(onPrimaryProducer).toHaveBeenCalledTimes(2);
    const peers = onPrimaryProducer.mock.calls.map((c) => c[3] as string).sort();
    expect(peers).toEqual(['relay-B', 'relay-C']);
    // Each call still carries (roomId, router, producer) in the first 3 slots.
    for (const call of onPrimaryProducer.mock.calls) {
      expect(call[0]).toBe('room-mesh');
      expect(call[1]).toBeDefined();
      expect((call[2] as { id?: string }).id).toBeDefined();
    }

    ws.close();
  });
});
