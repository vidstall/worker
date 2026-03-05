import { describe, it, expect } from 'vitest';
import { scoreRelay, scoreRelays, type RelayCandidate, type ScoringWeights } from '../scoring.js';

/** Equal weights — each dimension gets 2000 basis points. */
const EQUAL_WEIGHTS: ScoringWeights = {
  reputation: 2_000n,
  rtt: 2_000n,
  load: 2_000n,
  stake: 2_000n,
  regionMatch: 2_000n,
};

function makeRelay(overrides: Partial<RelayCandidate> = {}): RelayCandidate {
  return {
    minerId: 'relay-1',
    reputation: 5_000n,
    rtt: 100n,
    load: 50n,
    stakeAmount: 5_000_000_000n, // 5 DVCONF
    region: 'us-east',
    ...overrides,
  };
}

describe('scoreRelay', () => {
  it('scores with equal weights and produces expected ranking', () => {
    const relay = makeRelay();
    const score = scoreRelay(relay, EQUAL_WEIGHTS, 'us-east');
    // All components contribute positively, result should be > 0
    expect(score).toBeGreaterThan(0n);
    // With region match, score should be significant
    expect(typeof score).toBe('bigint');
  });

  it('region match boosts score significantly', () => {
    const relay = makeRelay({ region: 'us-east' });

    const scoreMatch = scoreRelay(relay, EQUAL_WEIGHTS, 'us-east');
    const scoreNoMatch = scoreRelay(relay, EQUAL_WEIGHTS, 'eu-west');

    expect(scoreMatch).toBeGreaterThan(scoreNoMatch);
    // Region weight is 2000/10000 = 20%, so boost should be 2000 BP
    expect(scoreMatch - scoreNoMatch).toBe(2_000n);
  });

  it('lower RTT produces higher score', () => {
    const lowRtt = makeRelay({ minerId: 'low-rtt', rtt: 10n });
    const highRtt = makeRelay({ minerId: 'high-rtt', rtt: 400n });

    const scoreLow = scoreRelay(lowRtt, EQUAL_WEIGHTS, 'us-east');
    const scoreHigh = scoreRelay(highRtt, EQUAL_WEIGHTS, 'us-east');

    expect(scoreLow).toBeGreaterThan(scoreHigh);
  });

  it('all-zero relay scores zero', () => {
    const zeroRelay: RelayCandidate = {
      minerId: 'zero',
      reputation: 0n,
      rtt: 500n, // At ceiling -> 0 score
      load: 1_000n, // At ceiling -> 0 score
      stakeAmount: 0n,
      region: 'other',
    };

    const score = scoreRelay(zeroRelay, EQUAL_WEIGHTS, 'us-east');
    expect(score).toBe(0n);
  });

  it('all values are bigint — no floating point', () => {
    const relay = makeRelay();
    const score = scoreRelay(relay, EQUAL_WEIGHTS, 'us-east');

    expect(typeof score).toBe('bigint');
    // Weights are bigint
    expect(typeof EQUAL_WEIGHTS.reputation).toBe('bigint');
    expect(typeof EQUAL_WEIGHTS.rtt).toBe('bigint');
    expect(typeof EQUAL_WEIGHTS.load).toBe('bigint');
    expect(typeof EQUAL_WEIGHTS.stake).toBe('bigint');
    expect(typeof EQUAL_WEIGHTS.regionMatch).toBe('bigint');
  });

  it('caps reputation at 10_000', () => {
    const overRep = makeRelay({ reputation: 15_000n });
    const maxRep = makeRelay({ reputation: 10_000n });

    const scoreOver = scoreRelay(overRep, EQUAL_WEIGHTS, 'us-east');
    const scoreMax = scoreRelay(maxRep, EQUAL_WEIGHTS, 'us-east');

    expect(scoreOver).toBe(scoreMax);
  });
});

describe('scoreRelays', () => {
  it('returns sorted descending by score', () => {
    const relays = [
      makeRelay({ minerId: 'worst', reputation: 0n, rtt: 400n }),
      makeRelay({ minerId: 'best', reputation: 10_000n, rtt: 10n }),
      makeRelay({ minerId: 'mid', reputation: 5_000n, rtt: 100n }),
    ];

    const ranked = scoreRelays(relays, EQUAL_WEIGHTS, 'us-east');

    expect(ranked).toHaveLength(3);
    expect(ranked[0]!.minerId).toBe('best');
    expect(ranked[ranked.length - 1]!.minerId).toBe('worst');

    // Verify descending order
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it('returns empty array for empty input', () => {
    const ranked = scoreRelays([], EQUAL_WEIGHTS, 'us-east');
    expect(ranked).toEqual([]);
  });

  it('all results are bigint scores', () => {
    const relays = [makeRelay({ minerId: 'a' }), makeRelay({ minerId: 'b' })];
    const ranked = scoreRelays(relays, EQUAL_WEIGHTS, 'us-east');

    for (const entry of ranked) {
      expect(typeof entry.score).toBe('bigint');
      expect(typeof entry.minerId).toBe('string');
    }
  });
});
