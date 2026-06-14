/**
 * P17 M2a-P10 — validator-daemon health signals (REQ-DOH-014 / DOH-017).
 *
 * The validator's two F61 signals map a synthetic sample to the right level
 * through the `@dvconf/health-monitor` machine: probe RTT ms (rolling avg) +
 * consecutive RTP-unreachable count. Readers consume an injected `deps` bag
 * (the real attach points — `stunProbe` avg RTT, `createRelayProbe`
 * unreachable-sample state — are wired in P11). Thresholds come from
 * `readSignalThresholds` so an env override re-maps the level (DOH-017).
 */

import { describe, it, expect, vi } from 'vitest';
import { HealthMonitor, type DegradationReporter, type ThresholdEnv } from '@dvconf/health-monitor';
import { buildHealthSignals, DEFAULT_THRESHOLDS, type ValidatorHealthDeps } from '../health-signals.js';

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

function deps(over: Partial<ValidatorHealthDeps> = {}): ValidatorHealthDeps {
  return { getRttMs: () => 0, getConsecutiveUnreachable: () => 0, ...over };
}

async function levelFor(d: ValidatorHealthDeps, env: ThresholdEnv = {}): Promise<number> {
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(d, env),
    reporter: mockReporter(),
    logger: mockLogger(),
  });
  await monitor.tick();
  return monitor.level;
}

describe('validator-daemon health-signals (P10)', () => {
  it('exposes exactly the rtt + unreachable signals', () => {
    expect(buildHealthSignals(deps(), {}).map((s) => s.name)).toEqual(['rtt', 'unreachable']);
  });

  it('DEFAULT_THRESHOLDS = placeholder RTT 300/500ms + unreachable 1/3 (OQ-DOH-3)', () => {
    expect(DEFAULT_THRESHOLDS.RTT).toEqual({ degradedAt: 300, unhealthyAt: 500 });
    expect(DEFAULT_THRESHOLDS.UNREACHABLE).toEqual({ degradedAt: 1, unhealthyAt: 3 });
  });

  it('all-nominal => healthy (level 0)', async () => {
    expect(await levelFor(deps())).toBe(0);
  });

  it('rtt maps to the right level via thresholds (300<=L1<500<=L2)', async () => {
    expect(await levelFor(deps({ getRttMs: () => 350 }))).toBe(1);
    expect(await levelFor(deps({ getRttMs: () => 600 }))).toBe(2);
    expect(await levelFor(deps({ getRttMs: () => 100 }))).toBe(0);
  });

  it('consecutive-unreachable: L1 at >=1, L2 at >=3 (2 stays L1)', async () => {
    expect(await levelFor(deps({ getConsecutiveUnreachable: () => 1 }))).toBe(1);
    expect(await levelFor(deps({ getConsecutiveUnreachable: () => 2 }))).toBe(1);
    expect(await levelFor(deps({ getConsecutiveUnreachable: () => 3 }))).toBe(2);
  });

  it('worst-wins MAX across signals', async () => {
    expect(await levelFor(deps({ getRttMs: () => 600, getConsecutiveUnreachable: () => 0 }))).toBe(2);
    expect(await levelFor(deps({ getRttMs: () => 350, getConsecutiveUnreachable: () => 3 }))).toBe(2);
  });

  it('env override lowers the RTT degraded bound (DOH-017)', async () => {
    // default would map 150ms => healthy; override degraded to 100 => degraded.
    expect(await levelFor(deps({ getRttMs: () => 150 }), {})).toBe(0);
    expect(await levelFor(deps({ getRttMs: () => 150 }), { VALIDATOR_DEGRADED_RTT: '100' })).toBe(1);
  });
});
