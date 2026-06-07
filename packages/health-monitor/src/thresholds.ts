/**
 * @dvconf/health-monitor — env-driven threshold + cooldown parsing (P17 M2a-P7).
 *
 * REQ-DOH-017 (per-daemon threshold env vars) + REQ-DOH-016 (cooldown window).
 * Per D-DOH-M2-HM-6 the package owns the GENERIC parser while each daemon owns
 * its OWN `DEFAULT_THRESHOLDS` magic numbers (wired in P10) and passes them in;
 * per D-DOH-M2-HM-3 the package owns `DEGRADATION_COOLDOWN_MS` (it owns
 * cooldown). The `env` is INJECTED (mirrors @dvconf/shared
 * `buildLoggerOptions(service, env)`) so the parsers are pure + unit-testable —
 * the daemon passes `process.env` at startup.
 */

import { DEFAULT_COOLDOWN_MS, type SignalThresholds } from './health-monitor.js';

/** A minimal injectable env source (a subset of `NodeJS.ProcessEnv`). */
export type ThresholdEnv = Record<string, string | undefined>;

/**
 * Read a signal's thresholds from env, falling back to the daemon's defaults.
 * Keys are UPPER_SNAKE: `${daemonKey}_DEGRADED_${metric}` and
 * `${daemonKey}_UNHEALTHY_${metric}`. Each bound is overridden independently;
 * a missing / blank / non-numeric value falls back to the matching `defaults`
 * field (no-hardcodes: defaults live with the daemon's readers, overrides in
 * env). Fractional values are honoured (CPU %, packet-loss ratio, RTT ms).
 */
export function readSignalThresholds(
  daemonKey: string,
  metric: string,
  defaults: SignalThresholds,
  env: ThresholdEnv,
): SignalThresholds {
  return {
    degradedAt: readNumberEnv(env[`${daemonKey}_DEGRADED_${metric}`], defaults.degradedAt),
    unhealthyAt: readNumberEnv(env[`${daemonKey}_UNHEALTHY_${metric}`], defaults.unhealthyAt),
  };
}

/**
 * Read `DEGRADATION_COOLDOWN_MS` (the per-level re-report suppression window, in
 * ms); default `DEFAULT_COOLDOWN_MS` (60000). A missing / blank / non-numeric
 * value falls back to the default; an explicit `0` disables the cooldown.
 */
export function readCooldownMs(env: ThresholdEnv): number {
  return readNumberEnv(env['DEGRADATION_COOLDOWN_MS'], DEFAULT_COOLDOWN_MS);
}

/**
 * Parse an env string to a finite number; fall back on missing / blank / NaN.
 * `Number` (not `parseInt`) so fractional thresholds round-trip; the explicit
 * blank guard avoids `Number('') === 0` masking the default.
 */
function readNumberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}
