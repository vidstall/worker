/**
 * CP-daemon scoring-loop latency probe — Task #26 (scope B).
 *
 * Provides a drop-in `timedCanonicalSort` that records `L_cp_score` per call
 * when `BENCH_LATENCY=1`. When unset, it is the unwrapped `canonicalSort`
 * with zero overhead (no allocation, no branch in the hot path beyond an
 * already-resolved null check).
 *
 * Module-level singleton because the scoring call sites live in the free
 * function `handleEvent`, not inside the `createEventHandler` closure.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 */

import { LatencyWriter, isBenchEnabled } from '@dvconf/shared';
import {
  canonicalSort,
  type NodeCandidate,
  type ScoringWeights,
} from './scoring.js';

let cachedWriter: LatencyWriter | null = null;
let initialized = false;

function ensureWriter(): LatencyWriter | null {
  if (initialized) return cachedWriter;
  initialized = true;
  if (!isBenchEnabled()) {
    cachedWriter = null;
    return null;
  }
  cachedWriter = new LatencyWriter({
    source: 'cp-daemon',
    instance: process.env['CP_INSTANCE'] ?? 'cp-default',
  });
  return cachedWriter;
}

/**
 * Drop-in replacement for `canonicalSort`. Records `L_cp_score` per call when
 * the bench probe is enabled; otherwise delegates without overhead.
 */
export function timedCanonicalSort(
  nodes: NodeCandidate[],
  targetRegion: string,
  weights: ScoringWeights,
): NodeCandidate[] {
  const writer = ensureWriter();
  if (writer === null) {
    return canonicalSort(nodes, targetRegion, weights);
  }
  const t0 = performance.now();
  try {
    return canonicalSort(nodes, targetRegion, weights);
  } finally {
    writer.write('L_cp_score', performance.now() - t0, {
      candidate_count: nodes.length,
    });
  }
}

/** Close the writer at daemon shutdown. */
export function closeCpScoreProbe(): void {
  if (cachedWriter !== null) {
    cachedWriter.close();
    cachedWriter = null;
    initialized = false;
  }
}
