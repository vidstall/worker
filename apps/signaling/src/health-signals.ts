/**
 * P17 M2a-P10 — signaling daemon F61 health-signal readers (REQ-DOH-014 / DOH-017).
 *
 * Builds the signaling daemon's two `HealthSignal` readers for the
 * `@dvconf/health-monitor` machine (DESIGN §2.2): WS error rate (ws.on('error')
 * failures / total) and queue depth (MAX `ws.bufferedAmount` across the peer
 * sockets). Each reader maps a raw sample to a 0/1/2 level via
 * `readSignalThresholds` (env-overridable; defaults live HERE per D-DOH-M2-HM-6).
 *
 * P10 ships ONLY the pure reader logic + the deps contract; P11 wires the
 * net-new counters at the verified attach points — the `ws.on('error')` handler
 * (index.ts:341) for the error rate and the `peerSockets` map (index.ts:128) for
 * the bufferedAmount gauge — and assembles the `HealthMonitor`. The F62 authHook
 * path (`authHook.verifyJoin`, index.ts:244) is untouched.
 */

import {
  readSignalThresholds,
  type HealthSignal,
  type SignalSample,
  type SignalThresholds,
  type ThresholdEnv,
} from '@dvconf/health-monitor';

const DAEMON_KEY = 'SIGNALING';

/**
 * Per-daemon default thresholds (D-DOH-M2-HM-6). PLACEHOLDERS deferred to
 * OQ-DOH-3 / the Phase-2 bench; each bound is independently overridable via
 * `${SIGNALING}_DEGRADED_<METRIC>` / `${SIGNALING}_UNHEALTHY_<METRIC>`.
 */
export const DEFAULT_THRESHOLDS = {
  /** WS errors / total connections (ratio). */
  WS_ERROR_RATE: { degradedAt: 0.05, unhealthyAt: 0.15 },
  /** MAX ws.bufferedAmount across peer sockets, in bytes (1 MiB / 8 MiB). */
  QUEUE_DEPTH: { degradedAt: 1_048_576, unhealthyAt: 8_388_608 },
} satisfies Record<string, SignalThresholds>;

/** The signaling daemon's injected signal sources (wired in P11). */
export interface SignalingHealthDeps {
  getWsErrorRate: () => number;
  getMaxBufferedAmount: () => number;
}

/** Build the signaling daemon's `HealthSignal[]` (DESIGN §2.2). */
export function buildHealthSignals(deps: SignalingHealthDeps, env: ThresholdEnv = process.env): HealthSignal[] {
  return [
    {
      name: 'ws_error_rate',
      read: (): SignalSample => ({ value: deps.getWsErrorRate() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'WS_ERROR_RATE', DEFAULT_THRESHOLDS.WS_ERROR_RATE, env),
    },
    {
      name: 'queue_depth',
      read: (): SignalSample => ({ value: deps.getMaxBufferedAmount() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'QUEUE_DEPTH', DEFAULT_THRESHOLDS.QUEUE_DEPTH, env),
    },
  ];
}
