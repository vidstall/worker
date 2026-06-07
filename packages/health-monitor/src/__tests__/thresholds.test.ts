/**
 * P17 M2a-P7 (REQ-DOH-016 / REQ-DOH-017) — env-driven threshold + cooldown parsing.
 *
 * `readSignalThresholds` parses per-daemon `${KEY}_DEGRADED_<METRIC>` /
 * `${KEY}_UNHEALTHY_<METRIC>` overrides with the daemon's own defaults as the
 * fallback (D-DOH-M2-HM-6: the package owns the GENERIC parser, defaults live in
 * the daemon). `readCooldownMs` reads `DEGRADATION_COOLDOWN_MS` (default 60000,
 * D-DOH-M2-HM-3). Both take an INJECTED `env` (mirrors @dvconf/shared
 * `buildLoggerOptions(service, env)`) so they are pure + unit-testable.
 */

import { describe, it, expect } from 'vitest';
import { readSignalThresholds, readCooldownMs } from '../thresholds.js';
import type { SignalThresholds } from '../health-monitor.js';

describe('readSignalThresholds (P7, DOH-017)', () => {
  const defaults: SignalThresholds = { degradedAt: 70, unhealthyAt: 90 };

  it('returns the daemon defaults when no env override is set', () => {
    expect(readSignalThresholds('RELAY', 'CPU', defaults, {})).toEqual(defaults);
  });

  it('reads ${KEY}_DEGRADED_<METRIC> / ${KEY}_UNHEALTHY_<METRIC> overrides', () => {
    const env = { RELAY_DEGRADED_CPU: '55', RELAY_UNHEALTHY_CPU: '80' };
    expect(readSignalThresholds('RELAY', 'CPU', defaults, env)).toEqual({ degradedAt: 55, unhealthyAt: 80 });
  });

  it('overrides each bound INDEPENDENTLY (one env set, the other falls back to its default)', () => {
    const env = { RELAY_UNHEALTHY_CPU: '95' };
    expect(readSignalThresholds('RELAY', 'CPU', defaults, env)).toEqual({ degradedAt: 70, unhealthyAt: 95 });
  });

  it('accepts fractional thresholds (packet-loss ratio, RTT ms)', () => {
    const env = { SIGNALING_DEGRADED_LOSS: '0.02', SIGNALING_UNHEALTHY_LOSS: '0.1' };
    expect(readSignalThresholds('SIGNALING', 'LOSS', { degradedAt: 0, unhealthyAt: 0 }, env)).toEqual({
      degradedAt: 0.02,
      unhealthyAt: 0.1,
    });
  });

  it('falls back to the default on a blank or non-numeric value', () => {
    const env = { RELAY_DEGRADED_CPU: '   ', RELAY_UNHEALTHY_CPU: 'abc' };
    expect(readSignalThresholds('RELAY', 'CPU', defaults, env)).toEqual(defaults);
  });

  it('keys are daemon + metric specific (an unrelated key does not bleed through)', () => {
    const env = { CP_DEGRADED_RPC: '5', RELAY_DEGRADED_PACKETLOSS: '0.3' };
    expect(readSignalThresholds('RELAY', 'CPU', defaults, env)).toEqual(defaults);
  });
});

describe('readCooldownMs (P7, DOH-016)', () => {
  it('defaults to 60000 when DEGRADATION_COOLDOWN_MS is unset', () => {
    expect(readCooldownMs({})).toBe(60_000);
  });

  it('reads DEGRADATION_COOLDOWN_MS', () => {
    expect(readCooldownMs({ DEGRADATION_COOLDOWN_MS: '30000' })).toBe(30_000);
  });

  it('falls back to 60000 on a blank or non-numeric value', () => {
    expect(readCooldownMs({ DEGRADATION_COOLDOWN_MS: '' })).toBe(60_000);
    expect(readCooldownMs({ DEGRADATION_COOLDOWN_MS: 'soon' })).toBe(60_000);
  });

  it('accepts an explicit 0 (cooldown disabled) — not treated as a falsy fallback', () => {
    expect(readCooldownMs({ DEGRADATION_COOLDOWN_MS: '0' })).toBe(0);
  });
});
