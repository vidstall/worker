/**
 * @dvconf/health-monitor — barrel export.
 *
 * The F61 self-degradation core consumed by the 4 daemons (P17 M2a). P6 ships
 * the level state machine; P7 adds the per-level cooldown + env-driven threshold
 * parsing (thresholds.ts). report.ts (the chain reporter, P8) lands later.
 */

export { HealthMonitor, DEFAULT_COOLDOWN_MS } from './health-monitor.js';
export type {
  HealthLevel,
  SignalSample,
  SignalThresholds,
  HealthSignal,
  DegradationReporter,
  HealthMonitorOptions,
} from './health-monitor.js';
export { readSignalThresholds, readCooldownMs } from './thresholds.js';
export type { ThresholdEnv } from './thresholds.js';
