/**
 * P17 M2a-P10 — cp-daemon F61 health-signal readers (REQ-DOH-014 / DOH-017).
 *
 * Builds the CP's two `HealthSignal` readers for the `@dvconf/health-monitor`
 * machine (DESIGN §2.2): RPC error rate (queryEvents failures / total) and event
 * lag (now - newest polled event timestamp). Each reader maps a raw sample to a
 * 0/1/2 level via `readSignalThresholds` (env-overridable; defaults live HERE per
 * D-DOH-M2-HM-6).
 *
 * P10 ships ONLY the pure reader logic + the deps contract; P11 wires the
 * net-new counters at the verified attach points — the queryEvents catch
 * (index.ts:457) + the EventPoller error arm for the RPC rate, and a max-event-
 * timestamp tracker over the poller handler for the lag (the EventPoller cursor
 * is private — lag is tracked at the handler) — and assembles the
 * `HealthMonitor` (variant 'cp', node_type 3). The event-handler RelaySlashed arm
 * (event-handler.ts:193) is untouched.
 */

import {
  readSignalThresholds,
  type HealthSignal,
  type SignalSample,
  type SignalThresholds,
  type ThresholdEnv,
} from '@dvconf/health-monitor';

const DAEMON_KEY = 'CP';

/**
 * Per-daemon default thresholds (D-DOH-M2-HM-6). PLACEHOLDERS deferred to
 * OQ-DOH-3 / the Phase-2 bench; each bound is independently overridable via
 * `${CP}_DEGRADED_<METRIC>` / `${CP}_UNHEALTHY_<METRIC>`.
 */
export const DEFAULT_THRESHOLDS = {
  /** RPC (queryEvents) errors / total (ratio). */
  RPC_ERROR_RATE: { degradedAt: 0.1, unhealthyAt: 0.3 },
  /** cursor age = now - newest polled event ts, in ms (30s / 120s). */
  EVENT_LAG_MS: { degradedAt: 30_000, unhealthyAt: 120_000 },
} satisfies Record<string, SignalThresholds>;

/** The cp-daemon's injected signal sources (wired in P11). */
export interface CpHealthDeps {
  getRpcErrorRate: () => number;
  getEventLagMs: () => number;
}

/** Build the cp-daemon's `HealthSignal[]` (DESIGN §2.2). */
export function buildHealthSignals(deps: CpHealthDeps, env: ThresholdEnv = process.env): HealthSignal[] {
  return [
    {
      name: 'rpc_error_rate',
      read: (): SignalSample => ({ value: deps.getRpcErrorRate() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'RPC_ERROR_RATE', DEFAULT_THRESHOLDS.RPC_ERROR_RATE, env),
    },
    {
      name: 'event_lag',
      read: (): SignalSample => ({ value: deps.getEventLagMs() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'EVENT_LAG_MS', DEFAULT_THRESHOLDS.EVENT_LAG_MS, env),
    },
  ];
}
