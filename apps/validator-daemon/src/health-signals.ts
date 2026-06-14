/**
 * P17 M2a-P10 — validator-daemon F61 health-signal readers (REQ-DOH-014 / DOH-017).
 *
 * Builds the validator's two `HealthSignal` readers for the
 * `@dvconf/health-monitor` machine (DESIGN §2.2): probe RTT ms (rolling avg) and
 * consecutive RTP-unreachable count. Each reader maps a raw sample to a 0/1/2
 * level via `readSignalThresholds` (env-overridable; defaults live HERE per
 * D-DOH-M2-HM-6).
 *
 * P10 ships ONLY the pure reader logic + the deps contract; P11 wires the
 * net-new counters at the verified attach points — the rolling avg over
 * `stunProbe` `avgLatencyMs` (probe.ts) for RTT, and a consecutive-unreachable
 * counter (incremented when `createRelayProbe` yields an `unreachableSample`
 * — probe.ts:523/:528 — reset on any reachable cycle) for unreachable — and
 * assembles the `HealthMonitor` (variant 'miner', node_type 1).
 */

import {
  readSignalThresholds,
  type HealthSignal,
  type SignalSample,
  type SignalThresholds,
  type ThresholdEnv,
} from '@dvconf/health-monitor';

const DAEMON_KEY = 'VALIDATOR';

/**
 * Per-daemon default thresholds (D-DOH-M2-HM-6). PLACEHOLDERS deferred to
 * OQ-DOH-3 / the Phase-2 bench; each bound is independently overridable via
 * `${VALIDATOR}_DEGRADED_<METRIC>` / `${VALIDATOR}_UNHEALTHY_<METRIC>`.
 */
export const DEFAULT_THRESHOLDS = {
  /** rolling-avg probe RTT in ms (500 ~ PVR_MAX_RTT). */
  RTT: { degradedAt: 300, unhealthyAt: 500 },
  /** consecutive unreachable probe cycles (resets on any reachable). */
  UNREACHABLE: { degradedAt: 1, unhealthyAt: 3 },
} satisfies Record<string, SignalThresholds>;

/** The validator-daemon's injected signal sources (wired in P11). */
export interface ValidatorHealthDeps {
  getRttMs: () => number;
  getConsecutiveUnreachable: () => number;
}

/** Build the validator-daemon's `HealthSignal[]` (DESIGN §2.2). */
export function buildHealthSignals(deps: ValidatorHealthDeps, env: ThresholdEnv = process.env): HealthSignal[] {
  return [
    {
      name: 'rtt',
      read: (): SignalSample => ({ value: deps.getRttMs() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'RTT', DEFAULT_THRESHOLDS.RTT, env),
    },
    {
      name: 'unreachable',
      read: (): SignalSample => ({ value: deps.getConsecutiveUnreachable() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'UNREACHABLE', DEFAULT_THRESHOLDS.UNREACHABLE, env),
    },
  ];
}
