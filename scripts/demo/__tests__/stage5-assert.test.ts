import { describe, it, expect } from 'vitest';
import { assertCanarySlash } from '../assert-canary-slash.ts';

const ROOM = '0x7c60b80eefcdcb0a840b1587a939adbd119c9aeb8f047983a2462fd19d19b15c';

describe('assertCanarySlash (Stage-5 on-chain proof)', () => {
  it('PASSES on attester_count>=2 with 2 distinct attester_ids', () => {
    const ev = {
      attester_count: '2',
      attester_ids: ['0x1da6f3ce', '0x225910e5'],
      relay_miner_id: '0x93c9564e',
      room_id: ROOM,
      canary_id: '7',
      frame_seq: '2',
      observed_present: true,
    };
    expect(assertCanarySlash(ev, ROOM)).toEqual({ ok: true, distinct: 2 });
  });
  it('FAILS when only 1 distinct attester', () => {
    const ev = { attester_count: '1', attester_ids: ['0x1da6f3ce'], room_id: ROOM, observed_present: true };
    const r = assertCanarySlash(ev, ROOM);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('attester_count');
  });
  it('FAILS when two attester_ids are identical (no real distinctness)', () => {
    const ev = { attester_count: '2', attester_ids: ['0x1da6f3ce', '0x1da6f3ce'], room_id: ROOM, observed_present: true };
    expect(assertCanarySlash(ev, ROOM).ok).toBe(false);
  });
  it('FAILS when room_id mismatches the shared roomId', () => {
    const ev = { attester_count: '2', attester_ids: ['0xa', '0xb'], room_id: '0xWRONG', observed_present: true };
    expect(assertCanarySlash(ev, ROOM).ok).toBe(false);
  });
});
