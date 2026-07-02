import { describe, it, expect } from 'vitest';
import { buildPipeProducerAnnounce, isPipeProducerAnnounce } from '@dvconf/inter-relay-client';

describe('T-B byte-stability guards (REQ-RMS-048) — MUST stay green through every task', () => {
  it('a default announce frame has EXACTLY the shipped keys (no tree fields)', () => {
    const frame = buildPipeProducerAnnounce('room1', { id: 'prod1', kind: 'video' });
    expect(Object.keys(frame).sort()).toEqual(['kind', 'producerId', 'roomId', 'type']);
    expect('hopTtl' in frame).toBe(false);
    expect('originProducerId' in frame).toBe(false);
  });
  it('a pre-tree frame (no hopTtl/originProducerId) still validates (back-compat)', () => {
    expect(isPipeProducerAnnounce({
      type: 'pipe-producer', roomId: 'room1', producerId: 'prod1', kind: 'video',
    })).toBe(true);
  });
});
