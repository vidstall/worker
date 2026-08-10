/**
 * Shared fixtures/mocks for the inter-relay-warmpipe.test.ts split files.
 *
 * BENCH-2 / G1 tests — wire the PRIMARY's REAL pipe-producer ID across the
 * inter-relay warm-pipe so the STANDBY consumes the real producer (replacing
 * the `pipe-producer-pending-<roomId>` placeholder).
 *
 * Mocks mediasoup Router / PipeTransport / Consumer with the same factory
 * pattern as relay-role-manager.test.ts.
 *
 * Requirements: REQ-RO-004 (G1 warm-pipe producerId wiring), REQ-RO-005 (paused).
 */

import { vi } from 'vitest';
import type { RoomTopology } from '@dvconf/inter-relay-client';

// ── mediasoup mock factories (mirror relay-role-manager.test.ts) ─────────

export function makeMockConsumer() {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused: false,
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

/** REQ-RMS-025 — a minted LOCAL producer (mock) the active-forward callback receives. */
export function makeMockProducer(id: string, kind: string) {
  return { id, kind, close: vi.fn() };
}

/** The shape produceLocalFromPipe passes to transport.produce. */
export type ProduceOpts = { id: string; kind: string };
/** Per-transport produce behaviour (default echoes a mock producer; tests inject throws). */
export type ProduceImpl = (opts: ProduceOpts) => Promise<unknown>;

export function makeMockPipeTransport(
  consumer: ReturnType<typeof makeMockConsumer>,
  produceImpl?: ProduceImpl,
) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    consume: vi.fn().mockResolvedValue(consumer),
    connect: vi.fn().mockResolvedValue(undefined),
    // REQ-RMS-025: produceLocalFromPipe calls transport.produce({id,kind,rtpParameters}).
    // Default echoes a mock producer (id+kind preserved); error tests inject a throw.
    produce: vi.fn(
      produceImpl ?? (async (opts: ProduceOpts) => makeMockProducer(opts.id, opts.kind)),
    ),
    tuple: { localIp: '127.0.0.1', localPort: 40000 },
    close: vi.fn(),
  };
}

/** A router whose createPipeTransport hands back a FRESH transport+consumer
 *  on every call (so a re-run consumes a distinct, real producer id). An optional
 *  produceImpl is applied to every created transport's produce (REQ-RMS-025 error tests). */
export function makeMockRouter(produceImpl?: ProduceImpl) {
  const consumers: ReturnType<typeof makeMockConsumer>[] = [];
  const transports: ReturnType<typeof makeMockPipeTransport>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const consumer = makeMockConsumer();
      const transport = makeMockPipeTransport(consumer, produceImpl);
      consumers.push(consumer);
      transports.push(transport);
      return transport;
    }),
    rtpCapabilities: {} as any,
  };
  return { router, consumers, transports };
}

/** Mock structured logger — asserts the debug-vs-warn split (REQ-RMS-025 Fix 1). */
export function makeMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
}

/** Minimal valid-ish RtpParameters for a recorded announce (REQ-RMS-026). */
export const rtpParams = (ssrc: number): any => ({
  codecs: [{ mimeType: 'video/VP8', payloadType: 101, clockRate: 90000, parameters: {}, rtcpFeedback: [] }],
  encodings: [{ ssrc }],
});

export function makeStandbyTopology(roomId = 'room-g1'): RoomTopology {
  return {
    roomId,
    role: 'standby',
    primaryEndpoint: 'ws://primary:4000',
    standbyEndpoint: 'ws://standby:4000',
    pipePort: 40000,
    pipeConsumer: null,
    pipeTransport: null,
  };
}
