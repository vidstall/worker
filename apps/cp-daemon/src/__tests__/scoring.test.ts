import { describe, it, expect } from 'vitest';
import {
  computeNodeScore,
  computePairingScore,
  canonicalSort,
  PVR_WEIGHTS,
  PVR_MAX_RTT,
  PVR_MAX_LOAD,
  PVR_STAKE_CAP,
  PVR_HEARTBEAT_FRESH,
  PVR_HEARTBEAT_STALE,
  BASIS,
  type NodeCandidate,
  type ScoringWeights,
} from '../scoring.js';

describe('PVR Scoring — must match pairing_score.move', () => {
  const makeNode = (overrides: Partial<NodeCandidate> = {}): NodeCandidate => ({
    minerId: '0x0001',
    rtt: 100n,
    load: 20n,
    stakeAmount: 2_500_000_000n,
    heartbeatAge: 1n,
    region: 'us-east',
    historyScore: 5_000n,
    ...overrides,
  });

  describe('computeNodeScore', () => {
    it('returns value in 0-10000 range for valid inputs', () => {
      const score = computeNodeScore(makeNode(), 'us-east', PVR_WEIGHTS);
      expect(score).toBeGreaterThanOrEqual(0n);
      expect(score).toBeLessThanOrEqual(BASIS);
    });

    it('perfect node gets max score (10000)', () => {
      const perfect = makeNode({
        rtt: 0n, load: 0n, stakeAmount: PVR_STAKE_CAP,
        heartbeatAge: 0n, region: 'us-east', historyScore: 10_000n,
      });
      expect(computeNodeScore(perfect, 'us-east', PVR_WEIGHTS)).toBe(BASIS);
    });

    it('worst node gets zero score', () => {
      const worst = makeNode({
        rtt: PVR_MAX_RTT, load: PVR_MAX_LOAD, stakeAmount: 0n,
        heartbeatAge: 100n, region: 'eu-west', historyScore: 0n,
      });
      expect(computeNodeScore(worst, 'us-east', PVR_WEIGHTS)).toBe(0n);
    });

    it('RTT at max gives 0 RTT contribution', () => {
      const high = makeNode({ rtt: 500n });
      const low = makeNode({ rtt: 0n });
      expect(computeNodeScore(low, 'us-east', PVR_WEIGHTS))
        .toBeGreaterThan(computeNodeScore(high, 'us-east', PVR_WEIGHTS));
    });

    it('liveness: fresh (< 3 epochs) = full score', () => {
      const fresh = makeNode({ heartbeatAge: 2n });
      const stale = makeNode({ heartbeatAge: 5n });
      expect(computeNodeScore(fresh, 'us-east', PVR_WEIGHTS))
        .toBeGreaterThan(computeNodeScore(stale, 'us-east', PVR_WEIGHTS));
    });

    it('liveness: dead (>= 7 epochs) = zero liveness', () => {
      const dead = makeNode({ heartbeatAge: 7n });
      const alive = makeNode({ heartbeatAge: 0n });
      expect(computeNodeScore(alive, 'us-east', PVR_WEIGHTS))
        .toBeGreaterThan(computeNodeScore(dead, 'us-east', PVR_WEIGHTS));
    });

    it('region match gives 1000 bps bonus', () => {
      const node = makeNode({ region: 'us-east' });
      const match = computeNodeScore(node, 'us-east', PVR_WEIGHTS);
      const noMatch = computeNodeScore(node, 'eu-west', PVR_WEIGHTS);
      expect(match).toBeGreaterThan(noMatch);
    });

    it('weights sum to 10000', () => {
      const sum = PVR_WEIGHTS.rtt + PVR_WEIGHTS.load + PVR_WEIGHTS.stake +
        PVR_WEIGHTS.liveness + PVR_WEIGHTS.region + PVR_WEIGHTS.history;
      expect(sum).toBe(BASIS);
    });

    it('RTT above max is clamped (not negative)', () => {
      const node = makeNode({ rtt: 1000n }); // way above 500
      const score = computeNodeScore(node, 'us-east', PVR_WEIGHTS);
      expect(score).toBeGreaterThanOrEqual(0n);
    });

    it('stake above cap is clamped to max', () => {
      const atCap = makeNode({ stakeAmount: PVR_STAKE_CAP });
      const aboveCap = makeNode({ stakeAmount: PVR_STAKE_CAP * 2n });
      expect(computeNodeScore(atCap, 'us-east', PVR_WEIGHTS))
        .toBe(computeNodeScore(aboveCap, 'us-east', PVR_WEIGHTS));
    });
  });

  describe('computePairingScore', () => {
    it('averages correctly', () => {
      expect(computePairingScore([8000n, 6000n])).toBe(7000n);
    });
    it('returns 0 for empty', () => {
      expect(computePairingScore([])).toBe(0n);
    });
    it('single node returns its score', () => {
      expect(computePairingScore([8500n])).toBe(8500n);
    });
  });

  describe('canonicalSort', () => {
    it('sorts by score descending', () => {
      const nodes = [
        makeNode({ minerId: '0x01', rtt: 200n }),
        makeNode({ minerId: '0x02', rtt: 50n }),
      ];
      const sorted = canonicalSort(nodes, 'us-east', PVR_WEIGHTS);
      expect(sorted[0].minerId).toBe('0x02');
    });

    it('tie-breaks by minerId ascending', () => {
      const nodes = [
        makeNode({ minerId: '0x02' }),
        makeNode({ minerId: '0x01' }),
      ];
      const sorted = canonicalSort(nodes, 'us-east', PVR_WEIGHTS);
      expect(sorted[0].minerId).toBe('0x01');
    });

    it('deterministic regardless of input order', () => {
      const nodes = [
        makeNode({ minerId: '0x03', rtt: 100n }),
        makeNode({ minerId: '0x01', rtt: 50n }),
        makeNode({ minerId: '0x02', rtt: 50n }),
      ];
      const r1 = canonicalSort([...nodes], 'us-east', PVR_WEIGHTS).map(n => n.minerId);
      const r2 = canonicalSort([...nodes].reverse(), 'us-east', PVR_WEIGHTS).map(n => n.minerId);
      expect(r1).toEqual(r2);
    });
  });

  describe('constants match on-chain', () => {
    it('PVR_MAX_RTT = 500', () => expect(PVR_MAX_RTT).toBe(500n));
    it('PVR_MAX_LOAD = 100', () => expect(PVR_MAX_LOAD).toBe(100n));
    it('PVR_STAKE_CAP = 5 SUI', () => expect(PVR_STAKE_CAP).toBe(5_000_000_000n));
    it('PVR_HEARTBEAT_FRESH = 3', () => expect(PVR_HEARTBEAT_FRESH).toBe(3n));
    it('PVR_HEARTBEAT_STALE = 7', () => expect(PVR_HEARTBEAT_STALE).toBe(7n));
  });
});
