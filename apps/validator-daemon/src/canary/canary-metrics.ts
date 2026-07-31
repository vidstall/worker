/**
 * Monitoring-redesign gap #4 — canary coverage/quorum/divergence metrics.
 *
 * Wraps `prom-client` primitives behind setter functions (mirrors
 * `createConcurrencyGauge`'s shape) so `verify-loop.ts` stays decoupled from
 * `prom-client` and only depends on plain callbacks injected via
 * `CanaryVerifyDeps`, the same convention `index.ts` uses for the bot's
 * ffmpeg counters and the relay's worker-resource gauges.
 *
 * INV-A/C: these are aggregate counts only (distinct-attester counts, a
 * 0/1 quorum flag, a promoted-proof tally) — never divergence payloads,
 * frame hashes, or key material.
 */

import { createGauge, createCounter, type Registry } from '@dvconf/shared';

export interface CanaryMetricsSetters {
  /** Distinct co-auditor validators that observed `relayMinerId` this round. */
  setCoverage: (relayMinerId: string, distinctValidators: number) => void;
  /** Whether an open cell for `relayMinerId` reached the >=2-distinct-attester quorum this round. */
  setQuorumMet: (relayMinerId: string, met: boolean) => void;
  /** One divergence proof assembled + submitted (chain-visible slash). */
  incDivergencePromoted: () => void;
}

export function registerCanaryMetrics(registry: Registry): CanaryMetricsSetters {
  const coverageGauge = createGauge(
    registry,
    'dvconf_canary_coverage_distinct_validators',
    'Distinct co-auditor validators that observed this relay this round',
    ['relay'],
  );
  const quorumGauge = createGauge(
    registry,
    'dvconf_canary_quorum_met',
    'Whether an open canary divergence cell for this relay reached the >=2-distinct-attester quorum this round (0/1)',
    ['relay'],
  );
  const divergencePromotedCounter = createCounter(
    registry,
    'dvconf_canary_divergence_promoted_total',
    'Total canary divergence proofs assembled and submitted (chain-visible slashes)',
    [],
  );

  return {
    setCoverage: (relayMinerId, distinctValidators) => {
      coverageGauge.set({ relay: relayMinerId }, distinctValidators);
    },
    setQuorumMet: (relayMinerId, met) => {
      quorumGauge.set({ relay: relayMinerId }, met ? 1 : 0);
    },
    incDivergencePromoted: () => {
      divergencePromotedCounter.inc();
    },
  };
}
