import { describe, it, expect } from 'vitest';
import {
  estimateRoomLoad,
  selectPlacementRelay,
  poolHealthGate,
  poolSize,
  type RoomClass,
  type RelayCapacity,
} from '../admission-capacity.js';

describe('REQ-RMS-003 estimateRoomLoad — L_r = V_active * min(9, P_active) + audio_term', () => {
  it('small room (preset V_active=6, P_active=2) -> 6*2 + audio', () => {
    // small: V_active=6, P_active=2, audio_term = expectedParticipants (conservative O(N) floor)
    expect(estimateRoomLoad('small', 10, 'sfu')).toBe(6 * Math.min(9, 2) + 10);
  });
  it('caps P_active at the page size of 9', () => {
    // large: V_active=30, P_active=20 -> min(9,20)=9
    expect(estimateRoomLoad('large', 100, 'sfu')).toBe(30 * 9 + 100);
  });
  it('webinar (few publishers, many viewers)', () => {
    expect(estimateRoomLoad('webinar', 200, 'sfu')).toBe(50 * Math.min(9, 1) + 200);
  });
  it('mcu mode collapses video fan-out (1 composited stream) but keeps audio_term', () => {
    expect(estimateRoomLoad('small', 10, 'mcu')).toBe(1 + 10);
  });
});

describe('REQ-RMS-002 selectPlacementRelay — i* = argmin (l_i + L_r)/C_worker s.t. <= C_worker, RTT tie-break', () => {
  const cWorker = 300;
  const relays: RelayCapacity[] = [
    { minerId: 'A', attestedLoadPaths: 250, cWorker, rtt: 50n }, // 250+60=310 > 300 -> rejected by ceiling
    { minerId: 'B', attestedLoadPaths: 100, cWorker, rtt: 80n }, // 100+60=160, ratio 0.53
    { minerId: 'C', attestedLoadPaths: 100, cWorker, rtt: 40n }, // SAME ratio as B, lower RTT -> wins tie
  ];
  it('rejects relays that would exceed the capacity ceiling', () => {
    const r = selectPlacementRelay(relays, 60);
    expect(r?.minerId).not.toBe('A');
  });
  it('picks argmin ratio; ties broken by lower RTT (geo)', () => {
    const r = selectPlacementRelay(relays, 60);
    expect(r?.minerId).toBe('C'); // B and C tie on ratio; C has rtt 40 < 80
  });
  it('returns null when every relay would exceed C_worker (defer)', () => {
    const full = relays.map((x) => ({ ...x, attestedLoadPaths: 295 }));
    expect(selectPlacementRelay(full, 60)).toBeNull();
  });
});

describe('REQ-RMS-018 poolHealthGate — admit only if >= K_r healthy (fresh heartbeat + canary-healthy)', () => {
  const mk = (minerId: string, hbEpochs: number, canaryOk: boolean): RelayCapacity =>
    ({ minerId, attestedLoadPaths: 0, cWorker: 300, rtt: 0n, heartbeatFreshEpochs: hbEpochs, canaryHealthy: canaryOk });
  it('counts a relay healthy iff heartbeat < STALE(7) AND canary success-rate ok', () => {
    const pool = [mk('A', 1, true), mk('B', 2, true), mk('C', 9, true) /* stale */, mk('D', 1, false) /* canary bad */];
    expect(poolHealthGate(pool, 2)).toBe(true);  // A,B healthy >= K_r=2
    expect(poolHealthGate(pool, 3)).toBe(false); // only 2 healthy < 3
  });
});

describe('REQ-RMS-013 poolSize — M = ceil(sum L_r / C_relay)*(1+redundancy)+byzantine_margin', () => {
  it('derives the demo M for R~20-30 rooms x ~270 paths', () => {
    // 25 rooms * 270 paths = 6750; C_relay (cores 4 * C_worker 300) = 1200
    // ceil(6750/1200)=6; *(1+0.2)=7.2 -> ceil 8; +1 byzantine = 9 (formula-derived demo upper bound)
    expect(poolSize(25 * 270, 1200, 0.2, 1)).toBe(9);
  });
  it('a tiny load floors at >= min_relay so a demo M=5 is justified, not arbitrary', () => {
    // sum 500 / C_relay 1200 = ceil 1; *1.2 -> 2; +1 = 3; clamp to >= 2 min_relay -> 3
    expect(poolSize(500, 1200, 0.2, 1)).toBe(3);
  });
});
