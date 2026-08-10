/**
 * Shared mediasoup mock factories for the inter-relay-primary-coordinator.test.ts
 * split files.
 *
 * F1 / REQ-RO-001/002/008/009 — PrimaryPipeCoordinator unit tests.
 *
 * The PRIMARY half mirror of StandbyWarmPipeCoordinator: it mints + connect()s a
 * PipeTransport, pipes the room's real producer onto it, and announces the PIPED
 * consumer id (NOT producer.id). Tolerates either arrival order (producer vs the
 * standby's pipe-connect params) via per-room pending + re-drive. Mocks mediasoup
 * Router / PipeTransport / Consumer (same factory pattern as the warmpipe test).
 */
import { vi } from 'vitest';
import type { PipeConnectParams, PipePortAllocatorLike } from '@dvconf/inter-relay-client';

// ── mediasoup mock factories (mirror inter-relay-warmpipe.test.ts) ───────

/** The piped Consumer pipeProducerOntoPrimaryTransport returns — its .id is the
 *  PIPED id that must be ANNOUNCED (NOT the source producer.id). */
export function makePipedConsumer(id = `piped-${Math.random().toString(36).slice(2)}`) {
  return { id, kind: 'video' as const, close: vi.fn() };
}

/**
 * A mock PipeTransport whose `consume()` mints a FRESH piped Consumer per call —
 * exactly like real mediasoup (each `transport.consume()` returns a distinct
 * Consumer). Each minted consumer is recorded into the shared `pipedSink` so the
 * test can assert the announced ids are the PIPED ids, one per piped producer.
 * (The earlier single-`piped` shape could not represent two distinct consumers on
 * one mint-once transport — required by the multi-producer drain test RED-PPC-5.)
 */
export function makeMockPipeTransport(
  pipedSink: ReturnType<typeof makePipedConsumer>[],
  localPort = 41000,
) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    tuple: { localIp: '127.0.0.1', localPort },
    connect: vi.fn().mockResolvedValue(undefined),
    consume: vi.fn().mockImplementation(async () => {
      const c = makePipedConsumer();
      pipedSink.push(c);
      return c;
    }),
    close: vi.fn(),
  };
}

/** Router whose createPipeTransport hands back a FRESH transport each call. */
export function makeMockRouter() {
  const transports: ReturnType<typeof makeMockPipeTransport>[] = [];
  // One entry PER consume() call (a distinct piped Consumer each), shared with
  // every transport this router mints.
  const piped: ReturnType<typeof makePipedConsumer>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const t = makeMockPipeTransport(piped, 41000 + transports.length);
      transports.push(t);
      return t;
    }),
  };
  return { router, transports, piped };
}

/** A stub matching createPipePortAllocator's return (sibling cluster). */
export function makeStubAllocator(port = 41000): PipePortAllocatorLike & {
  allocate: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const held = new Set<string>();
  return {
    allocate: vi.fn((key: string) => { held.add(key); return port; }),
    release: vi.fn((key: string) => { held.delete(key); }),
    size: () => held.size,
  };
}

export function makeProducer(id = 'producer-REAL-source') {
  return { id, kind: 'video' as const };
}

export const STANDBY_PARAMS: PipeConnectParams = { ip: '127.0.0.1', port: 40000 };
