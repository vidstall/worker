import { describe, it, expect } from 'vitest';
import { assertActiveValidators } from '../assert-active-validators.ts';

describe('assertActiveValidators', () => {
  it('passes when active_count >= 2', () => {
    expect(assertActiveValidators(2)).toEqual({ ok: true, count: 2 });
    expect(assertActiveValidators(3).ok).toBe(true);
  });
  it('fails when active_count < 2 (2nd validator not on-chain role-assigned)', () => {
    const r = assertActiveValidators(1);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('active_count');
  });
});
