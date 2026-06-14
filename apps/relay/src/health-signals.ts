/**
 * P17 M2a-P10 — relay daemon F61 health-signal readers (REQ-DOH-014 / DOH-017).
 *
 * Builds the relay's three `HealthSignal` readers for the `@dvconf/health-monitor`
 * machine (DESIGN §2.2): mediasoup worker CPU %, global packet-loss bps, and
 * worker.died count. Each reader maps a raw sample to a 0/1/2 level via
 * `readSignalThresholds` (env-overridable; defaults live HERE per D-DOH-M2-HM-6).
 *
 * P10 ships ONLY the pure reader logic + the deps contract; P11 wires the
 * net-new counters at the verified attach points — `MediasoupManager.workers` +
 * `worker.getResourceUsage()` (mediasoup >= 3.14, resolved 3.19.17),
 * `worker.on('died')` (mediasoup-manager.ts:59), and the NET-NEW MetricsTracker
 * global packet-loss aggregate — and assembles the `HealthMonitor`. Nothing here
 * imports mediasoup (the package + this file stay dep-light); RO-020 `/healthz`
 * + heartbeat are untouched.
 *
 * Worker CPU is the one stateful reader: it computes the delta-% itself from two
 * cumulative `getResourceUsage()` snapshots over the elapsed wall time, MAX
 * across live workers (a pegged worker degrades its rooms). 0 live workers => L2
 * (the deliberate fail-open exception, D-DOH-M2-HM-7).
 */

import {
  readSignalThresholds,
  type HealthSignal,
  type SignalSample,
  type SignalThresholds,
  type ThresholdEnv,
} from '@dvconf/health-monitor';

const DAEMON_KEY = 'RELAY';

/**
 * Per-daemon default thresholds (D-DOH-M2-HM-6). All values are PLACEHOLDERS
 * deferred to OQ-DOH-3 / the Phase-2 bench; each bound is independently
 * overridable via `${RELAY}_DEGRADED_<METRIC>` / `${RELAY}_UNHEALTHY_<METRIC>`.
 */
export const DEFAULT_THRESHOLDS = {
  /** worker CPU %, MAX across live workers. */
  WORKER_CPU: { degradedAt: 70, unhealthyAt: 90 },
  /** global packet loss in basis points. */
  PACKET_LOSS: { degradedAt: 500, unhealthyAt: 1000 },
  /** mediasoup worker 'died' events in the rolling window. */
  WORKER_DIED: { degradedAt: 1, unhealthyAt: 2 },
} satisfies Record<string, SignalThresholds>;

/** A single mediasoup worker's cumulative resource usage (microseconds). */
export interface RelayWorkerSnapshot {
  pid: number;
  ru_utime: number;
  ru_stime: number;
}

/**
 * The relay's injected signal sources (wired in P11). `getWorkerResourceUsages`
 * returns one cumulative snapshot per LIVE mediasoup worker (empty => 0 live
 * workers); `now` is injectable for a deterministic CPU-delta test.
 */
export interface RelayHealthDeps {
  getWorkerResourceUsages: () => RelayWorkerSnapshot[] | Promise<RelayWorkerSnapshot[]>;
  getPacketLossBps: () => number;
  getWorkerDiedCount: () => number;
  now?: () => number;
}

/**
 * Build the relay's `HealthSignal[]` (DESIGN §2.2). Thresholds are resolved once
 * at startup from `env` (defaults above); the worker-CPU reader closes over a
 * per-pid baseline so each `read()` yields the instantaneous CPU % since the
 * previous sample.
 */
export function buildHealthSignals(deps: RelayHealthDeps, env: ThresholdEnv = process.env): HealthSignal[] {
  const now = deps.now ?? Date.now;

  // Stateful CPU delta sampler: cumulative micros per pid + the last sample
  // time. MAX across live workers; 0 live workers => unhealthy (L2).
  let prevTotalByPid = new Map<number, number>();
  let prevAt: number | null = null;

  const readWorkerCpu = async (): Promise<SignalSample> => {
    const snaps = await deps.getWorkerResourceUsages();
    if (snaps.length === 0) {
      // No live workers: reset the baseline and report unhealthy outright.
      prevTotalByPid = new Map();
      prevAt = null;
      return { value: 0, level: 2 };
    }
    const at = now();
    const elapsedMs = prevAt === null ? 0 : at - prevAt;
    const totalByPid = new Map<number, number>();
    let maxPct = 0;
    for (const s of snaps) {
      const total = s.ru_utime + s.ru_stime;
      totalByPid.set(s.pid, total);
      const prev = prevTotalByPid.get(s.pid);
      if (prev !== undefined && elapsedMs > 0) {
        // CPU % = consumed CPU micros / elapsed wall micros * 100.
        const pct = ((total - prev) / (elapsedMs * 1000)) * 100;
        if (pct > maxPct) maxPct = pct;
      }
    }
    prevTotalByPid = totalByPid;
    prevAt = at;
    return { value: maxPct };
  };

  return [
    {
      name: 'worker_cpu',
      read: readWorkerCpu,
      thresholds: readSignalThresholds(DAEMON_KEY, 'WORKER_CPU', DEFAULT_THRESHOLDS.WORKER_CPU, env),
    },
    {
      name: 'packet_loss',
      read: (): SignalSample => ({ value: deps.getPacketLossBps() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'PACKET_LOSS', DEFAULT_THRESHOLDS.PACKET_LOSS, env),
    },
    {
      name: 'worker_died',
      read: (): SignalSample => ({ value: deps.getWorkerDiedCount() }),
      thresholds: readSignalThresholds(DAEMON_KEY, 'WORKER_DIED', DEFAULT_THRESHOLDS.WORKER_DIED, env),
    },
  ];
}
