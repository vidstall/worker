import { describe, it, expect } from 'vitest';
import { buildSessionUrl, parseArgs } from '../wan-split-driver';

// Base opts mirror wan-split-driver.e2ee.test.ts; only roomPrefix varies here.
const base = {
  role: 'produce' as const,
  relayPin: null as 'standby' | null,
  distinguishable: false,
  startEpochMs: 1,
  windowMs: 25000,
  teardownMs: 2000,
  sessions: 1,
  pageBase: 'http://localhost:5173/bench/wan-measure-page.html',
  relay: 'ws://localhost:4000',
  bench: 'http://localhost:8081',
  realCamera: false,
  peerPrefix: 'produce',
  e2ee: 'off' as const,
  roomOverride: null as string | null,
  roomPrefix: 'wan-',
};

describe('wan-split-driver --room-prefix parsing', () => {
  const required = ['--role', 'produce', '--start-epoch', '1'];

  it('defaults to "wan-" when the flag is absent (legacy callers unchanged)', () => {
    expect(parseArgs(required).roomPrefix).toBe('wan-');
  });

  it('parses --room-prefix p2b0off-', () => {
    expect(parseArgs([...required, '--room-prefix', 'p2b0off-']).roomPrefix).toBe('p2b0off-');
  });

  it('rejects an empty prefix (bare-number rooms would drop arm/block encoding)', () => {
    expect(() => parseArgs([...required, '--room-prefix', ''])).toThrow('--room-prefix must be a non-empty string');
  });

  it('rejects missing and duplicate values like every other flag', () => {
    expect(() => parseArgs([...required, '--room-prefix', '--sessions', '5']))
      .toThrow('--room-prefix requires a value');
    expect(() => parseArgs([...required, '--room-prefix', 'a-', '--room-prefix', 'b-']))
      .toThrow('duplicate option: --room-prefix');
  });
});

describe('wan-split-driver room naming', () => {
  it('default prefix reproduces the historical wan-<i> URL byte-for-byte', () => {
    const u = new URL(buildSessionUrl(base, 3));
    expect(u.searchParams.get('trace')).toBe('wan-3');
    expect(u.searchParams.get('room')).toBe('wan-3');
    expect(u.searchParams.get('peer')).toBe('produce-3');
  });

  it('a P2 prefix names both trace and room p2b<block><arm>-<i>', () => {
    const u = new URL(buildSessionUrl({ ...base, roomPrefix: 'p2b0off-' }, 3));
    expect(u.searchParams.get('trace')).toBe('p2b0off-3');
    expect(u.searchParams.get('room')).toBe('p2b0off-3');
  });

  it('applies to the consume leg identically (both machines derive the same room)', () => {
    const produce = new URL(buildSessionUrl({ ...base, roomPrefix: 'p2b4on-' }, 1));
    const consume = new URL(buildSessionUrl({ ...base, role: 'consume', peerPrefix: 'consume', roomPrefix: 'p2b4on-' }, 1));
    expect(produce.searchParams.get('room')).toBe('p2b4on-1');
    expect(consume.searchParams.get('room')).toBe('p2b4on-1');
  });

  it('roomOverride still pins the JOINED room while the trace keeps the prefix', () => {
    const u = new URL(buildSessionUrl({ ...base, roomPrefix: 'p2b0off-', roomOverride: '0xabc' }, 2));
    expect(u.searchParams.get('room')).toBe('0xabc');
    expect(u.searchParams.get('trace')).toBe('p2b0off-2');
  });

  it('peer ids stay role-scoped (produce-<i>/consume-<i>): attribution is via room_id, which is unique per arm/block/session', () => {
    // Same peer name recurs across sub-runs, but each sub-run's rooms are
    // distinct (p2b<block><arm>[m]-<i>) and windows are disjoint, and the
    // offline join groups rows STRICTLY by (context.room_id, context.flow_id) —
    // flow_id is a fresh mediasoup producer id per session — so peer_id never
    // participates in attribution.
    const off = new URL(buildSessionUrl({ ...base, roomPrefix: 'p2b0off-' }, 0));
    const on = new URL(buildSessionUrl({ ...base, roomPrefix: 'p2b0on-', e2ee: 'on' }, 0));
    expect(off.searchParams.get('peer')).toBe('produce-0');
    expect(on.searchParams.get('peer')).toBe('produce-0');
    expect(off.searchParams.get('room')).not.toBe(on.searchParams.get('room'));
  });
});
