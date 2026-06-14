/**
 * P17 M2a-P10 — cp-daemon health signals (REQ-DOH-014 / DOH-017).
 *
 * The CP's two F61 signals map a synthetic sample to the right level through the
 * `@dvconf/health-monitor` machine: RPC error rate (queryEvents failures / total)
 * + event lag (now - newest polled event ts). Readers consume an injected `deps`
 * bag (the real attach points — the index.ts:457 queryEvents catch + the
 * EventPoller cursor age — are wired in P11). Thresholds come from
 * `readSignalThresholds` so an env override re-maps the level (DOH-017).
 */

import { describe, it, expect, vi } from 'vitest';
import { HealthMonitor, type DegradationReporter, type ThresholdEnv } from '@dvconf/health-monitor';
import { buildHealthSignals, DEFAULT_THRESHOLDS, type CpHealthDeps } from '../health-signals.js';

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

function deps(over: Partial<CpHealthDeps> = {}): CpHealthDeps {
  return { getRpcErrorRate: () => 0, getEventLagMs: () => 0, ...over };
}

async function levelFor(d: CpHealthDeps, env: ThresholdEnv = {}): Promise<number> {
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(d, env),
    reporter: mockReporter(),
    logger: mockLogger(),
  });
  await monitor.tick();
  return monitor.level;
}

describe('cp-daemon health-signals (P10)', () => {
  it('exposes exactly the rpc_error_rate + event_lag signals', () => {
    expect(buildHealthSignals(deps(), {}).map((s) => s.name)).toEqual(['rpc_error_rate', 'event_lag']);
  });

  it('DEFAULT_THRESHOLDS = placeholder RPC 0.10/0.30 + lag 30s/120s (OQ-DOH-3)', () => {
    expect(DEFAULT_THRESHOLDS.RPC_ERROR_RATE).toEqual({ degradedAt: 0.1, unhealthyAt: 0.3 });
    expect(DEFAULT_THRESHOLDS.EVENT_LAG_MS).toEqual({ degradedAt: 30000, unhealthyAt: 120000 });
  });

  it('all-nominal => healthy (level 0)', async () => {
    expect(await levelFor(deps())).toBe(0);
  });

  it('rpc error rate maps to the right level (fractional thresholds)', async () => {
    expect(await levelFor(deps({ getRpcErrorRate: () => 0.15 }))).toBe(1);
    expect(await levelFor(deps({ getRpcErrorRate: () => 0.4 }))).toBe(2);
    expect(await levelFor(deps({ getRpcErrorRate: () => 0.05 }))).toBe(0);
  });

  it('event lag maps to the right level (ms thresholds)', async () => {
    expect(await levelFor(deps({ getEventLagMs: () => 60000 }))).toBe(1);
    expect(await levelFor(deps({ getEventLagMs: () => 200000 }))).toBe(2);
  });

  it('worst-wins MAX across signals', async () => {
    expect(await levelFor(deps({ getRpcErrorRate: () => 0.05, getEventLagMs: () => 200000 }))).toBe(2);
  });

  it('env override lowers the RPC unhealthy bound (DOH-017)', async () => {
    expect(await levelFor(deps({ getRpcErrorRate: () => 0.2 }), {})).toBe(1);
    expect(await levelFor(deps({ getRpcErrorRate: () => 0.2 }), { CP_UNHEALTHY_RPC_ERROR_RATE: '0.15' })).toBe(2);
  });
});
