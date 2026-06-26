import { describe, it, expect } from 'vitest';
import { selectActiveRelays } from '../admission-capacity.js';
import type { RelayCapacity } from '../admission-capacity.js';

// Minimal RelayCapacity factory — mirror the fields read by selectPlacementRelay.
const mk = (
  minerId: string,
  attestedLoadPaths: number,
  cWorker: number,
  rtt: number,
  canaryHealthy = true,
): RelayCapacity => ({ minerId, attestedLoadPaths, cWorker, rtt: BigInt(rtt), canaryHealthy });

describe('selectActiveRelays (REQ-RMS-021)', () => {
  it('returns kR distinct relays each absorbing its share, ordered by ratio then RTT', () => {
    const pool = [mk('a', 0, 300, 10), mk('b', 0, 300, 20), mk('c', 0, 300, 30), mk('d', 295, 300, 5)];
    // share = ceil(30/3) = 10; d is 295+10 = 305 > 300 -> excluded by the capacity ceiling.
    const out = selectActiveRelays(pool, 30, 3);
    expect(out.map((r) => r.minerId)).toEqual(['a', 'b', 'c']);
  });

  it('defers (returns []) when fewer than kR relays can absorb a share', () => {
    const pool = [mk('a', 0, 300, 10), mk('b', 295, 300, 20)];
    expect(selectActiveRelays(pool, 30, 3)).toEqual([]);
  });

  it('skips canary-unhealthy relays', () => {
    const pool = [mk('a', 0, 300, 10), mk('b', 0, 300, 20), mk('c', 0, 300, 30, false), mk('e', 0, 300, 40)];
    expect(selectActiveRelays(pool, 30, 3).map((r) => r.minerId)).toEqual(['a', 'b', 'e']);
  });
});
