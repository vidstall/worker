/**
 * P17 M2a-P10 — signaling health signals (REQ-DOH-014 / DOH-017).
 *
 * The signaling daemon's two F61 signals map a synthetic sample to the right
 * level through the `@dvconf/health-monitor` machine: WS error rate
 * (ws.on('error') failures / total) + queue depth (MAX ws.bufferedAmount across
 * peerSockets). Readers consume an injected `deps` bag (the real attach points —
 * the index.ts:341 error handler + the index.ts:128 peerSockets map — are wired
 * in P11; the F62 authHook path at index.ts:244 is untouched). Thresholds come
 * from `readSignalThresholds` so an env override re-maps the level (DOH-017).
 */

import { describe, it, expect, vi } from 'vitest';
import { HealthMonitor, type DegradationReporter, type ThresholdEnv } from '@dvconf/health-monitor';
import { buildHealthSignals, DEFAULT_THRESHOLDS, type SignalingHealthDeps } from '../health-signals.js';

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

function mockReporter(): DegradationReporter {
  return { report: vi.fn(async () => true) };
}

function deps(over: Partial<SignalingHealthDeps> = {}): SignalingHealthDeps {
  return { getWsErrorRate: () => 0, getMaxBufferedAmount: () => 0, ...over };
}

async function levelFor(d: SignalingHealthDeps, env: ThresholdEnv = {}): Promise<number> {
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(d, env),
    reporter: mockReporter(),
    logger: mockLogger(),
  });
  await monitor.tick();
  return monitor.level;
}

describe('signaling health-signals (P10)', () => {
  it('exposes exactly the ws_error_rate + queue_depth signals', () => {
    expect(buildHealthSignals(deps(), {}).map((s) => s.name)).toEqual(['ws_error_rate', 'queue_depth']);
  });

  it('DEFAULT_THRESHOLDS = placeholder WS-err 0.05/0.15 + queue 1MiB/8MiB (OQ-DOH-3)', () => {
    expect(DEFAULT_THRESHOLDS.WS_ERROR_RATE).toEqual({ degradedAt: 0.05, unhealthyAt: 0.15 });
    expect(DEFAULT_THRESHOLDS.QUEUE_DEPTH).toEqual({ degradedAt: 1048576, unhealthyAt: 8388608 });
  });

  it('all-nominal => healthy (level 0)', async () => {
    expect(await levelFor(deps())).toBe(0);
  });

  it('ws error rate maps to the right level (fractional thresholds)', async () => {
    expect(await levelFor(deps({ getWsErrorRate: () => 0.08 }))).toBe(1);
    expect(await levelFor(deps({ getWsErrorRate: () => 0.2 }))).toBe(2);
    expect(await levelFor(deps({ getWsErrorRate: () => 0.01 }))).toBe(0);
  });

  it('queue depth (max bufferedAmount bytes) maps to the right level', async () => {
    expect(await levelFor(deps({ getMaxBufferedAmount: () => 2 * 1024 * 1024 }))).toBe(1);
    expect(await levelFor(deps({ getMaxBufferedAmount: () => 16 * 1024 * 1024 }))).toBe(2);
  });

  it('worst-wins MAX across signals', async () => {
    expect(await levelFor(deps({ getWsErrorRate: () => 0.01, getMaxBufferedAmount: () => 16 * 1024 * 1024 }))).toBe(2);
  });

  it('env override lowers the WS-error degraded bound (DOH-017)', async () => {
    expect(await levelFor(deps({ getWsErrorRate: () => 0.02 }), {})).toBe(0);
    expect(await levelFor(deps({ getWsErrorRate: () => 0.02 }), { SIGNALING_DEGRADED_WS_ERROR_RATE: '0.01' })).toBe(1);
  });
});
