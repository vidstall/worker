/**
 * W5 M2 P6 (REQ-MCS-013) — per-room E2EE mode property + signaling propagation.
 *
 * Contract (FROZEN, CONTRACTS.md §5 `RoomModeProperty` + the P6 wire-contract
 * freeze):
 *  - The host (first joiner) declares E2EE for the room via an explicit optional
 *    `msg.e2ee?: boolean` on its `join`. Stored on the per-room `RoomConfig`
 *    (NOT on-chain, D-M2-2). Later joiners INHERIT the host-set value — they
 *    cannot flip it.
 *  - On successful admission, the relay SENDS the joining ws a dedicated frame:
 *      { type:'roomMode', roomId, roomMode:{ e2ee, mode } }
 *    where `mode` ('SFU-E2EE' | 'MCU-floor') is the E2EE state machine value —
 *    DISTINCT from the relay forwarding `room.mode` ('sfu'|'mcu'). Mapping:
 *    e2ee && sfu → 'SFU-E2EE'; mcu → 'MCU-floor'.
 *  - A legacy / M1 join (no `roomPassword`, no `e2ee`) is unchanged: e2ee:false.
 *    Backward-compatible, like the password opt-in.
 *
 * Mirrors the integration-style harness in room-password-roster.test.ts (real WS
 * server, mocked MediasoupManager — mediasoup native workers unavailable on
 * Windows CI).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (copied from room-password-roster.test.ts harness) ──

function mockTransport(id: string) {
  return {
    id,
    iceParameters: { usernameFragment: 'ufrag', password: 'pwd', iceLite: true },
    iceCandidates: [],
    dtlsParameters: { fingerprints: [{ algorithm: 'sha-256', value: 'AA:BB' }], role: 'auto' },
    connect: vi.fn().mockResolvedValue(undefined),
    produce: vi.fn().mockResolvedValue({ id: 'producer-1', kind: 'audio', close: vi.fn() }),
    consume: vi.fn().mockResolvedValue({ id: 'consumer-1', kind: 'audio', rtpParameters: {}, close: vi.fn() }),
    setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

let transportCounter = 0;

function mockRouter() {
  return {
    rtpCapabilities: {
      codecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }],
      headerExtensions: [],
    },
    createWebRtcTransport: vi.fn().mockImplementation(async () => {
      transportCounter++;
      return mockTransport(`transport-${transportCounter}`);
    }),
    createAudioLevelObserver: vi.fn().mockResolvedValue({
      on: vi.fn(),
      addProducer: vi.fn().mockResolvedValue(undefined),
      removeProducer: vi.fn().mockResolvedValue(undefined),
    }),
    canConsume: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}

function createMockManager(): { manager: MediasoupManager; createRouterSpy: ReturnType<typeof vi.fn> } {
  const router = mockRouter();
  const createRouterSpy = vi.fn().mockResolvedValue(router);
  const manager = {
    workers: [{ pid: 1 } as unknown],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: createRouterSpy,
    close: vi.fn(),
  } as unknown as MediasoupManager;
  return { manager, createRouterSpy };
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
  } as never;
}

// ── Helpers ───────────────────────────────────────────────────────────

interface StartedServer {
  wss: WebSocketServer;
  port: number;
  getRoomCount: () => number;
  createRouterSpy: ReturnType<typeof vi.fn>;
}

function startServer(relayModeEnv?: 'sfu' | 'mcu'): Promise<StartedServer> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    const originalMode = process.env['RELAY_MODE'];
    process.env['WS_PORT'] = '0';
    if (relayModeEnv) process.env['RELAY_MODE'] = relayModeEnv;
    const { manager, createRouterSpy } = createMockManager();
    const metrics = new MetricsTracker();
    const logger = mockLogger();
    const { wss, getRoomCount } = createSignalingServer(manager, metrics, logger);
    process.env['WS_PORT'] = originalPort;
    if (originalMode === undefined) delete process.env['RELAY_MODE'];
    else process.env['RELAY_MODE'] = originalMode;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, getRoomCount, createRouterSpy });
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

/**
 * Collect EVERY frame received on `ws` until `predicate` matches one, then
 * resolve with the matching frame. The join reply sequence is
 * routerRtpCapabilities → (newProducer)* → (rosterPeer)* → roomMode, so a
 * single `waitForMessage` would race; this drains the stream.
 */
function waitForFrame(
  ws: WebSocket,
  predicate: (m: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Frame timeout')), timeoutMs);
    const onMsg = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
  });
}

/** Resolve with TRUE if a frame matching `predicate` arrives before `ms`. */
function frameArrives(
  ws: WebSocket,
  predicate: (m: Record<string, unknown>) => boolean,
  ms = 400,
): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(false);
    }, ms);
    const onMsg = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(true);
      }
    };
    ws.on('message', onMsg);
  });
}

/** Valid base64 of a 32-byte ed25519 session pubkey (deterministic per seed). */
function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

const isRoomMode = (m: Record<string, unknown>): boolean => m['type'] === 'roomMode';

let server: WebSocketServer | undefined;
afterEach(() => {
  if (server) {
    server.close();
    server = undefined;
  }
  transportCounter = 0;
});

describe('W5 M2 P6 (REQ-MCS-013) — per-room E2EE mode property over signaling', () => {
  it('an E2EE host join (e2ee:true, sfu) receives roomMode { e2ee:true, mode:"SFU-E2EE" }', async () => {
    const s = await startServer('sfu');
    server = s.wss;

    const ws = await connect(s.port);
    const roomModeFrame = waitForFrame(ws, isRoomMode);
    ws.send(
      JSON.stringify({
        type: 'join',
        roomId: 'e2ee-room-1',
        peerId: 'host',
        roomPassword: 'pw',
        peerPubkey: pubkey32(1),
        e2ee: true,
      }),
    );

    const frame = await roomModeFrame;
    expect(frame['type']).toBe('roomMode');
    expect(frame['roomId']).toBe('e2ee-room-1');
    expect(frame['roomMode']).toEqual({ e2ee: true, mode: 'SFU-E2EE' });

    ws.close();
  });

  it('a later joiner INHERITS the host-set e2ee flag (cannot flip it)', async () => {
    const s = await startServer('sfu');
    server = s.wss;

    // Host declares E2EE.
    const wsHost = await connect(s.port);
    const hostRoomMode = waitForFrame(wsHost, isRoomMode);
    wsHost.send(
      JSON.stringify({
        type: 'join',
        roomId: 'e2ee-room-2',
        peerId: 'host',
        roomPassword: 'pw',
        peerPubkey: pubkey32(1),
        e2ee: true,
      }),
    );
    await hostRoomMode;

    // Guest joins WITHOUT e2ee in its own message — it must still see e2ee:true
    // (the host-set value is authoritative; a later joiner cannot flip it off).
    const wsGuest = await connect(s.port);
    const guestRoomMode = waitForFrame(wsGuest, isRoomMode);
    wsGuest.send(
      JSON.stringify({
        type: 'join',
        roomId: 'e2ee-room-2',
        peerId: 'guest',
        roomPassword: 'pw',
        peerPubkey: pubkey32(2),
        // e2ee deliberately omitted
      }),
    );

    const frame = await guestRoomMode;
    expect(frame['roomMode']).toEqual({ e2ee: true, mode: 'SFU-E2EE' });

    wsHost.close();
    wsGuest.close();
  });

  it('a non-E2EE password room (roomPassword but no e2ee) reports e2ee:false', async () => {
    const s = await startServer('sfu');
    server = s.wss;

    const ws = await connect(s.port);
    const roomModeFrame = waitForFrame(ws, isRoomMode);
    ws.send(
      JSON.stringify({
        type: 'join',
        roomId: 'plain-room-1',
        peerId: 'host',
        roomPassword: 'pw',
        peerPubkey: pubkey32(1),
        // no e2ee → opt-out, e2ee:false (admission still password-gated)
      }),
    );

    const frame = await roomModeFrame;
    expect(frame['roomMode']).toEqual({ e2ee: false, mode: 'SFU-E2EE' });

    ws.close();
  });

  it('an MCU relay FORCES e2ee:false (server-mixing breaks SFrame — honesty invariant, D-M2-8)', async () => {
    const s = await startServer('mcu');
    server = s.wss;

    const ws = await connect(s.port);
    const roomModeFrame = waitForFrame(ws, isRoomMode);
    // Host asks for e2ee:true, but the relay forwarding mode is mcu. MCU
    // server-mixing (decode→re-encode) is incompatible with SFrame content-E2EE,
    // so the room mode MUST report e2ee:false (NOT a false "encrypted" badge).
    ws.send(
      JSON.stringify({
        type: 'join',
        roomId: 'mcu-room-1',
        peerId: 'host',
        roomPassword: 'pw',
        peerPubkey: pubkey32(1),
        e2ee: true,
      }),
    );

    const frame = await roomModeFrame;
    const rm = frame['roomMode'] as { e2ee: boolean; mode: string };
    expect(rm).toEqual({ e2ee: false, mode: 'MCU-floor' });

    ws.close();
  });

  it('a LEGACY join (no roomPassword, no e2ee) is unchanged: roomMode reports e2ee:false', async () => {
    const s = await startServer('sfu');
    server = s.wss;

    const ws = await connect(s.port);
    const roomModeFrame = waitForFrame(ws, isRoomMode);
    // Bare M1 join — no admission password, no e2ee.
    ws.send(JSON.stringify({ type: 'join', roomId: 'legacy-room-1', peerId: 'p1' }));

    const frame = await roomModeFrame;
    expect(frame['roomMode']).toEqual({ e2ee: false, mode: 'SFU-E2EE' });

    ws.close();
  });

  it('a legacy join STILL receives routerRtpCapabilities (M1 wire non-regression)', async () => {
    const s = await startServer('sfu');
    server = s.wss;

    const ws = await connect(s.port);
    const caps = frameArrives(ws, (m) => m['type'] === 'routerRtpCapabilities');
    ws.send(JSON.stringify({ type: 'join', roomId: 'legacy-room-2', peerId: 'p1' }));
    expect(await caps).toBe(true);

    ws.close();
  });
});
