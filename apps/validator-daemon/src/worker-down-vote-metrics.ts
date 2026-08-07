/**
 * Shared `dvconf_worker_down_vote_total` counter for the Liveness experiment
 * table (see docs/protocol -- correlates against the relay's
 * dvconf_relay_down_hint_total/last_at_seconds to compare client vs. worker
 * awareness of a dead node). Centralized here (mirrors relay's
 * failover-metrics.ts) because `prom-client` throws on double-registering a
 * metric name against the same registry -- both room-health-vote-watcher.ts
 * (cast_health_vote) and liveness-sweep.ts (cast_liveness_vote) record
 * against the SAME counter, so there must be exactly one definition site.
 */
import { createCounter, type Registry } from '@dvconf/shared';
import type { Counter } from 'prom-client';

let counter: Counter<string> | null = null;

/** Wire `dvconf_worker_down_vote_total{target_miner_id}` -- call once at validator-daemon startup. */
export function registerWorkerDownVoteMetrics(registry: Registry): void {
  counter = createCounter(
    registry,
    'dvconf_worker_down_vote_total',
    'Cumulative worker-down votes cast by this validator (cast_health_vote + cast_liveness_vote)',
    ['target_miner_id'],
  );
}

export function recordWorkerDownVote(targetMinerId: string): void {
  counter?.inc({ target_miner_id: targetMinerId });
}
