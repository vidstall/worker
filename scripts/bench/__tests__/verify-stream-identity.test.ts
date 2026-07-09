import { describe, it, expect } from 'vitest';
import { makeIdFrame } from '../distinguishable-media';
import { StreamIdentityChecker } from '../verify-stream-identity';

describe('StreamIdentityChecker', () => {
  it('passes when decoded id matches expected', () => {
    const c = new StreamIdentityChecker(320, 240);
    c.observe(/*expected*/ 5, makeIdFrame(320, 240, 5));
    expect(c.summary()).toEqual({ observed: 1, matched: 1, mismatched: 0, ok: true });
  });

  it('flags a cross-wired stream', () => {
    const c = new StreamIdentityChecker(320, 240);
    c.observe(5, makeIdFrame(320, 240, 9)); // wrong stream delivered
    expect(c.summary().ok).toBe(false);
  });
});
