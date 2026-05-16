/**
 * RED test for the bench replay aggregator — S23.2.B1.
 *
 * Locks the grouping + percentile + INSUFFICIENT_SAMPLES behaviour. Loading
 * from disk (`loadTrace`) is exercised end-to-end through a tmp dir to cover
 * the file-scan + JSONL parse paths the CLI relies on.
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.B1
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §5
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LatencyEvent, LatencyMetric, LatencySource } from '@dvconf/shared';
import {
  aggregateEvents,
  percentile,
  formatCsv,
  parseArgs,
  loadTrace,
  INSUFFICIENT_SAMPLES_THRESHOLD,
} from '../replay.js';

function makeEvent(
  metric: LatencyMetric,
  source: LatencySource,
  value_ms: number,
): LatencyEvent {
  return {
    schema_version: '1.0',
    ts: 1747500000000,
    trace_id: 'test-trace',
    scenario: 'adhoc',
    source,
    instance: 'test',
    metric,
    value_ms,
  };
}

describe('percentile (nearest-rank)', () => {
  it('p=0.5 of [10,20,30,40,50] = 30', () => {
    expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
  });

  it('p=0.95 of [10,20,30,40,50] = 50', () => {
    expect(percentile([10, 20, 30, 40, 50], 0.95)).toBe(50);
  });

  it('p=0.5 of [1..10] = 5', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(5);
  });

  it('p=0.99 of 100 ordered samples = sorted[98]', () => {
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.99)).toBe(99);
  });
});

describe('aggregateEvents', () => {
  it('groups events by (metric, source)', () => {
    const events: LatencyEvent[] = [
      makeEvent('L_relay_fwd', 'relay', 5),
      makeEvent('L_relay_fwd', 'relay', 10),
      makeEvent('L_sig_rtt', 'signaling', 20),
    ];
    const rows = aggregateEvents(events);
    expect(rows).toHaveLength(2);
    const relay = rows.find((r) => r.metric === 'L_relay_fwd' && r.source === 'relay');
    expect(relay?.n).toBe(2);
    const sig = rows.find((r) => r.metric === 'L_sig_rtt' && r.source === 'signaling');
    expect(sig?.n).toBe(1);
  });

  it('computes percentiles for n >= 5 with 15-event fixture (3 metrics x 5 samples)', () => {
    const events: LatencyEvent[] = [];
    for (const v of [10, 20, 30, 40, 50]) events.push(makeEvent('L_relay_fwd', 'relay', v));
    for (const v of [100, 200, 300, 400, 500]) events.push(makeEvent('L_sig_rtt', 'signaling', v));
    for (const v of [1, 2, 3, 4, 5]) events.push(makeEvent('L_cp_score', 'cp-daemon', v));

    const rows = aggregateEvents(events);
    expect(rows).toHaveLength(3);

    const relay = rows.find((r) => r.metric === 'L_relay_fwd')!;
    expect(relay).toMatchObject({
      n: 5,
      p50: 30,
      p95: 50,
      p99: 50,
      mean: 30,
      min: 10,
      max: 50,
      note: null,
    });

    const sig = rows.find((r) => r.metric === 'L_sig_rtt')!;
    expect(sig).toMatchObject({
      n: 5,
      p50: 300,
      p95: 500,
      mean: 300,
      min: 100,
      max: 500,
    });

    const cp = rows.find((r) => r.metric === 'L_cp_score')!;
    expect(cp).toMatchObject({ n: 5, p50: 3, p95: 5, mean: 3, min: 1, max: 5 });
  });

  it(`returns null percentiles + INSUFFICIENT_SAMPLES note when n < ${INSUFFICIENT_SAMPLES_THRESHOLD}`, () => {
    const events: LatencyEvent[] = [
      makeEvent('L_relay_fwd', 'relay', 5),
      makeEvent('L_relay_fwd', 'relay', 10),
      makeEvent('L_relay_fwd', 'relay', 15),
    ];
    const rows = aggregateEvents(events);
    expect(rows[0]).toMatchObject({
      n: 3,
      p50: null,
      p95: null,
      p99: null,
      mean: 10,
      min: 5,
      max: 15,
      note: 'INSUFFICIENT_SAMPLES',
    });
  });

  it('exposes min/max even for n=1 (single sample)', () => {
    const rows = aggregateEvents([makeEvent('L_relay_fwd', 'relay', 42)]);
    expect(rows[0]).toMatchObject({ n: 1, mean: 42, min: 42, max: 42, p50: null });
  });

  it('sorts output by metric then source', () => {
    const events: LatencyEvent[] = [
      makeEvent('L_sig_rtt', 'signaling', 1),
      makeEvent('L_relay_fwd', 'relay', 1),
      makeEvent('L_cp_score', 'cp-daemon', 1),
    ];
    const rows = aggregateEvents(events);
    expect(rows.map((r) => r.metric)).toEqual([
      'L_cp_score',
      'L_relay_fwd',
      'L_sig_rtt',
    ]);
  });

  it('separates same metric from different sources into distinct rows', () => {
    const events: LatencyEvent[] = [
      makeEvent('L_g2g_optB', 'client', 50),
      makeEvent('L_g2g_optB', 'client', 60),
      makeEvent('L_relay_fwd', 'relay', 5),
    ];
    const rows = aggregateEvents(events);
    expect(rows).toHaveLength(2);
  });
});

describe('formatCsv', () => {
  it('emits header + per-row CSV with empty cells for null percentiles', () => {
    const rows = aggregateEvents([makeEvent('L_relay_fwd', 'relay', 5)]);
    const csv = formatCsv(rows);
    expect(csv.startsWith('metric,source,n,p50,p95,p99,mean,min,max,note\n')).toBe(true);
    expect(csv).toContain('L_relay_fwd,relay,1,,,,5.00,5.00,5.00,INSUFFICIENT_SAMPLES');
  });

  it('emits filled percentile cells when n >= threshold', () => {
    const events: LatencyEvent[] = [];
    for (const v of [10, 20, 30, 40, 50]) events.push(makeEvent('L_relay_fwd', 'relay', v));
    const csv = formatCsv(aggregateEvents(events));
    expect(csv).toContain('L_relay_fwd,relay,5,30.00,50.00,50.00,30.00,10.00,50.00,');
  });
});

describe('parseArgs', () => {
  it('extracts trace id as positional + --csv as flag', () => {
    const args = parseArgs(['node', 'replay.ts', 'abc-123', '--csv', 'out.csv']);
    expect(args).toEqual({
      traceId: 'abc-123',
      csvPath: 'out.csv',
      outputDir: 'bench-output',
    });
  });

  it('honours --output-dir override', () => {
    const args = parseArgs([
      'node',
      'replay.ts',
      'abc',
      '--output-dir',
      '/tmp/custom',
    ]);
    expect(args.outputDir).toBe('/tmp/custom');
  });

  it('throws when trace id is missing', () => {
    expect(() => parseArgs(['node', 'replay.ts', '--csv', 'out.csv'])).toThrow();
  });
});

describe('loadTrace (file-scan + JSONL parse)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bench-replay-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads every file whose name ends with -<traceId>.jsonl', () => {
    const traceId = 'fixture-1';
    writeFileSync(
      join(dir, `s-baseline-relay-${traceId}.jsonl`),
      JSON.stringify(makeEvent('L_relay_fwd', 'relay', 5)) + '\n',
    );
    writeFileSync(
      join(dir, `s-baseline-signaling-${traceId}.jsonl`),
      JSON.stringify(makeEvent('L_sig_rtt', 'signaling', 7)) + '\n',
    );
    writeFileSync(
      join(dir, `s-baseline-relay-other-trace.jsonl`),
      JSON.stringify(makeEvent('L_relay_fwd', 'relay', 99)) + '\n',
    );

    const events = loadTrace(dir, traceId);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.value_ms).sort()).toEqual([5, 7]);
  });

  it('skips malformed lines and tolerates trailing blank lines', () => {
    const traceId = 'fixture-2';
    const path = join(dir, `s-baseline-relay-${traceId}.jsonl`);
    const content =
      JSON.stringify(makeEvent('L_relay_fwd', 'relay', 5)) +
      '\n' +
      'not-json-line\n' +
      JSON.stringify(makeEvent('L_relay_fwd', 'relay', 10)) +
      '\n\n';
    writeFileSync(path, content);

    const events = loadTrace(dir, traceId);
    expect(events).toHaveLength(2);
  });

  it('returns [] for a non-existent output directory (CLI passes through to error message)', () => {
    expect(loadTrace(join(dir, 'does-not-exist'), 'whatever')).toEqual([]);
  });

  it('returns [] for an empty matching directory', () => {
    mkdirSync(join(dir, 'empty'), { recursive: true });
    expect(loadTrace(join(dir, 'empty'), 'whatever')).toEqual([]);
  });
});
