import { describe, it, expect } from 'vitest';
import {
  analyzeP2FromJsonl,
  mulberry32,
  DEFAULT_SEED,
} from '../p2-block-analysis';
import { RESIDUAL_MS } from '../join-g2g.js';

// ── synthetic fixture ────────────────────────────────────────────────
// One session = six raw rows (send: encode+rtt; recv: rtt+jb+decode+present).
// With encode=8, rtt_send=30, rtt_recv=28, decode=4, present=9 the estimator is
//   oneWay = 8 + 30/2 + 28/2 + jb + 4 + 9 + 12.5 = 62.5 + jb   (RESIDUAL_MS = 12.5)
// so jb alone controls the per-session value.
const ev = (room: string, flow: string, direction: 'send' | 'recv', metric: string, value: number): string =>
  JSON.stringify({
    schema_version: '1.0', ts: 1, trace_id: 'p2wan-test', scenario: 's-wan', source: 'client',
    instance: direction === 'send' ? 'produce-0' : 'consume-0', metric, value_ms: value,
    context: {
      room_id: room, flow_id: flow, direction,
      peer_id: direction === 'send' ? 'produce-0' : 'consume-0',
    },
  });

const sessionLines = (room: string, jb: number, flow = `flow-${room}`): string[] => [
  ev(room, flow, 'send', 'L_encode', 8),
  ev(room, flow, 'send', 'L_rtt_send', 30),
  ev(room, flow, 'recv', 'L_rtt_recv', 28),
  ev(room, flow, 'recv', 'L_jitterbuffer', jb),
  ev(room, flow, 'recv', 'L_decode', 4),
  ev(room, flow, 'recv', 'L_present', 9),
];

// 2 blocks x (5 OFF + 5 ON); OFF session i -> 82.5+i ms, ON session i -> 86.5+i ms
// (a clean +4 ms ON-OFF shift, identical across blocks).
const mainFixture = (): string => {
  const lines: string[] = [];
  for (const b of [0, 1]) {
    for (const arm of ['off', 'on'] as const) {
      for (let i = 0; i < 5; i += 1) {
        lines.push(...sessionLines(`p2b${b}${arm}-${i}`, (arm === 'off' ? 20 : 24) + i));
      }
    }
  }
  return `${lines.join('\n')}\n`;
};

describe('RESIDUAL_MS anchor', () => {
  it('the fixture math assumes the predeclared 12.5 ms residual', () => {
    expect(RESIDUAL_MS).toBe(12.5);
  });
});

describe('mulberry32', () => {
  it('is deterministic for a seed and in [0,1)', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
    for (const x of seqA) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1); }
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });
});

describe('analyzeP2FromJsonl — per-arm and per-block statistics', () => {
  const report = analyzeP2FromJsonl(mainFixture());

  it('computes per-arm n / p50 / p95 / p99 / mean / sd (nearest-rank, sample sd)', () => {
    const { off, on } = report.perArm;
    // OFF pool (both blocks): [82.5, 82.5, 83.5, 83.5, 84.5, 84.5, 85.5, 85.5, 86.5, 86.5]
    expect(off.n).toBe(10);
    expect(off.p50).toBe(84.5);   // nearest-rank: ceil(0.5*10)=5 -> sorted[4]
    expect(off.p95).toBe(86.5);   // ceil(9.5)=10 -> sorted[9]
    expect(off.p99).toBe(86.5);
    expect(off.mean).toBeCloseTo(84.5, 10);
    expect(off.sd).toBeCloseTo(Math.sqrt(20 / 9), 10); // sample sd, n-1
    // ON pool = OFF + 4 ms exactly
    expect(on.n).toBe(10);
    expect(on.p50).toBe(88.5);
    expect(on.p95).toBe(90.5);
    expect(on.p99).toBe(90.5);
    expect(on.mean).toBeCloseTo(88.5, 10);
    expect(on.sd).toBeCloseTo(off.sd, 10);
  });

  it('computes per-block medians and per-block ON-OFF deltas', () => {
    expect(report.blocks).toEqual([0, 1]);
    expect(report.perBlock).toHaveLength(2);
    for (const row of report.perBlock) {
      expect(row.nOff).toBe(5);
      expect(row.nOn).toBe(5);
      expect(row.medianOffMs).toBe(84.5);
      expect(row.medianOnMs).toBe(88.5);
      expect(row.deltaMedianOnMinusOffMs).toBeCloseTo(4, 10);
    }
  });

  it('computes the primary unpaired ON-OFF deltas', () => {
    expect(report.delta.dMeanMs).toBeCloseTo(4, 10);
    expect(report.delta.dP95Ms).toBeCloseTo(4, 10);
  });

  it('bootstrap CI brackets the true +4 ms shift and excludes 0', () => {
    const { dMeanMs, dP95Ms } = report.bootstrap.ci95;
    expect(dMeanMs.lo).toBeLessThanOrEqual(4);
    expect(dMeanMs.hi).toBeGreaterThanOrEqual(4);
    expect(dMeanMs.lo).toBeGreaterThan(0); // clean separation in the synthetic data
    expect(dP95Ms.lo).toBeLessThanOrEqual(4);
    expect(dP95Ms.hi).toBeGreaterThanOrEqual(4);
    expect(report.bootstrap.iterations).toBe(10_000);
    expect(report.bootstrap.seed).toBe(DEFAULT_SEED);
  });
});

describe('analyzeP2FromJsonl — seeded bootstrap replay', () => {
  it('two invocations with the same seed are byte-identical (whole report)', () => {
    const raw = mainFixture();
    const a = analyzeP2FromJsonl(raw, 20260716);
    const b = analyzeP2FromJsonl(raw, 20260716);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('input line order does not change the result (strata are roomId-sorted)', () => {
    const raw = mainFixture();
    const shuffled = `${raw.trim().split('\n').reverse().join('\n')}\n`;
    const a = analyzeP2FromJsonl(raw, 20260716);
    const b = analyzeP2FromJsonl(shuffled, 20260716);
    expect(JSON.stringify(a.bootstrap)).toBe(JSON.stringify(b.bootstrap));
    expect(JSON.stringify(a.perArm)).toBe(JSON.stringify(b.perArm));
  });
});

describe('analyzeP2FromJsonl — room taxonomy edges', () => {
  it('counts makeup rooms (p2b<b><arm>m-<j>) into their block/arm stratum', () => {
    const lines: string[] = [];
    for (let i = 0; i < 5; i += 1) lines.push(...sessionLines(`p2b0off-${i}`, 20 + i));
    for (let i = 0; i < 4; i += 1) lines.push(...sessionLines(`p2b0on-${i}`, 24 + i)); // only 4 regular ON
    lines.push(...sessionLines('p2b0onm-0', 28)); // 5th valid ON session arrives as a MAKEUP
    const report = analyzeP2FromJsonl(`${lines.join('\n')}\n`);
    expect(report.perArm.on.n).toBe(5);
    expect(report.perBlock[0]!.nOn).toBe(5);
    expect(report.perBlock[0]!.medianOnMs).toBe(88.5);
  });

  it('excludes canary/wan-* rooms from the arms and lists them as ignored', () => {
    const lines = [
      ...mainFixture().trim().split('\n'),
      ...sessionLines('wan-3', 50), // complete session in a HISTORICAL room -> ignored, not pooled
    ];
    const report = analyzeP2FromJsonl(`${lines.join('\n')}\n`);
    expect(report.input.ignoredRooms).toEqual(['wan-3']);
    expect(report.perArm.off.n).toBe(10); // unchanged
    expect(report.perArm.on.n).toBe(10);
  });

  it('lists P2 rooms that produced no valid session (invalid = retained + listed, never silently used)', () => {
    const lines = [
      ...mainFixture().trim().split('\n'),
      // send-only makeup room: incomplete component set -> join drops it -> invalid
      ev('p2b1offm-9', 'flow-invalid', 'send', 'L_encode', 8),
      ev('p2b1offm-9', 'flow-invalid', 'send', 'L_rtt_send', 30),
    ];
    const report = analyzeP2FromJsonl(`${lines.join('\n')}\n`);
    expect(report.input.invalidP2Rooms).toEqual(['p2b1offm-9']);
    expect(report.perArm.off.n).toBe(10); // gate still satisfied by the 5 valid block-1 OFF sessions
  });

  it('fails loudly when one room assembles to more than one flow (sample-unit violation)', () => {
    const lines = [
      ...mainFixture().trim().split('\n'),
      ...sessionLines('p2b0off-0', 21, 'flow-second'), // SECOND flow in an existing room
    ];
    expect(() => analyzeP2FromJsonl(`${lines.join('\n')}\n`)).toThrow('SAMPLE-UNIT VIOLATION');
  });
});

describe('analyzeP2FromJsonl — incomplete-block failure path', () => {
  it('fails loudly when a block has fewer than 5 valid sessions in one arm, naming it', () => {
    const lines: string[] = [];
    for (const b of [0, 1]) {
      for (const arm of ['off', 'on'] as const) {
        const n = b === 1 && arm === 'on' ? 4 : 5; // block 1 ON is one session short
        for (let i = 0; i < n; i += 1) {
          lines.push(...sessionLines(`p2b${b}${arm}-${i}`, (arm === 'off' ? 20 : 24) + i));
        }
      }
    }
    const raw = `${lines.join('\n')}\n`;
    expect(() => analyzeP2FromJsonl(raw)).toThrow(/INCOMPLETE BLOCKS/);
    expect(() => analyzeP2FromJsonl(raw)).toThrow(/block 1 arm on: 4 valid session\(s\) < 5/);
  });

  it('fails loudly when a block is entirely missing one arm (n=0 deficit)', () => {
    const lines: string[] = [];
    for (const b of [0, 1]) {
      for (const arm of ['off', 'on'] as const) {
        for (let i = 0; i < 5; i += 1) {
          lines.push(...sessionLines(`p2b${b}${arm}-${i}`, (arm === 'off' ? 20 : 24) + i));
        }
      }
    }
    for (let i = 0; i < 5; i += 1) lines.push(...sessionLines(`p2b2off-${i}`, 20 + i)); // block 2: OFF only
    expect(() => analyzeP2FromJsonl(`${lines.join('\n')}\n`))
      .toThrow(/block 2 arm on: 0 valid session\(s\) < 5/);
  });

  it('fails loudly on an empty input', () => {
    expect(() => analyzeP2FromJsonl('')).toThrow('no valid P2 sessions');
  });
});
