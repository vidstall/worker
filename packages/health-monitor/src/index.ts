/**
 * @dvconf/health-monitor — barrel export.
 *
 * The F61 self-degradation core consumed by the 4 daemons (P17 M2a). P6 ships
 * the level state machine; report.ts (P8) + thresholds.ts (P7) land later.
 */

export { HealthMonitor } from './health-monitor.js';
export type {
  HealthLevel,
  SignalSample,
  SignalThresholds,
  HealthSignal,
  DegradationReporter,
  HealthMonitorOptions,
} from './health-monitor.js';
