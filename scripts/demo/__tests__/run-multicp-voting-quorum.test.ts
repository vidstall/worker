import { describe, it, expect } from 'vitest';
import {
  parseRoomId,
  decodeLeU64,
  assertRoleQuorum,
  assertPairingQuorum,
  classifyRetryLine,
  summarizeRetryTails,
  type ProposalSubmittedJson,
} from '../run-multicp-voting.ts';
import type { RoleAssigned, RoleVoteCast, RoomAssigned } from '../../../packages/shared/src/index.ts';

// ══════════════════════════════════════════════════════════════════════════
// C4 — live-demo pure helpers (the fragile logic behind the #6/#7 hard asserts).
// All synthetic parsedJson objects; NO network. The impure orchestration (spawn,
// devInspect, queryEvents polling, main()) is exercised by the controller's live
// run, not here.
// ══════════════════════════════════════════════════════════════════════════

/** A valid 0x-prefixed 32-byte hex address (normalizeSuiAddress-safe, unlike '0xcp0'). */
const addr = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

/** The genuine N=5 quorum number the demo pins: ceil(5 * 6667 / 10000) = 4. */
const REQ = 4;

describe('parseRoomId — the escrow-driver STDOUT contract (pure)', () => {
  it('extracts the room id from a bare ROOM_ID= line', () => {
    expect(parseRoomId('ROOM_ID=0xabc123')).toBe('0xabc123');
  });

  it('extracts from the exact escrow-driver framing (\\nROOM_ID=…\\n)', () => {
    expect(parseRoomId('\nROOM_ID=0xdeadbeef\n')).toBe('0xdeadbeef');
  });

  it('finds the ROOM_ID line amid interleaved pino JSON log lines on stdout', () => {
    const stdout = [
      '{"level":30,"time":1,"msg":"escrow-driver starting"}',
      '{"level":30,"time":2,"msg":"room created"}',
      '',
      'ROOM_ID=0x0011ffee',
      '{"level":30,"time":3,"msg":"escrow created"}',
    ].join('\n');
    expect(parseRoomId(stdout)).toBe('0x0011ffee');
  });

  it('returns null when no ROOM_ID line is present', () => {
    expect(parseRoomId('{"level":30,"msg":"no room here"}\n')).toBeNull();
  });

  it('does NOT match a ROOM_ID substring that is not at line start (anchored ^)', () => {
    // A log line MENTIONING ROOM_ID mid-string must not be mistaken for the contract.
    expect(parseRoomId('{"msg":"emitting ROOM_ID=0xnope on stdout"}')).toBeNull();
    expect(parseRoomId('XROOM_ID=0xnope')).toBeNull();
  });

  it('tolerates CRLF line endings (\\r\\n) — the \\r? guard (M-2)', () => {
    // Under /m, `$` sits before `\n`; a bare `$` would fail on the trailing `\r`.
    expect(parseRoomId('some log line\r\nROOM_ID=0xc0ffee\r\n')).toBe('0xc0ffee');
  });
});

describe('decodeLeU64 — 8-byte little-endian BCS u64 decode (pure)', () => {
  it('decodes zero', () => {
    expect(decodeLeU64([0, 0, 0, 0, 0, 0, 0, 0])).toBe(0n);
  });

  it('decodes a small LE value (5)', () => {
    expect(decodeLeU64([5, 0, 0, 0, 0, 0, 0, 0])).toBe(5n);
  });

  it('honours little-endian byte order (byte[1]=1 → 256)', () => {
    expect(decodeLeU64([0, 1, 0, 0, 0, 0, 0, 0])).toBe(256n);
  });

  it('decodes u64::MAX', () => {
    expect(decodeLeU64([255, 255, 255, 255, 255, 255, 255, 255])).toBe(18446744073709551615n);
  });

  it('throws on a non-8-byte input (fail-closed)', () => {
    expect(() => decodeLeU64([1, 2, 3])).toThrow(/8/);
    expect(() => decodeLeU64([0, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/8/);
  });
});

/** Build a RoleAssigned parsedJson fixture. */
function roleAssigned(over: Partial<RoleAssigned> = {}): RoleAssigned {
  return { miner_id: addr(1), role: 2, vote_count: '4', threshold: '4', ...over };
}
/** Build a RoleVoteCast parsedJson fixture. */
function roleVoteCast(voter: number, over: Partial<RoleVoteCast> = {}): RoleVoteCast {
  return { miner_id: addr(1), role: 2, voter: addr(voter), current_votes: '1', required: '4', ...over };
}

describe('assertRoleQuorum — the #6 4-of-5 hard assert (pure)', () => {
  it('passes at vote_count=4, threshold=4, and exactly 4 distinct voters', () => {
    const casts = [roleVoteCast(10), roleVoteCast(11), roleVoteCast(12), roleVoteCast(13)];
    const res = assertRoleQuorum(roleAssigned(), casts, addr(1), REQ);
    expect(res.voters).toHaveLength(4);
    expect(res.threshold).toBe('4');
    expect(res.voteCount).toBe('4');
  });

  it('ignores RoleVoteCast events for a DIFFERENT miner when counting voters', () => {
    const casts = [
      roleVoteCast(10),
      roleVoteCast(11),
      roleVoteCast(12),
      roleVoteCast(13),
      roleVoteCast(99, { miner_id: addr(777) }), // noise: another miner's vote
    ];
    const res = assertRoleQuorum(roleAssigned(), casts, addr(1), REQ);
    expect(res.voters).toHaveLength(4);
  });

  it('de-dups a repeated voter address (set semantics, not raw count)', () => {
    const casts = [roleVoteCast(10), roleVoteCast(10), roleVoteCast(11), roleVoteCast(12)];
    // 3 distinct voters → below quorum → throws.
    expect(() => assertRoleQuorum(roleAssigned(), casts, addr(1), REQ)).toThrow(/distinct voter/i);
  });

  it('throws when vote_count != required', () => {
    const casts = [roleVoteCast(10), roleVoteCast(11), roleVoteCast(12), roleVoteCast(13)];
    expect(() => assertRoleQuorum(roleAssigned({ vote_count: '3' }), casts, addr(1), REQ)).toThrow(/vote_count/);
  });

  it('throws when threshold string != required', () => {
    const casts = [roleVoteCast(10), roleVoteCast(11), roleVoteCast(12), roleVoteCast(13)];
    expect(() => assertRoleQuorum(roleAssigned({ threshold: '3' }), casts, addr(1), REQ)).toThrow(/threshold/);
  });

  it('throws when fewer than 4 distinct voters are present', () => {
    const casts = [roleVoteCast(10), roleVoteCast(11), roleVoteCast(12)];
    expect(() => assertRoleQuorum(roleAssigned(), casts, addr(1), REQ)).toThrow(/distinct voter/i);
  });

  it('throws when the RoleAssigned miner_id is not the user-miner', () => {
    const casts = [roleVoteCast(10), roleVoteCast(11), roleVoteCast(12), roleVoteCast(13)];
    expect(() => assertRoleQuorum(roleAssigned({ miner_id: addr(2) }), casts, addr(1), REQ)).toThrow(/miner_id/);
  });
});

/** Build a RoomAssigned parsedJson fixture. */
function roomAssigned(over: Partial<RoomAssigned> = {}): RoomAssigned {
  return {
    room_id: addr(5),
    relay_ids: [addr(20), addr(21)],
    relay_mode: 0,
    verified_score: '1000',
    consensus_reached: true,
    winning_cp: addr(40),
    validator_ids: [addr(50)],
    ...over,
  };
}
/** Build a ProposalSubmitted parsedJson fixture. */
function proposal(cp: number, score: string): ProposalSubmittedJson {
  return { room_id: addr(5), cp_id: addr(cp), verified_score: score, relay_count: '2', validator_count: '4' };
}

describe('assertPairingQuorum — the #7 4-of-5 hard assert (pure)', () => {
  it('passes with consensus_reached, a set winning_cp (a proposer), and >=4 distinct CPs at the winning score', () => {
    const props = [
      proposal(60, '1000'),
      proposal(61, '1000'),
      proposal(62, '1000'),
      proposal(63, '1000'),
      proposal(64, '999'), // a dissenting score — must not count toward the quorum
    ];
    // winning_cp MUST be one of the agreeing proposers (M-3): cp 60 proposed 1000.
    const res = assertPairingQuorum(roomAssigned({ winning_cp: addr(60) }), props, REQ);
    expect(res.agreeingCpIds).toHaveLength(4);
    expect(res.winningScore).toBe('1000');
    expect(res.winningCp).toBe(addr(60));
  });

  it('de-dups a CP that proposed the winning score twice', () => {
    const props = [proposal(60, '1000'), proposal(60, '1000'), proposal(61, '1000'), proposal(62, '1000')];
    // 3 distinct CPs at the winning score → below quorum → throws.
    expect(() => assertPairingQuorum(roomAssigned(), props, REQ)).toThrow(/distinct CP/i);
  });

  it('throws when fewer than 4 distinct CPs share the winning score', () => {
    const props = [proposal(60, '1000'), proposal(61, '1000'), proposal(62, '1000')];
    expect(() => assertPairingQuorum(roomAssigned(), props, REQ)).toThrow(/distinct CP/i);
  });

  it('throws when no proposal matches the RoomAssigned winning score (mismatch)', () => {
    const props = [proposal(60, '111'), proposal(61, '222'), proposal(62, '333'), proposal(63, '444')];
    expect(() => assertPairingQuorum(roomAssigned({ verified_score: '1000' }), props, REQ)).toThrow(/distinct CP/i);
  });

  it('throws when consensus_reached is false (admin fallback, not a CP quorum)', () => {
    const props = [proposal(60, '1000'), proposal(61, '1000'), proposal(62, '1000'), proposal(63, '1000')];
    expect(() => assertPairingQuorum(roomAssigned({ consensus_reached: false }), props, REQ)).toThrow(/consensus/i);
  });

  it('throws when winning_cp is empty', () => {
    const props = [proposal(60, '1000'), proposal(61, '1000'), proposal(62, '1000'), proposal(63, '1000')];
    expect(() => assertPairingQuorum(roomAssigned({ winning_cp: '' }), props, REQ)).toThrow(/winning_cp/);
  });

  it('throws when winning_cp is the zero ID (admin fallback)', () => {
    const props = [proposal(60, '1000'), proposal(61, '1000'), proposal(62, '1000'), proposal(63, '1000')];
    expect(() => assertPairingQuorum(roomAssigned({ winning_cp: '0x0' }), props, REQ)).toThrow(/winning_cp/);
  });

  it('throws when winning_cp did not propose the winning score (not among the agreeing CPs) (M-3)', () => {
    // 4 distinct CPs share '1000' (passes the count), but the winner (cp 70) proposed '999'.
    const props = [
      proposal(60, '1000'),
      proposal(61, '1000'),
      proposal(62, '1000'),
      proposal(63, '1000'),
      proposal(70, '999'),
    ];
    expect(() => assertPairingQuorum(roomAssigned({ winning_cp: addr(70) }), props, REQ)).toThrow(/winning_cp|winning score/i);
  });
});

describe('benign-abort tail classifier (fact G — honest: retried then swallowed, NOT crash)', () => {
  it('classifies an executeWithRetry warn line as "retrying"', () => {
    expect(classifyRetryLine('{"level":40,"msg":"submit-proposal failed, retrying"}')).toBe('retrying');
  });

  it('classifies the exhausted-retries error line as "exhausted"', () => {
    expect(classifyRetryLine('{"level":50,"msg":"submit-proposal exhausted retries, skipping"}')).toBe('exhausted');
  });

  it('returns null for an ordinary log line', () => {
    expect(classifyRetryLine('{"level":30,"msg":"heartbeat sent"}')).toBeNull();
  });

  it('summarizes retry/exhausted counts across many daemon tails', () => {
    const tails = [
      ['a failed, retrying', 'b failed, retrying', 'x exhausted retries, skipping'],
      ['ordinary line', 'c failed, retrying'],
      [],
    ];
    expect(summarizeRetryTails(tails)).toEqual({ retrying: 3, exhausted: 1 });
  });
});
