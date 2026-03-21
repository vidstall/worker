/**
 * Relay scoring algorithm — all math in bigint (basis points).
 *
 * Implements the scoring formula from spec rev4 Section 9.1:
 * Final = (w_rep * repScore + w_rtt * rttScore + w_load * loadScore
 *        + w_stake * stakeScore + w_region * regionBonus) / 10_000
 *
 * All values are bigint to comply with CLAUDE.md: "All math is basis points (integers)".
 */

/** A relay candidate with on-chain data for scoring. */
export interface RelayCandidate {
  minerId: string;
  /** Reputation score in basis points (0-10_000). */
  reputation: bigint;
  /** Round-trip time in milliseconds. */
  rtt: bigint;
  /** Current number of active connections. */
  load: bigint;
  /** Stake amount in MIST. */
  stakeAmount: bigint;
  /** Region identifier (string for matching). */
  region: string;
}

/** Scoring weights — all in basis points, must sum to 10_000. */
export interface ScoringWeights {
  reputation: bigint;
  rtt: bigint;
  load: bigint;
  stake: bigint;
  regionMatch: bigint;
}

/** Maximum basis point value. */
const MAX_BP = 10_000n;

/**
 * RTT ceiling in ms. RTTs above this get score 0.
 * 500ms is considered unusable for real-time video.
 */
const RTT_CEILING_MS = 500n;

/**
 * Load ceiling. Relays at or above this load score 0.
 */
const LOAD_CEILING = 1_000n;

/**
 * Stake amount considered "maximum" for scoring (10 DVCONF = 10 * 10^9 MIST).
 * Amounts above this still score MAX_BP.
 */
const STAKE_MAX_MIST = 10_000_000_000n;

/** A validator candidate with on-chain data for scoring. */
export interface ValidatorCandidate {
  minerId: string;
  /** Reputation score in basis points (0-10_000). */
  reputation: bigint;
  /** Stake amount in MIST. */
  stakeAmount: bigint;
  /** Region identifier (string for matching). */
  region: string;
}

/**
 * Score a single relay against the given weights and target region.
 *
 * @param roomMode - Optional room mode. When 'mcu', load weight is doubled (MCU-05).
 * @returns Score in basis points (0 - 10_000).
 */
export function scoreRelay(
  relay: RelayCandidate,
  weights: ScoringWeights,
  targetRegion: string,
  roomMode?: 'sfu' | 'mcu',
): bigint {
  // repScore: already in 0-10_000 range
  const repScore = relay.reputation > MAX_BP ? MAX_BP : relay.reputation;

  // rttScore: inverse — lower RTT = higher score
  // score = max(0, (ceiling - rtt) * MAX_BP / ceiling)
  let rttScore = 0n;
  if (relay.rtt < RTT_CEILING_MS) {
    rttScore = (RTT_CEILING_MS - relay.rtt) * MAX_BP / RTT_CEILING_MS;
  }

  // loadScore: inverse — lower load = higher score
  // score = max(0, (ceiling - load) * MAX_BP / ceiling)
  let loadScore = 0n;
  if (relay.load < LOAD_CEILING) {
    loadScore = (LOAD_CEILING - relay.load) * MAX_BP / LOAD_CEILING;
  }

  // stakeScore: linear scale from 0 to MAX_BP, capped at STAKE_MAX_MIST
  let stakeScore = 0n;
  if (relay.stakeAmount >= STAKE_MAX_MIST) {
    stakeScore = MAX_BP;
  } else if (relay.stakeAmount > 0n) {
    stakeScore = relay.stakeAmount * MAX_BP / STAKE_MAX_MIST;
  }

  // regionBonus: MAX_BP if same region, 0 otherwise
  const regionBonus = relay.region === targetRegion ? MAX_BP : 0n;

  // MCU-05: Double load weight for MCU rooms to avoid overloaded relays
  const effectiveLoadWeight = roomMode === 'mcu' ? weights.load * 2n : weights.load;

  // Weighted sum, divided by MAX_BP to normalize
  const total =
    (weights.reputation * repScore +
      weights.rtt * rttScore +
      effectiveLoadWeight * loadScore +
      weights.stake * stakeScore +
      weights.regionMatch * regionBonus) /
    MAX_BP;

  return total;
}

/**
 * Score all relays and return sorted descending by score.
 *
 * @param roomMode - Optional room mode. When 'mcu', load weight is doubled (MCU-05, MCU-06).
 */
export function scoreRelays(
  relays: RelayCandidate[],
  weights: ScoringWeights,
  targetRegion: string,
  roomMode?: 'sfu' | 'mcu',
): Array<{ minerId: string; score: bigint }> {
  const scored = relays.map((r) => ({
    minerId: r.minerId,
    score: scoreRelay(r, weights, targetRegion, roomMode),
  }));

  // Sort descending by score (stable for equal scores)
  scored.sort((a, b) => {
    if (a.score > b.score) return -1;
    if (a.score < b.score) return 1;
    return 0;
  });

  return scored;
}

/**
 * Score a single validator candidate (PAIR-02).
 *
 * Validator scoring uses reputation, stake, and region match.
 * No RTT or load — validators don't serve media directly.
 *
 * @returns Score in basis points (0 - 10_000).
 */
export function scoreValidator(
  validator: ValidatorCandidate,
  weights: ScoringWeights,
  targetRegion: string,
): bigint {
  // repScore: already in 0-10_000 range
  const repScore = validator.reputation > MAX_BP ? MAX_BP : validator.reputation;

  // stakeScore: linear scale from 0 to MAX_BP, capped at STAKE_MAX_MIST
  let stakeScore = 0n;
  if (validator.stakeAmount >= STAKE_MAX_MIST) {
    stakeScore = MAX_BP;
  } else if (validator.stakeAmount > 0n) {
    stakeScore = validator.stakeAmount * MAX_BP / STAKE_MAX_MIST;
  }

  // regionBonus: MAX_BP if same region, 0 otherwise
  const regionBonus = validator.region === targetRegion ? MAX_BP : 0n;

  // Use reputation + stake + region weights (rtt and load zeroed for validators)
  const total =
    (weights.reputation * repScore +
      weights.stake * stakeScore +
      weights.regionMatch * regionBonus) /
    MAX_BP;

  return total;
}

/**
 * Score all validators and return sorted descending by score (PAIR-02).
 */
export function scoreValidators(
  validators: ValidatorCandidate[],
  weights: ScoringWeights,
  targetRegion: string,
): Array<{ minerId: string; score: bigint }> {
  const scored = validators.map((v) => ({
    minerId: v.minerId,
    score: scoreValidator(v, weights, targetRegion),
  }));

  scored.sort((a, b) => {
    if (a.score > b.score) return -1;
    if (a.score < b.score) return 1;
    return 0;
  });

  return scored;
}
