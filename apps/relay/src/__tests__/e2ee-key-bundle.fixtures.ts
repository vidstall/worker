/**
 * Shared mocks/helpers for e2ee-key-bundle.test.ts.
 *
 * W5 M2 P4 (REQ-MCS-012, transport half) — BLIND signaling broadcast of the
 * sealed `e2eeKeyBundle`. Mirrors the integration-style harness in
 * room-password-roster.test.ts (real WS server, mocked MediasoupManager —
 * mediasoup native workers unavailable on Windows CI).
 */

import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

// ── Mock mediasoup types (copied from room-password-roster.test.ts harness) ──

export function mockTransport(id: string) {
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

/** Reset the module-private transport counter (call from the test file's afterEach). */
export function resetTransportCounter(): void {
  transportCounter = 0;
}

export function mockRouter() {
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

export function createMockManager(): { manager: MediasoupManager } {
  const router = mockRouter();
  const manager = {
    workers: [{ pid: 1 } as unknown],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
  return { manager };
}

/** A logger whose calls are captured so test (d) can scan every arg for leaks. */
export function captureLogger() {
  const calls: Array<{ level: string; args: unknown[] }> = [];
  const mk = (level: string) => (...args: unknown[]) => {
    calls.push({ level, args });
  };
  const logger = {
    info: vi.fn(mk('info')),
    warn: vi.fn(mk('warn')),
    error: vi.fn(mk('error')),
    debug: vi.fn(mk('debug')),
    fatal: vi.fn(mk('fatal')),
    trace: vi.fn(mk('trace')),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as never;
  return { logger, calls };
}

// ── Helpers ───────────────────────────────────────────────────────────

export interface StartedServer {
  wss: WebSocketServer;
  port: number;
  getRoomCount: () => number;
  calls: Array<{ level: string; args: unknown[] }>;
}

export function startServer(): Promise<StartedServer> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const { manager } = createMockManager();
    const metrics = new MetricsTracker();
    const { logger, calls } = captureLogger();
    const { wss, getRoomCount } = createSignalingServer(manager, metrics, logger);
    process.env['WS_PORT'] = originalPort;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, getRoomCount, calls });
    });
  });
}

export function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

export function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Message timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

/**
 * Wait for the NEXT message of a specific `type` (skips earlier frames such as
 * routerRtpCapabilities / rosterPeer / newProducer that the join path emits).
 */
export function waitForType(
  ws: WebSocket,
  type: string,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        ws.off('message', onMsg);
        reject(new Error(`Timeout waiting for ${type}`));
      },
      timeoutMs,
    );
    const onMsg = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
  });
}

/**
 * Resolve to the first frame of `type` within `windowMs`, or `null` if none
 * arrives — used to assert a frame is NOT delivered (no echo / no cross-room).
 */
export function expectNoType(ws: WebSocket, type: string, windowMs = 400): Promise<null | Record<string, unknown>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      resolve(null);
    }, windowMs);
    const onMsg = (data: WebSocket.RawData) => {
      const m = JSON.parse(data.toString()) as Record<string, unknown>;
      if (m['type'] === type) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    };
    ws.on('message', onMsg);
  });
}

export const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/** Valid base64 of a 32-byte ed25519 session pubkey (deterministic per seed). */
export function pubkey32(seed: number): string {
  return createHash('sha256').update(`seed-${seed}`).digest('base64');
}

/** Valid base64 of a deterministic 48-byte opaque sealed key (per seed). */
export function sealed(seed: number): string {
  return Buffer.concat([
    createHash('sha256').update(`sealed-a-${seed}`).digest(),
    createHash('sha256').update(`sealed-b-${seed}`).digest(),
  ])
    .subarray(0, 48)
    .toString('base64');
}

/** Join a peer (E2EE/admission path) and await its routerRtpCapabilities. */
export async function joinPeer(
  port: number,
  roomId: string,
  peerId: string,
  pwd: string,
  keySeed: number,
): Promise<WebSocket> {
  const ws = await connect(port);
  const reply = waitForType(ws, 'routerRtpCapabilities');
  ws.send(
    JSON.stringify({ type: 'join', roomId, peerId, roomPassword: pwd, peerPubkey: pubkey32(keySeed) }),
  );
  await reply;
  return ws;
}
