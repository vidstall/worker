/**
 * PeerStatsWindow — ring-buffer store of client-reported call-quality samples.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PeerStatsWindow,
  getGlobalStatsWindow,
  resetGlobalStatsWindowForTests,
  type PeerQualitySample,
} from '../stats-window.js';

function sample(overrides: Partial<PeerQualitySample> = {}): PeerQualitySample {
  return {
    latencyMs: 50,
    packetLoss: 0,
    jitterMs: 5,
    bitrateUpKbps: 1000,
    bitrateDownKbps: 2000,
    resolutionWidth: 1280,
    resolutionHeight: 720,
    framerate: 30,
    packetReorderingRate: 0,
    encodeLatencyMs: 10,
    decodeLatencyMs: 8,
    freezeCount: 0,
    pauseCount: 0,
    connectionSetupMs: 200,
    iceSuccess: true,
    reconnectMs: 0,
    ...overrides,
  };
}

describe('PeerStatsWindow', () => {
  let window: PeerStatsWindow;

  beforeEach(() => {
    window = new PeerStatsWindow();
  });

  it('current() is undefined before any push', () => {
    expect(window.current('peer-a')).toBeUndefined();
  });

  it('push then current() returns the latest raw fields for non-smoothed fields', () => {
    window.push('room-1', 'peer-a', sample({ packetLoss: 3, freezeCount: 2 }));
    const current = window.current('peer-a');
    expect(current).toBeDefined();
    expect(current!.roomId).toBe('room-1');
    expect(current!.packetLoss).toBe(3);
    expect(current!.freezeCount).toBe(2);
  });

  it('smooths latencyMs/jitterMs/encodeLatencyMs/decodeLatencyMs via moving average', () => {
    window.push('room-1', 'peer-a', sample({ latencyMs: 100, jitterMs: 10 }));
    window.push('room-1', 'peer-a', sample({ latencyMs: 200, jitterMs: 20 }));
    const current = window.current('peer-a');
    expect(current!.latencyMs).toBe(150);
    expect(current!.jitterMs).toBe(15);
  });

  it('retains at most the last 5 samples (ring buffer)', () => {
    for (let i = 1; i <= 7; i++) {
      window.push('room-1', 'peer-a', sample({ latencyMs: i * 10 }));
    }
    // Only the last 5 pushes (30,40,50,60,70) should factor into the average.
    const current = window.current('peer-a');
    expect(current!.latencyMs).toBe((30 + 40 + 50 + 60 + 70) / 5);
  });

  it('tracks independent windows per peerId', () => {
    window.push('room-1', 'peer-a', sample({ latencyMs: 10 }));
    window.push('room-1', 'peer-b', sample({ latencyMs: 999 }));
    expect(window.current('peer-a')!.latencyMs).toBe(10);
    expect(window.current('peer-b')!.latencyMs).toBe(999);
  });

  it('peerIds() lists every peer with a retained sample', () => {
    window.push('room-1', 'peer-a', sample());
    window.push('room-1', 'peer-b', sample());
    expect(window.peerIds().sort()).toEqual(['peer-a', 'peer-b']);
  });

  it('clear() drops a peer window entirely', () => {
    window.push('room-1', 'peer-a', sample());
    window.clear('peer-a');
    expect(window.current('peer-a')).toBeUndefined();
    expect(window.peerIds()).not.toContain('peer-a');
  });

  it('current() carries lastUpdatedAt from the latest push', () => {
    window.push('room-1', 'peer-a', sample(), 1000);
    window.push('room-1', 'peer-a', sample(), 2000);
    expect(window.current('peer-a')!.lastUpdatedAt).toBe(2000);
  });
});

describe('getGlobalStatsWindow', () => {
  beforeEach(() => resetGlobalStatsWindowForTests());

  it('returns the same instance across calls', () => {
    expect(getGlobalStatsWindow()).toBe(getGlobalStatsWindow());
  });

  it('resetGlobalStatsWindowForTests() mints a fresh instance', () => {
    const first = getGlobalStatsWindow();
    resetGlobalStatsWindowForTests();
    expect(getGlobalStatsWindow()).not.toBe(first);
  });
});
