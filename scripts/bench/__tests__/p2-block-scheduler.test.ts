import { describe, it, expect } from 'vitest';
import {
  SUB_RUNS,
  SESSIONS_PER_SUB_RUN,
  armFor,
  computeSchedule,
  computeMakeupRuns,
  parseMakeupSpec,
  parseSchedulerArgs,
} from '../p2-block-scheduler';

const BASE = 1_800_000_000_000;
const WINDOW = 25_000;
const GAP = 60_000;
const SLOT = SESSIONS_PER_SUB_RUN * WINDOW + GAP; // 185_000

describe('computeSchedule — the 12 predeclared sub-runs', () => {
  const sched = computeSchedule(BASE, WINDOW, GAP);

  it('yields exactly 12 sub-runs, blocks 0..5, 5 sessions each, none makeup', () => {
    expect(sched).toHaveLength(SUB_RUNS);
    expect(sched.map((r) => r.s)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(sched.map((r) => r.block)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    expect(sched.every((r) => r.sessions === 5)).toBe(true);
    expect(sched.every((r) => !r.makeup)).toBe(true);
  });

  it('alternates within-block arm order: OFF->ON, ON->OFF, OFF->ON, ON->OFF, OFF->ON, ON->OFF', () => {
    expect(sched.map((r) => r.arm)).toEqual([
      'off', 'on', // block 0
      'on', 'off', // block 1
      'off', 'on', // block 2
      'on', 'off', // block 3
      'off', 'on', // block 4
      'on', 'off', // block 5
    ]);
    // per-block totals stay balanced: every block has exactly one OFF and one ON sub-run
    for (let b = 0; b < 6; b += 1) {
      const arms = sched.filter((r) => r.block === b).map((r) => r.arm).sort();
      expect(arms).toEqual(['off', 'on']);
    }
  });

  it('armFor matches the table for every s', () => {
    expect([...Array(12).keys()].map((s) => armFor(s))).toEqual(sched.map((r) => r.arm));
  });

  it('computes subRunStart(s) = baseEpoch + s * (5*windowMs + gapMs)', () => {
    for (const r of sched) {
      expect(r.startEpochMs).toBe(BASE + r.s * SLOT);
    }
    expect(sched[11]!.startEpochMs).toBe(BASE + 11 * 185_000);
  });

  it('derives room prefixes p2b<block><arm>- (never wan-*)', () => {
    expect(sched[0]!.roomPrefix).toBe('p2b0off-');
    expect(sched[1]!.roomPrefix).toBe('p2b0on-');
    expect(sched[2]!.roomPrefix).toBe('p2b1on-');
    expect(sched[3]!.roomPrefix).toBe('p2b1off-');
    expect(sched[8]!.roomPrefix).toBe('p2b4off-');
    expect(sched[11]!.roomPrefix).toBe('p2b5off-');
    expect(sched.some((r) => r.roomPrefix.startsWith('wan'))).toBe(false);
  });

  it('is a pure function of the anchor: both machines derive the identical schedule', () => {
    expect(computeSchedule(BASE, WINDOW, GAP)).toEqual(computeSchedule(BASE, WINDOW, GAP));
  });
});

describe('computeMakeupRuns', () => {
  it('appends makeups after the 12 main slots, argv order, with m-marked room prefixes', () => {
    const makeups = computeMakeupRuns(BASE, WINDOW, GAP, [
      { block: 3, arm: 'on', count: 2 },
      { block: 0, arm: 'off', count: 1 },
    ]);
    expect(makeups).toHaveLength(2);
    expect(makeups[0]).toEqual({
      s: 12, block: 3, arm: 'on', startEpochMs: BASE + 12 * SLOT,
      sessions: 2, roomPrefix: 'p2b3onm-', makeup: true,
    });
    expect(makeups[1]).toEqual({
      s: 13, block: 0, arm: 'off', startEpochMs: BASE + 13 * SLOT,
      sessions: 1, roomPrefix: 'p2b0offm-', makeup: true,
    });
  });

  it('yields no runs for no makeups', () => {
    expect(computeMakeupRuns(BASE, WINDOW, GAP, [])).toEqual([]);
  });
});

describe('parseMakeupSpec', () => {
  it('parses <block>:<arm>:<count>', () => {
    expect(parseMakeupSpec('3:on:2')).toEqual({ block: 3, arm: 'on', count: 2 });
    expect(parseMakeupSpec('0:off:1')).toEqual({ block: 0, arm: 'off', count: 1 });
  });

  it('rejects out-of-range block, bad arm, and counts beyond the plan cap of 2', () => {
    expect(() => parseMakeupSpec('6:on:1')).toThrow('--makeup');
    expect(() => parseMakeupSpec('1:ON:1')).toThrow('--makeup');
    expect(() => parseMakeupSpec('1:on:3')).toThrow('--makeup');
    expect(() => parseMakeupSpec('1:on:0')).toThrow('--makeup');
    expect(() => parseMakeupSpec('on:1:1')).toThrow('--makeup');
  });
});

describe('parseSchedulerArgs', () => {
  const required = [
    '--role', 'produce',
    '--base-epoch', String(BASE),
    '--relay', 'ws://10.0.0.4:4000',
    '--bench', 'http://10.0.0.4:8081',
    '--page', 'http://localhost:5173/bench/wan-measure-page.html',
  ];

  it('parses the full flag set with defaults window=25000 gap=60000', () => {
    const o = parseSchedulerArgs(required);
    expect(o).toEqual({
      role: 'produce',
      baseEpochMs: BASE,
      windowMs: 25_000,
      gapMs: 60_000,
      relay: 'ws://10.0.0.4:4000',
      bench: 'http://10.0.0.4:8081',
      page: 'http://localhost:5173/bench/wan-measure-page.html',
      makeups: [],
    });
  });

  it('collects repeated --makeup flags in argv order', () => {
    const o = parseSchedulerArgs([...required, '--makeup', '3:on:2', '--makeup', '1:off:1']);
    expect(o.makeups).toEqual([
      { block: 3, arm: 'on', count: 2 },
      { block: 1, arm: 'off', count: 1 },
    ]);
  });

  it('requires role/base-epoch/relay/bench/page — no silent localhost fallbacks', () => {
    expect(() => parseSchedulerArgs([])).toThrow('--role is REQUIRED');
    expect(() => parseSchedulerArgs(['--role', 'produce'])).toThrow('--base-epoch');
    expect(() => parseSchedulerArgs(['--role', 'produce', '--base-epoch', String(BASE)]))
      .toThrow('--relay is REQUIRED');
  });

  it('rejects bad roles, duplicate flags, unknown flags, and non-integer epochs', () => {
    expect(() => parseSchedulerArgs(required.map((v) => (v === 'produce' ? 'observer' : v))))
      .toThrow('--role must be produce or consume');
    expect(() => parseSchedulerArgs([...required, '--role', 'consume'])).toThrow('duplicate option: --role');
    expect(() => parseSchedulerArgs([...required, '--sessions', '5'])).toThrow('unknown option: --sessions');
    expect(() => parseSchedulerArgs([...required, '--window-ms', '25s'])).toThrow('strict non-negative integer');
    expect(() => parseSchedulerArgs(['--role', 'produce', '--base-epoch', '-5', ...required.slice(4)]))
      .toThrow('--base-epoch');
  });
});
