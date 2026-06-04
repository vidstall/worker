/**
 * BENCH-2 / G1 tests — wire the PRIMARY's REAL pipe-producer ID across the
 * inter-relay warm-pipe so the STANDBY consumes the real producer (replacing
 * the `pipe-producer-pending-<roomId>` placeholder).
 *
 * Covers the two gaps the bench needs closed:
 *
 *   A. STANDBY warm-pipe orchestration (StandbyWarmPipeCoordinator):
 *      - registry HAS the primary's producerId  → ensureWarmPipe is called with
 *        that REAL id (not the placeholder).
 *      - NOT-READY path: registry returns null  → placeholder used + a later
 *        announce triggers a RE-RUN that resets topology.pipeConsumer and
 *        re-consumes with the real id (the L143-146 not-ready re-run contract).
 *      - REQ-RO-005 paused invariant preserved on both the placeholder consume
 *        and the real re-run consume.
 *
 *   B. PRIMARY announce link actually TRANSMITS (createWsInterRelaySender):
 *      - the sink wired in index.ts must put bytes on the wire when a live
 *        socket is attached (the prior index.ts sink was a no-op log stub —
 *        the announce never left the process). Best-effort: no socket / a
 *        throwing socket must not crash the produce path.
 *
 * Mocks mediasoup Router / PipeTransport / Consumer with the same factory
 * pattern as relay-role-manager.test.ts.
 *
 * Requirements: REQ-RO-004 (G1 warm-pipe producerId wiring), REQ-RO-005 (paused).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  InterRelayProducerRegistry,
  StandbyWarmPipeCoordinator,
  createWsInterRelaySender,
  createInterRelayAnnouncer,
} from '../inter-relay.js';
import type { RoomTopology } from '../relay-role-manager.js';

// ── mediasoup mock factories (mirror relay-role-manager.test.ts) ─────────

function makeMockConsumer() {
  return {
    id: `consumer-${Math.random().toString(36).slice(2)}`,
    paused: false,
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function makeMockPipeTransport(consumer: ReturnType<typeof makeMockConsumer>) {
  return {
    id: `pipe-transport-${Math.random().toString(36).slice(2)}`,
    consume: vi.fn().mockResolvedValue(consumer),
    connect: vi.fn().mockResolvedValue(undefined),
    tuple: { localIp: '127.0.0.1', localPort: 40000 },
    close: vi.fn(),
  };
}

/** A router whose createPipeTransport hands back a FRESH transport+consumer
 *  on every call (so a re-run consumes a distinct, real producer id). */
function makeMockRouter() {
  const consumers: ReturnType<typeof makeMockConsumer>[] = [];
  const transports: ReturnType<typeof makeMockPipeTransport>[] = [];
  const router = {
    id: `router-${Math.random().toString(36).slice(2)}`,
    createPipeTransport: vi.fn().mockImplementation(async () => {
      const consumer = makeMockConsumer();
      const transport = makeMockPipeTransport(consumer);
      consumers.push(consumer);
      transports.push(transport);
      return transport;
    }),
    rtpCapabilities: {} as any,
  };
  return { router, consumers, transports };
}

function makeStandbyTopology(roomId = 'room-g1'): RoomTopology {
  return {
    roomId,
    role: 'standby',
    primaryEndpoint: 'ws://primary:4000',
    standbyEndpoint: 'ws://standby:4000',
    pipePort: 40000,
    pipeConsumer: null,
  };
}

// ── A. StandbyWarmPipeCoordinator — resolve + pass real producerId ───────

describe('StandbyWarmPipeCoordinator — registry HAS producer (ready path)', () => {
  let registry: InterRelayProducerRegistry;
  let topology: RoomTopology;

  beforeEach(() => {
    registry = new InterRelayProducerRegistry();
    topology = makeStandbyTopology();
  });

  it('RED-BENCH2-1: ensureWarmPipe is called with the REAL producerId from the registry (not the placeholder)', async () => {
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-from-primary',
      kind: 'audio',
    });
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    const consumer = await coord.ensure(topology, router as any, 40000);

    expect(consumer).not.toBeNull();
    expect(transports).toHaveLength(1);
    const consumeArg = transports[0]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(consumeArg.producerId).toBe('producer-REAL-from-primary');
    // NOT the placeholder
    expect(consumeArg.producerId).not.toContain('pipe-producer-pending');
  });

  it('RED-BENCH2-2: ready path still pauses the consumer (REQ-RO-005 preserved)', async () => {
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL',
      kind: 'video',
    });
    const { router, consumers } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000);

    expect(consumers[0]!.pause).toHaveBeenCalledOnce();
  });
});

// ── B. NOT-READY path: placeholder then re-run on announce ──────────────

describe('StandbyWarmPipeCoordinator — NOT-READY path + announce re-run', () => {
  let registry: InterRelayProducerRegistry;
  let topology: RoomTopology;

  beforeEach(() => {
    registry = new InterRelayProducerRegistry();
    topology = makeStandbyTopology();
  });

  it('RED-BENCH2-3: when registry has NO producer yet, the placeholder is used', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000);

    const consumeArg = transports[0]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(consumeArg.producerId).toBe('pipe-producer-pending-room-g1');
  });

  it('RED-BENCH2-4: a later announce triggers a RE-RUN that resets pipeConsumer and re-consumes with the REAL id', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    // First join: not ready → placeholder + remembered for re-run.
    const firstConsumer = await coord.ensure(topology, router as any, 40000);
    expect(transports[0]!.consume.mock.calls[0]![0]).toMatchObject({
      producerId: 'pipe-producer-pending-room-g1',
    });
    expect(topology.pipeConsumer).toBe(firstConsumer);

    // Announce arrives (primary piped its real producer).
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // A second pipe was opened and consumed the REAL id.
    expect(reran).toBe(true);
    expect(transports).toHaveLength(2);
    const reconsumeArg = transports[1]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(reconsumeArg.producerId).toBe('producer-REAL-late');
    // topology now points at the fresh real consumer (was reset + re-set).
    expect(topology.pipeConsumer).not.toBe(firstConsumer);
    expect(topology.pipeConsumer).not.toBeNull();
  });

  it('RED-BENCH2-5: the re-run consumer is paused (REQ-RO-005 preserved across cutover)', async () => {
    const { router, consumers } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000); // placeholder
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // Both the placeholder consumer and the real re-run consumer were paused.
    expect(consumers[0]!.pause).toHaveBeenCalledOnce();
    expect(consumers[1]!.pause).toHaveBeenCalledOnce();
  });

  it('RED-BENCH2-6: announce re-run is a NO-OP once the real id is already consumed (no double-pipe)', async () => {
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL',
      kind: 'audio',
    });
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000); // already real
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    expect(reran).toBe(false);
    expect(transports).toHaveLength(1); // no second pipe
  });

  it('RED-BENCH2-7: onAnnounce for a room with no prior ensure() does nothing (no topology tracked)', async () => {
    const { router } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);
    registry.record({
      type: 'pipe-producer',
      roomId: 'never-ensured',
      producerId: 'p',
      kind: 'audio',
    });

    const reran = await coord.onAnnounce('never-ensured', topology, router as any, 40000);
    expect(reran).toBe(false);
  });
});

// ── C. createWsInterRelaySender — the announce actually transmits ────────

describe('createWsInterRelaySender — primary announce reaches the wire', () => {
  it('RED-BENCH2-8: with a live socket attached, send() puts the announce bytes on the wire', () => {
    const sent: string[] = [];
    const sock = {
      readyState: 1, // OPEN
      send: vi.fn((data: string) => sent.push(data)),
    };
    const sender = createWsInterRelaySender(() => sock as any);

    const announce = createInterRelayAnnouncer(sender);
    announce('room-A', { id: 'producer-PRIMARY-REAL', kind: 'audio' });

    expect(sock.send).toHaveBeenCalledOnce();
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]!) as Record<string, unknown>;
    expect(frame['type']).toBe('pipe-producer');
    expect(frame['roomId']).toBe('room-A');
    expect(frame['producerId']).toBe('producer-PRIMARY-REAL');
  });

  it('RED-BENCH2-9: with NO socket attached yet, send() does not throw (best-effort queue/drop)', () => {
    const sender = createWsInterRelaySender(() => null);
    expect(() => sender.send('{"type":"pipe-producer"}')).not.toThrow();
  });

  it('RED-BENCH2-10: a socket that is not OPEN is treated as down (no send, no throw)', () => {
    const sock = { readyState: 3 /* CLOSED */, send: vi.fn() };
    const sender = createWsInterRelaySender(() => sock as any);
    expect(() => sender.send('frame')).not.toThrow();
    expect(sock.send).not.toHaveBeenCalled();
  });

  it('RED-BENCH2-11: a throwing socket is swallowed by the announcer (produce path never crashes)', () => {
    const sock = {
      readyState: 1,
      send: vi.fn(() => {
        throw new Error('socket exploded');
      }),
    };
    const sender = createWsInterRelaySender(() => sock as any);
    const announce = createInterRelayAnnouncer(sender);
    expect(() =>
      announce('room-A', { id: 'p', kind: 'audio' }),
    ).not.toThrow();
  });
});
