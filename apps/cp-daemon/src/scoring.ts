/**
 * PVR Scoring — deterministic formula matching pairing_score.move exactly.
 *
 * All math in bigint basis points. Consensus depends on all CPs producing
 * identical scores for identical inputs.
 */

export const BASIS = 10_000n;
export const PVR_MAX_RTT = 500n;
export const PVR_MAX_LOAD = 100n;
export const PVR_STAKE_CAP = 5_000_000_000n;
export const PVR_HEARTBEAT_FRESH = 3n;
export const PVR_HEARTBEAT_STALE = 7n;
export const PVR_DEFAULT_HISTORY = 5_000n;

export interface ScoringWeights {
  rtt: bigint;
  load: bigint;
  stake: bigint;
  liveness: bigint;
  region: bigint;
  history: bigint;
}

export const PVR_WEIGHTS: ScoringWeights = {
  rtt:      3_000n,
  load:     2_500n,
  stake:    1_500n,
  liveness: 1_000n,
  region:   1_000n,
  history:  1_000n,
};

export interface NodeCandidate {
  minerId: string;
  rtt: bigint;
  load: bigint;
  stakeAmount: bigint;
  heartbeatAge: bigint;
  region: string;
  historyScore: bigint;
}

export function computeNodeScore(
  node: NodeCandidate,
  targetRegion: string,
  weights: ScoringWeights,
): bigint {
  const clampedRtt = node.rtt < PVR_MAX_RTT ? node.rtt : PVR_MAX_RTT;
  const rttScore = (PVR_MAX_RTT - clampedRtt) * BASIS / PVR_MAX_RTT;

  const clampedLoad = node.load < PVR_MAX_LOAD ? node.load : PVR_MAX_LOAD;
  const loadScore = (PVR_MAX_LOAD - clampedLoad) * BASIS / PVR_MAX_LOAD;

  const clampedStake = node.stakeAmount < PVR_STAKE_CAP ? node.stakeAmount : PVR_STAKE_CAP;
  const stakeScore = clampedStake * BASIS / PVR_STAKE_CAP;

  let livenessScore: bigint;
  if (node.heartbeatAge < PVR_HEARTBEAT_FRESH) {
    livenessScore = BASIS;
  } else if (node.heartbeatAge < PVR_HEARTBEAT_STALE) {
    livenessScore = 5_000n;
  } else {
    livenessScore = 0n;
  }

  const regionScore = node.region === targetRegion ? BASIS : 0n;

  const weightedSum =
    rttScore * weights.rtt +
    loadScore * weights.load +
    stakeScore * weights.stake +
    livenessScore * weights.liveness +
    regionScore * weights.region +
    node.historyScore * weights.history;

  return weightedSum / BASIS;
}

export function computePairingScore(nodeScores: bigint[]): bigint {
  if (nodeScores.length === 0) return 0n;
  const total = nodeScores.reduce((sum, s) => sum + s, 0n);
  return total / BigInt(nodeScores.length);
}

export function canonicalSort(
  nodes: NodeCandidate[],
  targetRegion: string,
  weights: ScoringWeights,
): NodeCandidate[] {
  return [...nodes].sort((a, b) => {
    const scoreA = computeNodeScore(a, targetRegion, weights);
    const scoreB = computeNodeScore(b, targetRegion, weights);
    if (scoreB !== scoreA) {
      return scoreB > scoreA ? 1 : -1;
    }
    return a.minerId < b.minerId ? -1 : a.minerId > b.minerId ? 1 : 0;
  });
}

// ── REQ-RMS-002/019 — OFF-CHAIN capacity layer (additive; NOT part of the consensus score) ──
//
// The PVR consensus score above MUST stay byte-identical to pairing_score.move. Capacity-aware
// placement is a SEPARATE filter applied AFTER canonicalSort (see admission-capacity.ts +
// event-handler EscrowCreated). This marker documents that boundary and is asserted by the
// scoring test so an accidental 7th-weight edit fails loud.
export const CAPACITY_LAYER_IS_ADDITIVE = true as const;
