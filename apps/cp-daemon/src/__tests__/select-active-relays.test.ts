import { describe, it, expect } from 'vitest';
import { selectActiveRelays } from '../admission-capacity.js';
import type { RelayCapacity } from '../admission-capacity.js';

// Minimal RelayCapacity factory — mirror the fields read by selectActiveRelays.
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

  it('orders by ratio ascending even when the lowest-ratio relay is later in input and lower-priority by RTT (REQ-RMS-021)', () => {
    // share = ceil(30/2) = 15. a: (100+15)/300 = 0.383 (first in input, RTT 5);
    // b: (0+15)/300 = 0.05 (later in input, RTT 50). Neither input-order nor RTT-order
    // yields ['b','a'] — only ratio ordering does, so this discriminates the primary sort key.
    const pool = [mk('a', 100, 300, 5), mk('b', 0, 300, 50)];
    expect(selectActiveRelays(pool, 30, 2).map((r) => r.minerId)).toEqual(['b', 'a']);
  });

  it('returns [] when kR <= 0', () => {
    expect(selectActiveRelays([mk('a', 0, 300, 10)], 30, 0)).toEqual([]);
  });

  it('rounds the per-relay share UP (ceil), so a boundary relay overflows its ceiling and the call defers', () => {
    // ceil(31/3) = 11 -> c is 290+11 = 301 > 300, excluded -> only 2 eligible < kR=3 -> [].
    // With a floor share of 10, c would be 300 <= 300 and the call would return 3 relays.
    const pool = [mk('a', 0, 300, 10), mk('b', 0, 300, 20), mk('c', 290, 300, 30)];
    expect(selectActiveRelays(pool, 31, 3)).toEqual([]);
  });
});
