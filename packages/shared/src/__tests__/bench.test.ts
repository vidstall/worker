/**
 * Tests for the latency benchmark harness (Task #26).
 *
 * Focus: JSONL writer correctness (schema_version present, ts monotonic,
 * trace_id stable, file path predictable, idempotent close).
 *
 * Probe wrappers are exercised by exercising `timeAsync` end-to-end against
 * a real writer — the assertion is that one event lands per call with the
 * stated metric name. Smoke run (real daemons) is deferred to #26-followup.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LATENCY_EVENT_SCHEMA_VERSION,
  LatencyWriter,
  appendLatencyEvent,
  isBenchEnabled,
  resolveScenario,
  resolveTraceId,
  timeAsync,
  timeSync,
  type LatencyEvent,
} from '../bench/index.js';

let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dvconf-bench-'));
  delete process.env['BENCH_LATENCY'];
  delete process.env['BENCH_TRACE_ID'];
  delete process.env['BENCH_SCENARIO'];
});

afterEach(() => {
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('isBenchEnabled', () => {
  it('returns false when BENCH_LATENCY unset', () => {
    expect(isBenchEnabled()).toBe(false);
  });

  it('returns true only for the exact string "1"', () => {
    process.env['BENCH_LATENCY'] = '1';
    expect(isBenchEnabled()).toBe(true);
    process.env['BENCH_LATENCY'] = 'true';
    expect(isBenchEnabled()).toBe(false);
    process.env['BENCH_LATENCY'] = '0';
    expect(isBenchEnabled()).toBe(false);
  });
});

describe('resolveTraceId / resolveScenario', () => {
  it('uses BENCH_TRACE_ID when set', () => {
    process.env['BENCH_TRACE_ID'] = 'fixed-trace-id';
    expect(resolveTraceId()).toBe('fixed-trace-id');
  });

  it('generates a uuid-v4 shape when BENCH_TRACE_ID unset', () => {
    const id = resolveTraceId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('defaults scenario to "adhoc" and accepts whitelisted tags', () => {
    expect(resolveScenario()).toBe('adhoc');
    process.env['BENCH_SCENARIO'] = 's-baseline';
    expect(resolveScenario()).toBe('s-baseline');
    process.env['BENCH_SCENARIO'] = 'not-a-real-scenario';
    expect(resolveScenario()).toBe('adhoc');
  });
});

describe('LatencyWriter', () => {
  it('writes one JSONL line per event with all required fields', () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'relay',
      instance: 'relay-test-instance',
      traceId: 'fixed-trace',
      scenario: 'adhoc',
    });

    w.write('L_relay_fwd', 4.2, { room_id: '0xabc', n_peers: 2 });
    w.write('L_relay_fwd', 5.1, { room_id: '0xabc', n_peers: 2 });
    w.close();

    const content = readFileSync(w.getFilePath(), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const parsed: LatencyEvent[] = lines.map((l) => JSON.parse(l));
    for (const ev of parsed) {
      expect(ev.schema_version).toBe(LATENCY_EVENT_SCHEMA_VERSION);
      expect(ev.trace_id).toBe('fixed-trace');
      expect(ev.scenario).toBe('adhoc');
      expect(ev.source).toBe('relay');
      expect(ev.instance).toBe('relay-test-instance');
      expect(ev.metric).toBe('L_relay_fwd');
      expect(typeof ev.ts).toBe('number');
      expect(typeof ev.value_ms).toBe('number');
    }
    expect(parsed[0]!.value_ms).toBeCloseTo(4.2);
    expect(parsed[1]!.value_ms).toBeCloseTo(5.1);
  });

  it('timestamps are monotonic-non-decreasing within one writer', () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'cp-daemon',
      instance: 'cp-1',
      traceId: 'mono',
    });
    for (let i = 0; i < 10; i++) {
      w.write('L_cp_score', i);
    }
    w.close();

    const parsed: LatencyEvent[] = readFileSync(w.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i]!.ts).toBeGreaterThanOrEqual(parsed[i - 1]!.ts);
    }
  });

  it('file path encodes scenario + source + trace', () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'signaling',
      instance: 'sig-1',
      scenario: 's-baseline',
      traceId: 'trace-xyz',
    });
    w.write('L_sig_rtt', 12.3);
    w.close();
    expect(w.getFilePath()).toMatch(/s-baseline-signaling-trace-xyz\.jsonl$/);
  });

  it('close is idempotent', () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'relay',
      instance: 'relay-1',
    });
    w.write('L_relay_fwd', 1);
    expect(() => {
      w.close();
      w.close();
    }).not.toThrow();
  });

  it('clock_skew_warning flag is omitted by default and surfaced when set', () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'validator',
      instance: 'v-1',
    });
    w.write('L_validator_check', 50);
    w.write('L_validator_check', 60, undefined, { clock_skew_warning: true });
    w.close();

    const parsed: LatencyEvent[] = readFileSync(w.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(parsed[0]!.clock_skew_warning).toBeUndefined();
    expect(parsed[1]!.clock_skew_warning).toBe(true);
  });
});

describe('appendLatencyEvent', () => {
  it('appends to an explicit file path', () => {
    const path = join(tmpDir, 'one-shot.jsonl');
    appendLatencyEvent(path, {
      schema_version: LATENCY_EVENT_SCHEMA_VERSION,
      ts: 1000,
      trace_id: 't',
      scenario: 'adhoc',
      source: 'client',
      instance: 'browser-1',
      metric: 'L_g2g_optB',
      value_ms: 180,
    });
    appendLatencyEvent(path, {
      schema_version: LATENCY_EVENT_SCHEMA_VERSION,
      ts: 2000,
      trace_id: 't',
      scenario: 'adhoc',
      source: 'client',
      instance: 'browser-1',
      metric: 'L_g2g_optB',
      value_ms: 190,
    });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

describe('timeAsync / timeSync', () => {
  it('timeSync passes through when writer is null (off-by-default)', () => {
    const wrapped = timeSync(null, 'L_cp_score', (n: number) => n * 2);
    expect(wrapped(3)).toBe(6);
  });

  it('timeSync emits one event per call', () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'cp-daemon',
      instance: 'cp-1',
      traceId: 't',
    });
    const wrapped = timeSync(w, 'L_cp_score', (n: number) => n * 2);
    wrapped(3);
    wrapped(4);
    w.close();
    const events: LatencyEvent[] = readFileSync(w.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.metric === 'L_cp_score')).toBe(true);
  });

  it('timeAsync awaits and still emits on rejection', async () => {
    const w = new LatencyWriter({
      outputDir: tmpDir,
      source: 'cp-daemon',
      instance: 'cp-1',
      traceId: 't',
    });
    const wrapped = timeAsync(w, 'L_cp_score', async (ok: boolean) => {
      if (!ok) throw new Error('boom');
      return 'ok' as const;
    });
    await expect(wrapped(true)).resolves.toBe('ok');
    await expect(wrapped(false)).rejects.toThrow('boom');
    w.close();
    const events: LatencyEvent[] = readFileSync(w.getFilePath(), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
  });
});
