import { describe, it, expect } from 'vitest';
import { isAbsolute, join } from 'node:path';
import {
  buildLaunchPlan,
  mergeChildEnv,
  parseRoomId,
  decodeLeU64,
  assertRoleQuorum,
  assertPairingQuorum,
  classifyRetryLine,
  summarizeRetryTails,
  type ProcessSpec,
  type ProposalSubmittedJson,
} from '../run-multicp-voting.ts';
// TYPE-ONLY imports — elided at runtime so neither seed-multicp.ts nor
// seed-bootstrap.ts (both call main() at module top-level WITHOUT an argv guard)
// executes when this test loads.
import type { MultiCpKeysFile } from '../seed-multicp.ts';
import type { SeededKey } from '../seed-bootstrap.ts';
import type { RoleAssigned, RoleVoteCast, RoomAssigned } from '../../../packages/shared/src/index.ts';

// ── synthetic substrate (no network, no real keys) ───────────────────────

/** A fake SeededKey slot with bech32-ish secretKey + distinct cap/stake/miner ids. */
function fakeKey(tag: string): SeededKey {
  return {
    secretKey: `suiprivkey1${tag}`,
    capId: `0xcap_${tag}`,
    stakeId: `0xstake_${tag}`,
    minerId: `0xminer_${tag}`,
  };
}

/** The exact N=5 substrate seed-multicp writes: 5 cps / 4 validators / 2 relays / 1 signaling. */
function fakeKeys(): MultiCpKeysFile {
  return {
    cps: [0, 1, 2, 3, 4].map((i) => fakeKey(`cp${i}`)),
    validators: [0, 1, 2, 3].map((j) => fakeKey(`val${j}`)),
    relays: [0, 1].map((k) => fakeKey(`relay${k}`)),
    signaling: [fakeKey('sig0')],
  };
}

const USER_MINER_KEY = 'suiprivkey1userminerfresh';

/** The 10 published-config vars every child needs (loadNetworkConfig REQUIRED set). */
const REQUIRED_CFG_VARS = [
  'PACKAGE_ID',
  'NETWORK_REGISTRY_ID',
  'MINER_STORE_ID',
  'CP_REGISTRY_ID',
  'RELAY_REGISTRY_ID',
  'VALIDATOR_REGISTRY_ID',
  'USER_REGISTRY_ID',
  'ROOM_MANAGER_ID',
  'SIGNALING_REGISTRY_ID',
  'ROLE_VOTE_BOX_ID',
] as const;

/** A minimal baseEnv carrying exactly the 10 required $CFG vars (distinct values). */
function baseCfgEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of REQUIRED_CFG_VARS) env[k] = `0x${k.toLowerCase()}_value`;
  return env;
}

function plan(): ProcessSpec[] {
  return buildLaunchPlan(fakeKeys(), USER_MINER_KEY, baseCfgEnv());
}

const byName = (specs: ProcessSpec[], name: string): ProcessSpec => {
  const s = specs.find((x) => x.name === name);
  if (!s) throw new Error(`spec ${name} not found`);
  return s;
};

/** The DISTINCT physical listening ports a process binds (no double-count of healthz). */
function listeningPorts(s: ProcessSpec): number[] {
  const pipeBounds = (range: string | undefined): number[] =>
    range ? range.split('-').map((n) => Number(n)) : [];
  switch (s.app) {
    case 'cp-daemon':
      return [Number(s.env['CP_HEALTHZ_PORT'])];
    case 'validator-daemon':
      return [Number(s.env['VALIDATOR_HEALTHZ_PORT'])];
    case 'relay':
      return [
        Number(s.env['WS_PORT']),
        Number(s.env['METRICS_PORT']),
        Number(s.env['RTC_MIN_PORT']),
        Number(s.env['RTC_MAX_PORT']),
        ...pipeBounds(s.env['PIPE_PORT_RANGE']),
      ];
    case 'signaling':
      return [Number(s.env['SIGNALING_PORT']), Number(s.env['SIGNALING_HEALTHZ_PORT'])];
    default:
      return [];
  }
}

describe('buildLaunchPlan — the C3 fleet matrix (pure)', () => {
  it('produces exactly 13 specs (5 cp + 4 val + 1 user-miner + 2 relay + 1 sig)', () => {
    const specs = plan();
    expect(specs).toHaveLength(13);
    expect(specs.filter((s) => s.app === 'cp-daemon')).toHaveLength(5);
    // validator-daemon binary covers BOTH the 4 infra validators AND the user-miner.
    expect(specs.filter((s) => s.app === 'validator-daemon')).toHaveLength(5);
    expect(specs.filter((s) => s.app === 'relay')).toHaveLength(2);
    expect(specs.filter((s) => s.app === 'signaling')).toHaveLength(1);
  });

  it('allocates pairwise non-colliding listening ports across the whole fleet', () => {
    // Collecting RANGE BOUNDS (not every port in the RTC/pipe ranges) is sufficient
    // here: the two relays' ranges are disjoint by stride 200 > span 100, and every
    // scalar port sits in a far-apart band (4xxx WS/metrics, 8xxx healthz, 10xxx RTC,
    // 40xxx pipe) — so a collision could only show up as two equal bounds/scalars.
    // The separate "ranges disjoint" test below guards the stride assumption directly.
    const ports = plan().flatMap(listeningPorts);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('keeps the two relays RTC + pipe UDP ranges disjoint', () => {
    const specs = plan();
    const r0 = byName(specs, 'relay-0');
    const r1 = byName(specs, 'relay-1');
    // RTC: [10000,10100] vs [10200,10300] — r0 max < r1 min.
    expect(Number(r0.env['RTC_MAX_PORT'])).toBeLessThan(Number(r1.env['RTC_MIN_PORT']));
    // Pipe: "40000-40100" vs "40200-40300".
    const hi0 = Number(r0.env['PIPE_PORT_RANGE']!.split('-')[1]);
    const lo1 = Number(r1.env['PIPE_PORT_RANGE']!.split('-')[0]);
    expect(hi0).toBeLessThan(lo1);
  });

  it('gives every process a distinct CWD ending in .run/<role>-<i> and an absolute .ts entry', () => {
    const specs = plan();
    const cwds = specs.map((s) => s.cwd);
    expect(new Set(cwds).size).toBe(specs.length);
    for (const s of specs) {
      expect(isAbsolute(s.cwd)).toBe(true);
      expect(s.cwd.endsWith(join('.run', s.name))).toBe(true);
      expect(isAbsolute(s.entry)).toBe(true);
      expect(s.entry.endsWith(join('apps', s.app, 'src', 'index.ts'))).toBe(true);
    }
  });

  it('maps each cp-i to its keypair/cap, healthz 8091+i, quorum threshold 1, and leaves quorum vars unset', () => {
    const specs = plan();
    const keys = fakeKeys();
    for (let i = 0; i < 5; i++) {
      const cp = byName(specs, `cp-${i}`);
      expect(cp.order).toBe('cp');
      expect(cp.env['CP_KEYPAIR']).toBe(keys.cps[i]!.secretKey);
      expect(cp.env['CP_CAP_ID']).toBe(keys.cps[i]!.capId);
      expect(cp.env['CP_HEALTHZ_PORT']).toBe(String(8091 + i));
      expect(cp.healthzPort).toBe(8091 + i);
      expect(cp.env['CAP_TOKEN_QUORUM_THRESHOLD']).toBe('1');
      // The cap-token SIGNATURE quorum is orthogonal — KISS demo leaves it off.
      expect('TURN_RPC_TOKEN' in cp.env).toBe(false);
      expect('QUORUM_CLAIMS_ENABLED' in cp.env).toBe(false);
      expect('QUORUM_STATE_OBJECT_ID' in cp.env).toBe(false);
    }
  });

  it('maps each infra val-j to its keypair/cap, healthz 8101+j, and runs in normal (non-voting) mode', () => {
    const specs = plan();
    const keys = fakeKeys();
    for (let j = 0; j < 4; j++) {
      const val = byName(specs, `val-${j}`);
      expect(val.order).toBe('infra');
      expect(val.app).toBe('validator-daemon');
      expect(val.env['SUI_PRIVATE_KEY']).toBe(keys.validators[j]!.secretKey);
      expect(val.env['VALIDATOR_CAP_ID']).toBe(keys.validators[j]!.capId);
      expect(val.env['VALIDATOR_HEALTHZ_PORT']).toBe(String(8101 + j));
      expect(val.healthzPort).toBe(8101 + j);
      // Pre-registered infra: NOT voting. REGISTRATION_MODE must not be 'voting'.
      expect(val.env['REGISTRATION_MODE']).not.toBe('voting');
    }
  });

  it('configures the user-miner as a voting validator-daemon with a fresh key and NO cap', () => {
    const um = byName(plan(), 'user-miner');
    expect(um.order).toBe('user-miner');
    expect(um.app).toBe('validator-daemon');
    expect(um.env['SUI_PRIVATE_KEY']).toBe(USER_MINER_KEY);
    expect(um.env['REGISTRATION_MODE']).toBe('voting');
    expect(um.env['VALIDATOR_HEALTHZ_PORT']).toBe('8105');
    expect(um.healthzPort).toBe(8105);
    // Presence of VALIDATOR_CAP_ID ⇒ voting SKIPPED — the key must be wholly absent.
    expect('VALIDATOR_CAP_ID' in um.env).toBe(false);
  });

  it('maps each relay-k to its key/cap and the k-offset port block, with healthz on the metrics port', () => {
    const specs = plan();
    const keys = fakeKeys();
    for (let k = 0; k < 2; k++) {
      const relay = byName(specs, `relay-${k}`);
      expect(relay.order).toBe('infra');
      expect(relay.app).toBe('relay');
      expect(relay.env['PRIVATE_KEY']).toBe(keys.relays[k]!.secretKey);
      expect(relay.env['MINER_CAP_ID']).toBe(keys.relays[k]!.capId);
      expect(relay.env['WS_PORT']).toBe(String(4000 + 10 * k));
      expect(relay.env['METRICS_PORT']).toBe(String(4001 + 10 * k));
      expect(relay.env['RTC_MIN_PORT']).toBe(String(10000 + 200 * k));
      expect(relay.env['RTC_MAX_PORT']).toBe(String(10100 + 200 * k));
      expect(relay.env['PIPE_PORT_RANGE']).toBe(`${40000 + 200 * k}-${40100 + 200 * k}`);
      expect(relay.env['RELAY_ENDPOINT_URL']).toBe(`ws://127.0.0.1:${4000 + 10 * k}`);
      // /healthz is served on METRICS_PORT (relay binds no separate healthz port).
      expect(relay.healthzPort).toBe(4001 + 10 * k);
    }
  });

  it('configures the single signaling on the published 8080 + healthz 8082', () => {
    const sig = byName(plan(), 'sig-0');
    const keys = fakeKeys();
    expect(sig.order).toBe('infra');
    expect(sig.app).toBe('signaling');
    expect(sig.env['SIGNALING_KEYPAIR']).toBe(keys.signaling[0]!.secretKey);
    expect(sig.env['MINER_CAP_ID']).toBe(keys.signaling[0]!.capId);
    expect(sig.env['SIGNALING_PORT']).toBe('8080');
    expect(sig.env['SIGNALING_HEALTHZ_PORT']).toBe('8082');
    expect(sig.healthzPort).toBe(8082);
  });

  it('threads all 10 required $CFG vars into every child env', () => {
    const specs = plan();
    const base = baseCfgEnv();
    for (const s of specs) {
      for (const k of REQUIRED_CFG_VARS) {
        expect(s.env[k]).toBe(base[k]);
      }
    }
  });

  it('defaults SUI_NETWORK to localnet and aliases CP_REGISTRY_OBJECT_ID when baseEnv omits them', () => {
    const specs = plan();
    const base = baseCfgEnv();
    for (const s of specs) {
      expect(s.env['SUI_NETWORK']).toBe('localnet');
      expect(s.env['CP_REGISTRY_OBJECT_ID']).toBe(base['CP_REGISTRY_ID']);
    }
  });

  it('honours an explicit SUI_NETWORK from baseEnv', () => {
    const base = { ...baseCfgEnv(), SUI_NETWORK: 'http://127.0.0.1:9000' };
    const specs = buildLaunchPlan(fakeKeys(), USER_MINER_KEY, base);
    expect(specs.every((s) => s.env['SUI_NETWORK'] === 'http://127.0.0.1:9000')).toBe(true);
  });

  it('groups the spawn waves: 5 cp / 1 user-miner / 7 infra', () => {
    const specs = plan();
    expect(specs.filter((s) => s.order === 'cp')).toHaveLength(5);
    expect(specs.filter((s) => s.order === 'user-miner')).toHaveLength(1);
    expect(specs.filter((s) => s.order === 'infra')).toHaveLength(7);
  });

  it('throws loud when a required $CFG var is missing (fail before any spawn)', () => {
    const incomplete = baseCfgEnv();
    delete incomplete['ROLE_VOTE_BOX_ID'];
    expect(() => buildLaunchPlan(fakeKeys(), USER_MINER_KEY, incomplete)).toThrow(/ROLE_VOTE_BOX_ID/);
  });

  // Every role array must be the EXACT genuine-N=5 count: a 5th validator would
  // collide with the user-miner on 8105, a 3rd relay would overlap the RTC range,
  // etc. Guard ALL four arrays, not just cps.
  it.each<[string, (k: MultiCpKeysFile) => void, RegExp]>([
    ['cps', (k) => k.cps.pop(), /cps/i],
    ['validators', (k) => k.validators.pop(), /validators/i],
    ['relays', (k) => k.relays.pop(), /relays/i],
    ['signaling', (k) => k.signaling.pop(), /signaling/i],
  ])('throws when the %s array is not the genuine N=5 substrate count', (_label, mutate, pattern) => {
    const wrong = fakeKeys();
    mutate(wrong);
    expect(() => buildLaunchPlan(wrong, USER_MINER_KEY, baseCfgEnv())).toThrow(pattern);
  });
});

describe('mergeChildEnv — env scrub + layer (the only safety-critical behavior)', () => {
  it('keeps a leaked VALIDATOR_CAP_ID off the user-miner (which sets no cap)', () => {
    const um = byName(plan(), 'user-miner');
    const inherited: NodeJS.ProcessEnv = { PATH: '/usr/bin', VALIDATOR_CAP_ID: '0xleaked_from_seed_step' };
    const merged = mergeChildEnv(inherited, um);
    expect('VALIDATOR_CAP_ID' in merged).toBe(false); // scrubbed, and the spec never re-sets it
    expect(merged['SUI_PRIVATE_KEY']).toBe(USER_MINER_KEY);
    expect(merged['REGISTRATION_MODE']).toBe('voting'); // user-miner re-sets its own
    expect(merged['PATH']).toBe('/usr/bin'); // non-identity inherited vars pass through
  });

  it('keeps a leaked REGISTRATION_MODE=voting off a pre-registered infra validator', () => {
    const val = byName(plan(), 'val-0');
    const merged = mergeChildEnv({ REGISTRATION_MODE: 'voting' }, val);
    // val-0 must NOT inherit voting mode — it is pre-registered infra (cap set).
    expect('REGISTRATION_MODE' in merged).toBe(false);
    expect(merged['VALIDATOR_CAP_ID']).toBe(fakeKeys().validators[0]!.capId);
  });

  it('overrides a leaked CP_KEYPAIR with the cp spec own identity (scrubbed then set)', () => {
    const cp = byName(plan(), 'cp-2');
    const merged = mergeChildEnv({ CP_KEYPAIR: '0xleaked', CP_CAP_ID: '0xleaked' }, cp);
    expect(merged['CP_KEYPAIR']).toBe(fakeKeys().cps[2]!.secretKey); // its OWN key, not the leak
    expect(merged['CP_CAP_ID']).toBe(fakeKeys().cps[2]!.capId);
  });
});

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
    signaling_id: addr(30),
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
