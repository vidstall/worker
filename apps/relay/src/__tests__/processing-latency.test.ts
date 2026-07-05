/**
 * Unit tests for the REQ-WLM-08 relay-processing-latency pure helpers.
 *
 * These pin the correlation + summary math used by the hermetic bench
 * (`processing-latency-bench.integration.test.ts`). Pure functions only — no
 * mediasoup, runs in the hermetic unit suite (`pnpm test`).
 */
import { describe, it, expect } from 'vitest';
import {
  percentile,
  correlateForwardLatency,
  summarizeProcessingLatency,
} from '../processing-latency.js';

describe('percentile (nearest-rank, fraction — mirrors scripts/bench/replay.ts)', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  it('p50 = nearest-rank ceil(0.5*10)=5 -> sorted[4] = 50', () => {
    expect(percentile(sorted, 0.5)).toBe(50);
  });
  it('p90 = ceil(9)=9 -> sorted[8] = 90', () => {
    expect(percentile(sorted, 0.9)).toBe(90);
  });
  it('p95 = ceil(9.5)=10 -> sorted[9] = 100', () => {
    expect(percentile(sorted, 0.95)).toBe(100);
  });
});

describe('correlateForwardLatency — match recv events to send timestamps by counter', () => {
  it('returns recvMs - sendMs for matched counters, in recv order, skipping unmatched', () => {
    const sendAt = new Map<number, number>([
      [1, 100],
      [2, 200],
      [3, 300],
    ]);
    const deltas = correlateForwardLatency(sendAt, [
      { counter: 2, recvMs: 200.5 }, // matched -> 0.5
      { counter: 9, recvMs: 999 }, // unmatched -> skipped
      { counter: 1, recvMs: 101 }, // matched -> 1
    ]);
    expect(deltas).toEqual([0.5, 1]);
  });

  it('empty recv -> empty deltas', () => {
    expect(correlateForwardLatency(new Map(), [])).toEqual([]);
  });
});

describe('summarizeProcessingLatency', () => {
  it('sorts then reports n/min/max/mean/p50/p95/p99 (input order irrelevant)', () => {
    const s = summarizeProcessingLatency([3, 1, 2]);
    expect(s.n).toBe(3);
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.mean).toBeCloseTo(2, 10);
    expect(s.p50).toBe(2); // ceil(0.5*3)=2 -> sorted[1]
    expect(s.p95).toBe(3); // ceil(2.85)=3 -> sorted[2]
    expect(s.p99).toBe(3);
  });

  it('empty input -> n=0', () => {
    expect(summarizeProcessingLatency([]).n).toBe(0);
  });
});
