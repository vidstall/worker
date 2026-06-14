/**
 * Phase 12 gap tests: MetricsTracker unit tests.
 * Closes GAP-12-07.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MetricsTracker } from '../metrics.js';

describe('MetricsTracker', () => {
  let metrics: MetricsTracker;

  beforeEach(() => {
    metrics = new MetricsTracker();
  });

  it('starts with zero active sessions', () => {
    expect(metrics.getActiveSessionCount()).toBe(0);
    expect(metrics.getTotalBytesForwarded()).toBe(0n);
  });

  it('trackBytes creates a new session entry', () => {
    metrics.trackBytes('room-1', 'peer-a', 1000);

    expect(metrics.getActiveSessionCount()).toBe(1);

    const session = metrics.getSessionMetrics('room-1', 'peer-a');
    expect(session).toBeDefined();
    expect(session!.roomId).toBe('room-1');
    expect(session!.peerId).toBe('peer-a');
    expect(session!.bytesForwarded).toBe(1000n);
    expect(session!.packetsLost).toBe(0);
    expect(session!.jitter).toBe(0);
    expect(session!.startedAt).toBeGreaterThan(0);
  });

  it('trackBytes accumulates bytes for existing session', () => {
    metrics.trackBytes('room-1', 'peer-a', 1000);
    metrics.trackBytes('room-1', 'peer-a', 2000);

    const session = metrics.getSessionMetrics('room-1', 'peer-a');
    expect(session!.bytesForwarded).toBe(3000n);
    expect(metrics.getActiveSessionCount()).toBe(1);
  });

  it('getTotalBytesForwarded sums across all sessions', () => {
    metrics.trackBytes('room-1', 'peer-a', 1000);
    metrics.trackBytes('room-1', 'peer-b', 2000);
    metrics.trackBytes('room-2', 'peer-c', 3000);

    expect(metrics.getTotalBytesForwarded()).toBe(6000n);
    expect(metrics.getActiveSessionCount()).toBe(3);
  });

  it('updateQuality updates packet loss and jitter', () => {
    metrics.trackBytes('room-1', 'peer-a', 0);
    metrics.updateQuality('room-1', 'peer-a', 5, 12);

    const session = metrics.getSessionMetrics('room-1', 'peer-a');
    expect(session!.packetsLost).toBe(5);
    expect(session!.jitter).toBe(12);
  });

  it('updateQuality does nothing for non-existent session', () => {
    metrics.updateQuality('room-1', 'peer-a', 5, 12);
    expect(metrics.getSessionMetrics('room-1', 'peer-a')).toBeUndefined();
  });

  it('clearSession removes a specific peer session', () => {
    metrics.trackBytes('room-1', 'peer-a', 1000);
    metrics.trackBytes('room-1', 'peer-b', 2000);

    metrics.clearSession('room-1', 'peer-a');

    expect(metrics.getActiveSessionCount()).toBe(1);
    expect(metrics.getSessionMetrics('room-1', 'peer-a')).toBeUndefined();
    expect(metrics.getSessionMetrics('room-1', 'peer-b')).toBeDefined();
  });

  it('clearRoom removes all sessions for a room', () => {
    metrics.trackBytes('room-1', 'peer-a', 1000);
    metrics.trackBytes('room-1', 'peer-b', 2000);
    metrics.trackBytes('room-2', 'peer-c', 3000);

    metrics.clearRoom('room-1');

    expect(metrics.getActiveSessionCount()).toBe(1);
    expect(metrics.getSessionMetrics('room-1', 'peer-a')).toBeUndefined();
    expect(metrics.getSessionMetrics('room-1', 'peer-b')).toBeUndefined();
    expect(metrics.getSessionMetrics('room-2', 'peer-c')).toBeDefined();
  });

  it('getSessionMetrics returns undefined for unknown session', () => {
    expect(metrics.getSessionMetrics('room-x', 'peer-x')).toBeUndefined();
  });

  // P17 M2a-P11: F61 packet-loss health signal (DOH-014). Non-vacuous — proves the
  // getter sums per-session packetsLost (and reads 0 with no sessions / no quality feed).
  it('getGlobalPacketLossBps sums packetsLost across sessions (0 when none)', () => {
    expect(metrics.getGlobalPacketLossBps()).toBe(0);
    metrics.trackBytes('room-1', 'peer-a', 1000);
    metrics.trackBytes('room-1', 'peer-b', 2000);
    expect(metrics.getGlobalPacketLossBps()).toBe(0); // no quality feed yet
    metrics.updateQuality('room-1', 'peer-a', 700, 5);
    metrics.updateQuality('room-1', 'peer-b', 300, 3);
    expect(metrics.getGlobalPacketLossBps()).toBe(1000);
  });
});
