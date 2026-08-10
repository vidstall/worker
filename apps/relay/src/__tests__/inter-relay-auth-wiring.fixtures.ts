/**
 * Shared mocks/helpers for the inter-relay-auth-wiring.test.ts split files.
 *
 * G3.2b — signaling-server inter-relay auth gate + cross-daemon link wiring.
 *
 * Mocked MediasoupManager (real mediasoup workers gated to the relay-integration
 * suite). Requirements: REQ-RO-004 (G1) · G3 (cross-daemon WS wiring + auth).
 */

import { vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { MetricsTracker } from '../metrics.js';
import { createSignalingServer, type InterRelayContext } from '../signaling/index.js';
import type { MediasoupManager } from '../mediasoup-manager.js';
import { INTER_RELAY_SUBPROTOCOL } from '@dvconf/inter-relay-client';

export function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockResolvedValue({
      id: 't', iceParameters: {}, iceCandidates: [], dtlsParameters: {},
      connect: vi.fn(),
      // REQ-RMS-037 (Task B4b): produce resolves a real Producer-shaped object so
      // handleProduce reaches the re-fan path (was `vi.fn()` → undefined → crash on
      // producer.id). VIDEO so the audio-observer arm is skipped (no observer mock).
      produce: vi.fn().mockResolvedValue({ id: 'producer-REAL-refan', kind: 'video', on: vi.fn(), close: vi.fn() }),
      consume: vi.fn(), setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined), close: vi.fn(),
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

/** Start a relay signaling server on port 0 with an optional INTER_RELAY_TOKEN. */
export function startServer(
  interRelay: InterRelayContext,
  token?: string,
): Promise<{ wss: WebSocketServer; port: number; factory: ReturnType<typeof createSignalingServer> }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    if (token === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = token;

    // REQ-RMS-037 (Task B4b): capture the FULL factory return so a test can drive
    // reannounceLocalProducersUp directly (additive — existing callers destructure
    // only { wss, port } and ignore the extra field).
    const factory = createSignalingServer(
      createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay,
    );
    const { wss } = factory;

    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;

    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, factory });
    });
  });
}

export function connectPlain(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

export function connectWithToken(port: number, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, INTER_RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * REQ-RMS-037 (Task B4b): connect as a TAGGED inter-relay peer carrying a DISTINCT
 * x-inter-relay-peer-id (the "attach a standby" path) so the primary buckets it
 * under `peerRelayId` and the re-fan-on-attach targets JUST this peer.
 */
export function connectInterRelay(port: number, token: string, peerRelayId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, INTER_RELAY_SUBPROTOCOL, {
      headers: { Authorization: `Bearer ${token}`, 'x-inter-relay-peer-id': peerRelayId },
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a message and await the next inbound message of `expectType`. */
export function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<any> {
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

export const tick = (ms = 120): Promise<unknown> => new Promise((r) => setTimeout(r, ms));
