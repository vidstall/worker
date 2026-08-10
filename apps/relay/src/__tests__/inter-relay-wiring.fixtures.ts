/**
 * Shared mocks/helpers for inter-relay-wiring.test.ts (G1).
 *
 * Mocked MediasoupManager (mediasoup native workers unavailable on Windows CI).
 *
 * Requirements: REQ-RO-004 (G1 integration wiring)
 */

import { vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import type { InterRelaySocketMap } from '../inter-relay-socket-map.js';
import type { types as msTypes } from 'mediasoup';

// ── Mocks (mirror signaling.test.ts) ──────────────────────────────────

export function mockTransport(id: string) {
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

/** Reset the shared transport-id counter (call from a test file's beforeEach). */
export function resetTransportCounter(): void {
  transportCounter = 0;
}

export function mockRouter() {
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

export function createMockManager(): MediasoupManager {
  const router = mockRouter();
  return {
    workers: [{ pid: 1 } as any],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}

export function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

export function startServer(
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

// REQ-RMS-034 (A4) — capture the factory's reverse-leg exports (getRoom +
// registerReverseMinted) that the wiring layer (index.ts) assigns onto the
// signalingRef box. The base startServer drops them; this variant returns them so
// the unit can assert the signaling.ts surface A4 adds.
//
// COVERAGE (corrected A6): the index.ts onReverseAnnounce ORCHESTRATION closure
// (getRoom guard + ensureReverseLeg-before-reverseMint ordering + the truthy-mint
// registerReverseMinted call) is unit-covered by reverse-announce-handler.test.ts,
// which runs the REAL extracted handler (makeOnReverseAnnounce) against a mock
// PrimaryPipeCoordinator. A5 (rms-reverse-leg.integration.test.ts) covers
// reverseMint -> produceLocalFromPipe + REQ-RMS-026 SSRC remap + byte-identity over
// REAL mediasoup ONLY -- it calls the coordinators directly and consumes via a raw
// DirectTransport sink, so it does NOT run the index.ts closure. The
// registerReverseMinted -> fanLocalProducer client fan is covered by RED-RA-4 below.
export function startServerFull(
  interRelay: InterRelayContext,
  providedSockets?: InterRelaySocketMap,
): Promise<{
  wss: WebSocketServer;
  port: number;
  getRoom: (roomId: string) => unknown;
  registerReverseMinted: (
    roomId: string,
    minted: msTypes.Producer,
    originRelayId: string,
    producerPeerId?: string,
  ) => void;
}> {
  return new Promise((resolve) => {
    const originalPort = process.env['WS_PORT'];
    process.env['WS_PORT'] = '0';
    const srv = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay, providedSockets,
    ) as unknown as {
      wss: WebSocketServer;
      getRoom: (roomId: string) => unknown;
      registerReverseMinted: (
        roomId: string,
        minted: msTypes.Producer,
        originRelayId: string,
        producerPeerId?: string,
      ) => void;
    };
    process.env['WS_PORT'] = originalPort;
    srv.wss.on('listening', () => {
      const addr = srv.wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        wss: srv.wss,
        port,
        getRoom: srv.getRoom,
        registerReverseMinted: srv.registerReverseMinted,
      });
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

export const tick = (ms = 80): Promise<unknown> => new Promise((r) => setTimeout(r, ms));
