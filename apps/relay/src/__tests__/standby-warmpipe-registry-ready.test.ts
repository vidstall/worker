/**
 * BENCH-2 / G1 tests — wire the PRIMARY's REAL pipe-producer ID across the
 * inter-relay warm-pipe so the STANDBY consumes the real producer (replacing
 * the `pipe-producer-pending-<roomId>` placeholder).
 *
 * A. STANDBY warm-pipe orchestration (StandbyWarmPipeCoordinator) — registry
 *    HAS the primary's producerId → ensureWarmPipe is called with that REAL
 *    id (not the placeholder), and REQ-RO-005 paused invariant preserved.
 *
 * Requirements: REQ-RO-004 (G1 warm-pipe producerId wiring), REQ-RO-005 (paused).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InterRelayProducerRegistry, StandbyWarmPipeCoordinator } from '@dvconf/inter-relay-client';
import type { RoomTopology } from '@dvconf/inter-relay-client';
import { makeMockRouter, makeStandbyTopology } from './inter-relay-warmpipe.testUtils.js';

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
