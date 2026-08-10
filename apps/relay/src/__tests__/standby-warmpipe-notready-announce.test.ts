/**
 * BENCH-2 / G1 tests — wire the PRIMARY's REAL pipe-producer ID across the
 * inter-relay warm-pipe so the STANDBY consumes the real producer (replacing
 * the `pipe-producer-pending-<roomId>` placeholder).
 *
 * B. NOT-READY path: registry returns null → placeholder used + a later
 *    announce triggers a RE-RUN that resets topology.pipeConsumer and
 *    re-consumes with the real id (the not-ready re-run contract).
 *    REQ-RO-005 paused invariant preserved on the real re-run consume.
 *
 * Requirements: REQ-RO-004 (G1 warm-pipe producerId wiring), REQ-RO-005 (paused).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InterRelayProducerRegistry, StandbyWarmPipeCoordinator } from '@dvconf/inter-relay-client';
import type { RoomTopology } from '@dvconf/inter-relay-client';
import { makeMockRouter, makeStandbyTopology } from './inter-relay-warmpipe.testUtils.js';

// ── B. NOT-READY path: DEFER (no consume) then re-run on announce (C1/C3) ─

describe('StandbyWarmPipeCoordinator — NOT-READY path + announce re-run', () => {
  let registry: InterRelayProducerRegistry;
  let topology: RoomTopology;

  beforeEach(() => {
    registry = new InterRelayProducerRegistry();
    topology = makeStandbyTopology();
  });

  it('RED-BENCH2-3: when registry has NO producer yet, ensure DEFERS — binds the pipe transport but does NOT consume a placeholder (C1)', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    const consumer = await coord.ensure(topology, router as any, 40000);

    // C1 (cross-relay DEADLOCK fix): no real producer announced yet → DEFER. The
    // transport is bound (so the UP {ip,port} announce can read its port) but
    // NOTHING is consumed — consuming a `pipe-producer-pending-<roomId>` sentinel
    // throws "Producer not found" on real mediasoup. onAnnounce re-runs with the
    // real id once it arrives.
    expect(consumer).toBeNull();
    expect(transports).toHaveLength(1);
    expect(transports[0]!.consume).not.toHaveBeenCalled();
    expect(topology.pipeConsumer).toBeNull();
    expect(topology.pipeTransport).toBe(transports[0]);
  });

  it('RED-BENCH2-4: a later announce triggers a RE-RUN that consumes the REAL id on the SAME (reused) bound transport (C3)', async () => {
    const { router, transports } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    // First join: not ready → DEFER (C1). Transport bound, nothing consumed yet.
    const firstConsumer = await coord.ensure(topology, router as any, 40000);
    expect(firstConsumer).toBeNull();
    expect(transports[0]!.consume).not.toHaveBeenCalled();
    expect(topology.pipeConsumer).toBeNull();

    // Announce arrives (primary piped its real producer).
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    const reran = await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // C3 (cross-relay DEADLOCK fix): the EXISTING bound transport is REUSED (NOT
    // closed+rebuilt — that would tear down the connected pipe) and consumes the
    // REAL id — so still ONE transport, now carrying the real warm-pipe consumer.
    expect(reran).toBe(true);
    expect(transports).toHaveLength(1);
    const reconsumeArg = transports[0]!.consume.mock.calls[0]![0] as { producerId: string };
    expect(reconsumeArg.producerId).toBe('producer-REAL-late');
    expect(topology.pipeConsumer).not.toBeNull();
    expect(topology.pipeTransport).toBe(transports[0]);
  });

  it('RED-BENCH2-5: the re-run consumer is paused (REQ-RO-005 preserved across cutover)', async () => {
    const { router, consumers } = makeMockRouter();
    const coord = new StandbyWarmPipeCoordinator(registry);

    await coord.ensure(topology, router as any, 40000); // defer — no consume/pause yet
    registry.record({
      type: 'pipe-producer',
      roomId: 'room-g1',
      producerId: 'producer-REAL-late',
      kind: 'audio',
    });
    await coord.onAnnounce('room-g1', topology, router as any, 40000);

    // The single warm-pipe consumer minted on the cutover is paused (RTCP keepalive).
    expect(consumers[0]!.pause).toHaveBeenCalledOnce();
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
