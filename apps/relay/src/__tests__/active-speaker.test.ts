/**
 * W5 M1 Phase 5 (relay half) — active-speaker via AudioLevelObserver (REQ-MCS-003).
 *
 * Authority split (CONTRACTS.md C0/C2.4): who-is-speaking is the RELAY's truth.
 * One `AudioLevelObserver` per router (maxEntries:1, ~800ms interval, −60dB
 * threshold, all from env) is attached at room creation. Its `volumes` event
 * yields the dominant audio `producerId`; the relay maps producerId → peerId
 * (via room.peers[].producers) and BROADCASTS `{ type:'activeSpeaker', peerId }`
 * to ALL peers in the room on the existing room fan-out idiom
 * (room-handler.ts notifyNewProducer loop).
 *
 * The relay only REPORTS the speaker — it does NOT raise anyone's layer. The
 * client reacts to `activeSpeaker` with setConsumerLayers(:2) (P5-client scope).
 *
 * These tests drive the WS protocol against a MOCKED MediasoupManager (mirrors
 * set-consumer-layers.test.ts / signaling.test.ts — native mediasoup workers are
 * unavailable on Windows CI). The captured `volumes` handler is invoked directly
 * to prove the detect → map → broadcast logic.
 *
 * Message shape (CONTRACTS.md C2.4, FROZEN):
 *   { type:'activeSpeaker', peerId }
 *
 * Requirements: REQ-MCS-003
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (mirror set-consumer-layers.test.ts) ────────

type VolumesHandler = (volumes: Array<{ producer: { id: string }; volume: number }>) => void;
type SilenceHandler = () => void;

/** Captures the volumes/silence handlers + addProducer/removeProducer spies. */
function mockAudioLevelObserver() {
  const handlers: { volumes?: VolumesHandler; silence?: SilenceHandler } = {};
  return {
    handlers,
    addProducer: vi.fn().mockResolvedValue(undefined),
    removeProducer: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, cb: VolumesHandler | SilenceHandler) => {
      if (event === 'volumes') handlers.volumes = cb as VolumesHandler;
      if (event === 'silence') handlers.silence = cb as SilenceHandler;
    }),
    close: vi.fn(),
  };
}

let lastObserver: ReturnType<typeof mockAudioLevelObserver> | undefined;
let transportCounter = 0;

function mockProducer(id: string, kind: 'audio' | 'video') {
  return { id, kind, close: vi.fn() };
}

function mockTransport(id: string, produceKind: 'audio' | 'video') {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [
      { foundation: '1', priority: 1, ip: '127.0.0.1', port: 10000, type: 'host', protocol: 'udp' },
    ],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockImplementation(async () => mockProducer(`producer-${id}`, produceKind)),
    consume: vi.fn().mockResolvedValue({
      id: 'consumer-1',
      kind: 'video',
      rtpParameters: {},
      setPreferredLayers: vi.fn(),
      close: vi.fn(),
    }),
    close: vi.fn(),
  };
}

function mockRouter() {
  return {
    rtpCapabilities: {
      codecs: [
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
      ],
      headerExtensions: [],
    },
    createWebRtcTransport: vi.fn().mockImplementation(async () => {
      transportCounter++;
      // Odd transports = audio producers (so produce() yields an audio producer).
      const kind = transportCounter % 2 === 1 ? 'audio' : 'video';
      return mockTransport(`t${transportCounter}`, kind);
    }),
    createAudioLevelObserver: vi.fn().mockImplementation(async () => {
      lastObserver = mockAudioLevelObserver();
      return lastObserver;
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

function startServer(): Promise<{ wss: WebSocketServer; port: number; logger: ReturnType<typeof mockLogger> }> {
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

/** Collect every message a ws receives until quiesce (no message for quietMs). */
function collectMessages(ws: WebSocket): { received: Record<string, unknown>[] } {
  const received: Record<string, unknown>[] = [];
  ws.on('message', (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  return { received };
}

const tick = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Drive join → createTransport(send) → produce(audio) so the peer has an audio producer. */
async function joinAndProduceAudio(
  port: number,
  roomId: string,
  peerId: string,
): Promise<{ ws: WebSocket; producerId: string }> {
  const ws = await connect(port);
  const joinReply = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'join', roomId, peerId }));
  await joinReply;

  const txReply = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'createTransport', direction: 'send' }));
  await txReply;

  const producedReply = waitForMessage(ws);
  ws.send(JSON.stringify({ type: 'produce', kind: 'audio', rtpParameters: {} }));
  const produced = await producedReply;
  expect(produced['type']).toBe('produced');

  return { ws, producerId: produced['producerId'] as string };
}

// ── Tests ───────────────────────────────────────────────────────────

let server: WebSocketServer | undefined;

afterEach(() => {
  lastObserver = undefined;
  transportCounter = 0;
  if (server) {
    server.close();
    server = undefined;
  }
});

describe('Relay active-speaker via AudioLevelObserver (REQ-MCS-003)', () => {
  it('creates one AudioLevelObserver per router at room creation and registers a volumes handler', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws } = await joinAndProduceAudio(port, 'room-as-1', 'peer-1');
    await tick();

    expect(lastObserver).toBeDefined();
    expect(typeof lastObserver!.handlers.volumes).toBe('function');

    ws.close();
  });

  it('addProducer is called for an AUDIO producer (and the observer exists)', async () => {
    const { wss, port } = await startServer();
    server = wss;

    const { ws } = await joinAndProduceAudio(port, 'room-as-2', 'peer-1');
    await tick();

    expect(lastObserver!.addProducer).toHaveBeenCalled();
    const call = lastObserver!.addProducer.mock.calls[0]![0] as { producerId: string };
    expect(call.producerId).toMatch(/^producer-/);

    ws.close();
  });

  it('a volumes event maps the dominant producerId → peerId and broadcasts activeSpeaker to ALL room peers', async () => {
    const { wss, port } = await startServer();
    server = wss;

    // Speaker peer produces audio.
    const { ws: speakerWs, producerId } = await joinAndProduceAudio(port, 'room-as-3', 'speaker');
    const speakerInbox = collectMessages(speakerWs);

    // A second listener peer (no producer) — must also receive the broadcast.
    const listenerWs = await connect(port);
    const listenerJoin = waitForMessage(listenerWs);
    listenerWs.send(JSON.stringify({ type: 'join', roomId: 'room-as-3', peerId: 'listener' }));
    await listenerJoin;
    const listenerInbox = collectMessages(listenerWs);

    await tick();
    expect(lastObserver!.handlers.volumes).toBeDefined();

    // Fire the dominant-speaker volumes event with the speaker's producerId.
    lastObserver!.handlers.volumes!([{ producer: { id: producerId }, volume: -30 }]);
    await tick();

    const speakerMsg = speakerInbox.received.find((m) => m['type'] === 'activeSpeaker');
    const listenerMsg = listenerInbox.received.find((m) => m['type'] === 'activeSpeaker');
    expect(speakerMsg).toBeDefined();
    expect(listenerMsg).toBeDefined();
    expect(speakerMsg!['peerId']).toBe('speaker');
    expect(listenerMsg!['peerId']).toBe('speaker');

    speakerWs.close();
    listenerWs.close();
  });

  it('volumes for an unmappable producerId → no broadcast, no crash', async () => {
    const { wss, port, logger } = await startServer();
    server = wss;

    const { ws } = await joinAndProduceAudio(port, 'room-as-4', 'peer-1');
    const inbox = collectMessages(ws);
    await tick();

    lastObserver!.handlers.volumes!([{ producer: { id: 'producer-ghost' }, volume: -10 }]);
    await tick();

    expect(inbox.received.find((m) => m['type'] === 'activeSpeaker')).toBeUndefined();
    // Server still alive.
    const ws2 = await connect(port);
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    void logger;

    ws.close();
    ws2.close();
  });
});
