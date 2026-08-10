/**
 * pipeRoomToSecondWorker (REQ-RMS-007 — tier-2 intra-box cross-worker spill).
 *
 * Pure-logic branches over a mocked sourceRouter.pipeToRouter (no real mediasoup):
 *   - happy path: returns the minted pipeConsumer
 *   - defensive throw when mediasoup returns no pipeConsumer (optional-narrow)
 */

import { describe, it, expect, vi } from 'vitest';
import { pipeRoomToSecondWorker } from '@dvconf/inter-relay-client';

describe('pipeRoomToSecondWorker (REQ-RMS-007)', () => {
  it('returns { pipeProducer, pipeConsumer } — pipeConsumer minted on the source router (kind mirrors producer)', async () => {
    const pipeConsumer = { id: 'pipe-consumer-1', kind: 'video' };
    const pipeProducer = { id: 'pipe-producer-1', kind: 'video' };
    const sourceRouter = { pipeToRouter: vi.fn().mockResolvedValue({ pipeProducer, pipeConsumer }) };
    const secondRouter = { id: 'router-second' };

    const result = await pipeRoomToSecondWorker(
      sourceRouter as any,
      secondRouter as any,
      'producer-REAL',
    );

    // Task-10 (REQ-RMS-011): the helper now RETURNS both legs of the hop so a
    // caller can witness the downstream producer's surviving simulcast ladder.
    expect(result.pipeConsumer).toBe(pipeConsumer);
    expect(result.pipeProducer).toBe(pipeProducer);
    // No-cast call shape: { producerId, router } passed straight through.
    expect(sourceRouter.pipeToRouter).toHaveBeenCalledWith({
      producerId: 'producer-REAL',
      router: secondRouter,
    });
  });

  it('throws (producerId-bearing) when pipeToRouter returns no pipeConsumer', async () => {
    // mediasoup types pipeConsumer as optional; the helper must fail loud.
    const sourceRouter = {
      pipeToRouter: vi.fn().mockResolvedValue({ pipeProducer: { id: 'p' }, pipeConsumer: undefined }),
    };
    const secondRouter = { id: 'router-second' };

    await expect(
      pipeRoomToSecondWorker(sourceRouter as any, secondRouter as any, 'producer-MISSING'),
    ).rejects.toThrow('producer-MISSING');
  });

  it('throws (producerId-bearing) when pipeToRouter returns no pipeProducer', async () => {
    // pipeProducer is likewise optional in mediasoup's types; the helper must
    // fail loud rather than return a half-formed hop result.
    const sourceRouter = {
      pipeToRouter: vi.fn().mockResolvedValue({ pipeProducer: undefined, pipeConsumer: { id: 'c' } }),
    };
    const secondRouter = { id: 'router-second' };

    await expect(
      pipeRoomToSecondWorker(sourceRouter as any, secondRouter as any, 'producer-NOPROD'),
    ).rejects.toThrow('producer-NOPROD');
  });
});
