/**
 * Shared fixtures for the rms-active-forward.integration.test.ts split files
 * (rms-active-forward-mint.integration.test.ts, rms-fan-mesh.integration.test.ts).
 *
 * REQ-RMS-025 — ACTIVE-forward integration (L1.2). See the split files' own
 * headers for the full narrative; this module holds only the shared codec
 * constants, RTP packet builder, real-producer helpers (parameterized by
 * router so each split file's module-scoped router can be threaded through),
 * and the L1.3-b mock signaling harness helpers.
 */

import { vi } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import { WebSocket, WebSocketServer } from 'ws';
import { createSignalingServer, type InterRelayContext } from '../../signaling/index.js';
import { MetricsTracker } from '../../metrics.js';
import type { MediasoupManager } from '../../mediasoup-manager.js';

// ── Shared codec set (mirrors mediasoup-manager.ts / warmpipe-rtp) ─────────

export const mediaCodecs: msTypes.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    preferredPayloadType: 100,
  },
];

export const OPUS_PT = 100;
export const OPUS_SSRC = 0x02468ace;
/** Constant Opus payload — its bytes ride the tail of every RTP packet. */
export const OPUS_PAYLOAD = Buffer.from([0xfc, 0xff, 0xfe]);

/** A minimal well-formed Opus RTP packet (12-byte header + constant payload). */
export function makeRtpPacket(seq: number, timestamp: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // version 2, no padding/ext/cc
  header[1] = OPUS_PT & 0x7f; // marker 0 + payload type
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(OPUS_SSRC >>> 0, 8);
  return Buffer.concat([header, OPUS_PAYLOAD]);
}

export const pipeProducerRtpParameters: msTypes.RtpParameters = {
  codecs: [
    {
      mimeType: 'audio/opus',
      payloadType: OPUS_PT,
      clockRate: 48000,
      channels: 2,
      parameters: {},
      rtcpFeedback: [],
    },
  ],
  encodings: [{ ssrc: OPUS_SSRC }],
};

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Synthetic real-RTP Opus producer on the given router (DirectTransport src). */
export async function makePrimaryRtpSource(primaryRouter: msTypes.Router): Promise<{
  producer: msTypes.Producer;
  start: () => void;
  stop: () => void;
}> {
  const directTransport = await primaryRouter.createDirectTransport();
  const producer = await directTransport.produce({
    kind: 'audio',
    rtpParameters: pipeProducerRtpParameters,
  });
  let seq = 0;
  let ts = 0;
  let interval: NodeJS.Timeout | null = null;
  return {
    producer,
    start: () => {
      interval = setInterval(() => {
        producer.send(makeRtpPacket(seq++, ts));
        ts += 960; // 20 ms @ 48 kHz
      }, 10);
    },
    stop: () => {
      if (interval !== null) clearInterval(interval);
    },
  };
}

/**
 * A second/third real Opus producer on the given router with a DISTINCT SSRC (so
 * two publishers can coexist on one router — the RtpListener rejects a duplicate
 * SSRC at produce() time). Used by 4d: like 4b, it asserts forwarding via
 * canConsume (deterministic) WITHOUT flowing RTP, so the producer never needs to
 * .send() — only a valid distinct SSRC.
 */
export async function makePrimaryProducerWithSsrc(
  primaryRouter: msTypes.Router,
  ssrc: number,
): Promise<msTypes.Producer> {
  const directTransport = await primaryRouter.createDirectTransport();
  return directTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [
        {
          mimeType: 'audio/opus',
          payloadType: OPUS_PT,
          clockRate: 48000,
          channels: 2,
          parameters: {},
          rtcpFeedback: [],
        },
      ],
      encodings: [{ ssrc }],
    },
  });
}

// ── L1.3-b harness helpers (a mock MediasoupManager so a REAL createSignalingServer
//    can run a live WS room in-process; mediasoup-FREE — the forwarded producer that
//    is FANNED is a REAL router-C producer minted above by produceLocalFromPipe). ──

export function mockRouter() {
  let n = 0;
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createWebRtcTransport: vi.fn().mockImplementation(async () => ({
      id: `transport-${++n}`,
      iceParameters: {},
      iceCandidates: [],
      dtlsParameters: {},
      connect: vi.fn().mockResolvedValue(undefined),
      produce: vi.fn(),
      consume: vi.fn(),
      setMaxIncomingBitrate: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    })),
    canConsume: vi.fn().mockReturnValue(true),
    close: vi.fn(),
  };
}
export function createMockManager(): MediasoupManager {
  const router = mockRouter();
  return {
    workers: [{ pid: 1 } as unknown as msTypes.Worker],
    getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
    createRouter: vi.fn().mockResolvedValue(router),
    close: vi.fn(),
  } as unknown as MediasoupManager;
}
export function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as never;
}
export function startSignaling(
  interRelay: InterRelayContext,
): Promise<{ wss: WebSocketServer; port: number; fanLocalProducer: unknown }> {
  return new Promise((resolve) => {
    const origPort = process.env['WS_PORT'];
    const origToken = process.env['INTER_RELAY_TOKEN'];
    process.env['WS_PORT'] = '0';
    delete process.env['INTER_RELAY_TOKEN']; // single-host bench: gate open
    const server = createSignalingServer(createMockManager(), new MetricsTracker(), mockLogger(), undefined, interRelay);
    process.env['WS_PORT'] = origPort;
    if (origToken === undefined) delete process.env['INTER_RELAY_TOKEN'];
    else process.env['INTER_RELAY_TOKEN'] = origToken;
    const { wss } = server;
    // L1.3-b — the NEW return field under test.
    const fanLocalProducer = (server as unknown as { fanLocalProducer?: unknown }).fanLocalProducer;
    wss.on('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ wss, port, fanLocalProducer });
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
export function sendAndAwait(ws: WebSocket, msg: Record<string, unknown>, expectType: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.RawData) => {
      const reply = JSON.parse(data.toString()) as Record<string, unknown>;
      if (reply['type'] === expectType) {
        ws.off('message', onMessage);
        resolve(reply);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
}
export const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
