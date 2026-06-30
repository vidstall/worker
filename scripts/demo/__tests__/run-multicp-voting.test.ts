import { describe, it, expect } from 'vitest';
import { isAbsolute, join } from 'node:path';
import { buildLaunchPlan, mergeChildEnv, type ProcessSpec } from '../run-multicp-voting.ts';
// TYPE-ONLY imports — elided at runtime so neither seed-multicp.ts nor
// seed-bootstrap.ts (both call main() at module top-level WITHOUT an argv guard)
// executes when this test loads.
import type { MultiCpKeysFile } from '../seed-multicp.ts';
import type { SeededKey } from '../seed-bootstrap.ts';

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
