/**
 * Shared failover-metrics state for the academic-eval "Fault Tolerance"
 * dashboard row. Centralized here (rather than defined separately in
 * relay-heartbeat.ts / relay-worker-recovery.ts / index.ts) because
 * `prom-client` throws on double-registering a metric name against the same
 * registry -- three call sites need to record against the SAME histogram/
 * counter, so there must be exactly one definition site.
 *
 * Each phase's duration is measured LOCALLY and independently (detect:
 * first-missed-ping to fired; rebuild: wall time inside
 * rebuildFromRegistry; promote: last-not-alive to first-alive on the pipe
 * liveness observer) -- there is no shared correlation ID threading t0
 * through t1 through t2 across these three files today, so this
 * deliberately does NOT claim a single end-to-end failover-latency number.
 * Each phase's own duration is a real, independently-honest signal;
 * fabricating a cross-file correlation would not be.
 */
import { createDurationHistogram, createCounter, type Registry } from '@dvconf/shared';
import type { Histogram, Counter } from 'prom-client';

export type FailoverPhase = 'detect' | 'rebuild' | 'promote';

let state: { duration: Histogram<string>; events: Counter<string> } | null = null;

/** Wire `dvconf_failover_duration_seconds{phase}` + `dvconf_failover_events_total{phase}` -- call once at relay startup. */
export function registerFailoverMetrics(registry: Registry): void {
  state = {
    duration: createDurationHistogram(
      registry,
      'dvconf_failover_duration_seconds',
      'Wall-clock duration of one failover phase (detect/rebuild/promote), each measured independently -- see failover-metrics.ts',
      ['phase'],
    ),
    events: createCounter(
      registry,
      'dvconf_failover_events_total',
      'Failover phase occurrences (detect/rebuild/promote)',
      ['phase'],
    ),
  };
}

export function recordFailoverPhase(phase: FailoverPhase, durationSec: number): void {
  if (!state) return;
  state.duration.observe({ phase }, durationSec);
  state.events.inc({ phase });
}
