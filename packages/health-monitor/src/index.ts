/**
 * @dvconf/health-monitor — barrel export.
 *
 * The F61 self-degradation core consumed by the 4 daemons (P17 M2a). P6 ships
 * the level state machine; P7 adds the per-level cooldown + env-driven threshold
 * parsing (thresholds.ts); P8 adds the chain reporter (report.ts) — the single
 * production degraded path (the injected `DegradationReporter`).
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
export {
  makeChainReporter,
  buildReportNodeDegradationTx,
  buildReportCpDegradationTx,
} from './report.js';
export type { CapVariant, ChainReporterArgs } from './report.js';
