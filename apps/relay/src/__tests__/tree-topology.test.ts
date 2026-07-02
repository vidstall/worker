/**
 * Unit tests for tree-topology (cascade-tree Phase T-A).
 * REQ-RMS-039 (determinism) / 040 (degree cap) / 041 (diameter bound) / 048 (K<=2 star shape).
 * All pure/synchronous — no mediasoup, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { deriveDegreeCap } from '@dvconf/inter-relay-client';

describe('deriveDegreeCap (REQ-RMS-040)', () => {
  it('D = floor((cWorker - uLocal) / P)', () => {
    expect(deriveDegreeCap(300, 0, 9)).toBe(33);
  });
  it('subtracts the local-client budget then floors', () => {
    expect(deriveDegreeCap(300, 10, 9)).toBe(32); // floor(290/9) = 32
  });
  it('returns 0 when local clients consume the whole worker', () => {
    expect(deriveDegreeCap(300, 300, 9)).toBe(0);
    expect(deriveDegreeCap(300, 500, 9)).toBe(0);
  });
  it('returns 0 when there are no producers', () => {
    expect(deriveDegreeCap(300, 0, 0)).toBe(0);
    expect(deriveDegreeCap(300, 0, -1)).toBe(0);
  });
});
