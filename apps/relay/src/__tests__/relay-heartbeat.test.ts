/**
 * Unit tests for relay-heartbeat.ts (REQ-RO-006).
 *
 * TDD contract — RED cases:
 *   1. 3 consecutive missed pings → onStandbyReady called exactly once.
 *   2. 2 misses then 1 success → onStandbyReady NOT called (miss counter resets).
 *   3. onStandbyReady fires once even if misses continue past threshold (idempotent).
 *   4. stop() cancels interval — no further callbacks.
 *   5. Boundary: exactly at missThreshold (not threshold-1).
 *
 * Uses vitest fake-timers to control time deterministically.
 * HTTP pings are mocked (no network).
 *
 * Requirements: REQ-RO-006
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRelayHeartbeat, setTestPingFn } from '../relay-heartbeat.js';

// ── ping mock strategy ────────────────────────────────────────────────
// relay-heartbeat's ping() function calls pingFn internally. We inject a
// mockPingFn instead of mocking the http module directly. The module
// exports a setTestPingFn() hook for test-only injection.

// Queue of ping results to return in order
const pingQueue: boolean[] = [];

function mockHttpSuccess(): void {
  pingQueue.push(true);
}

function mockHttpFailure(): void {
  pingQueue.push(false);
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('createRelayHeartbeat (REQ-RO-006)', () => {
  const INTERVAL_MS = 1000;
  const MISS_THRESHOLD = 3;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    pingQueue.length = 0;
    // Install test ping function that dequeues from pingQueue
    setTestPingFn(async () => {
      const result = pingQueue.shift();
      if (result === undefined) return true; // default success if queue empty
      return result;
    });
  });

  afterEach(() => {
    setTestPingFn(null);
    vi.useRealTimers();
  });

  it('RED-RO-006-1: 3 consecutive misses → onStandbyReady called exactly once', async () => {
    const onStandbyReady = vi.fn();
    mockHttpFailure();
    mockHttpFailure();
    mockHttpFailure();

    const ctrl = createRelayHeartbeat('room-1', 'http://primary:4000', onStandbyReady, {
      intervalMs: INTERVAL_MS,
      missThreshold: MISS_THRESHOLD,
    });
    ctrl.start();

    // Advance through 3 intervals
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3 + 100);

    expect(onStandbyReady).toHaveBeenCalledExactlyOnceWith('room-1');
    ctrl.stop();
  });

  it('RED-RO-006-2: 2 misses then 1 success → onStandbyReady NOT called', async () => {
    const onStandbyReady = vi.fn();
    mockHttpFailure();
    mockHttpFailure();
    mockHttpSuccess();

    const ctrl = createRelayHeartbeat('room-2', 'http://primary:4000', onStandbyReady, {
      intervalMs: INTERVAL_MS,
      missThreshold: MISS_THRESHOLD,
    });
    ctrl.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3 + 100);

    expect(onStandbyReady).not.toHaveBeenCalled();
    ctrl.stop();
  });

  it('RED-RO-006-3: onStandbyReady fires ONCE even with 5 consecutive misses (idempotent)', async () => {
    const onStandbyReady = vi.fn();
    // Queue 5 failures
    for (let i = 0; i < 5; i++) mockHttpFailure();

    const ctrl = createRelayHeartbeat('room-3', 'http://primary:4000', onStandbyReady, {
      intervalMs: INTERVAL_MS,
      missThreshold: MISS_THRESHOLD,
    });
    ctrl.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5 + 100);

    // Only once — idempotent
    expect(onStandbyReady).toHaveBeenCalledExactlyOnceWith('room-3');
    ctrl.stop();
  });

  it('RED-RO-006-4: stop() cancels the interval — no further pings after stop', async () => {
    const onStandbyReady = vi.fn();
    mockHttpFailure();
    mockHttpFailure();

    const ctrl = createRelayHeartbeat('room-4', 'http://primary:4000', onStandbyReady, {
      intervalMs: INTERVAL_MS,
      missThreshold: MISS_THRESHOLD,
    });
    ctrl.start();

    // Advance 2 intervals (2 misses — not yet threshold)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2 + 100);

    ctrl.stop();

    // Queue a 3rd failure — but stop() should prevent it from firing
    mockHttpFailure();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3 + 100);

    expect(onStandbyReady).not.toHaveBeenCalled();
  });

  it('boundary: exactly 2 misses (threshold-1) → no callback', async () => {
    const onStandbyReady = vi.fn();
    mockHttpFailure();
    mockHttpFailure();
    // 3rd is success — reset
    mockHttpSuccess();

    const ctrl = createRelayHeartbeat('room-5', 'http://primary:4000', onStandbyReady, {
      intervalMs: INTERVAL_MS,
      missThreshold: MISS_THRESHOLD,
    });
    ctrl.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2 + 100);
    expect(onStandbyReady).not.toHaveBeenCalled();

    ctrl.stop();
  });

  it('success after threshold-3 resets miss counter', async () => {
    const onStandbyReady = vi.fn();
    mockHttpFailure();
    mockHttpFailure();
    mockHttpSuccess(); // resets counter at miss=2
    mockHttpFailure();
    mockHttpFailure();
    // Still only 2 misses after reset — no fire

    const ctrl = createRelayHeartbeat('room-6', 'http://primary:4000', onStandbyReady, {
      intervalMs: INTERVAL_MS,
      missThreshold: MISS_THRESHOLD,
    });
    ctrl.start();

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 5 + 100);

    expect(onStandbyReady).not.toHaveBeenCalled();
    ctrl.stop();
  });
});

describe('createRelayHeartbeat — peerUrl scheme normalization (TLS gap fix)', () => {
  const INTERVAL_MS = 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setTestPingFn(null);
    vi.useRealTimers();
  });

  /**
   * Production primaryUrl values are public wss:// endpoints (same registry
   * the browser client reads — relay_registry's on-chain endpoint_url).
   * ping()'s underlying transport picks http vs https by inspecting the
   * SAME normalized URL the test seam receives here, so asserting on the
   * seam's captured URL pins the exact normalization contract without
   * reaching into Node's http/https modules directly.
   */
  it.each([
    ['wss://primary.example.com:4000', 'https://primary.example.com:4000/healthz'],
    ['ws://primary.example.com:4000', 'http://primary.example.com:4000/healthz'],
    ['https://primary.example.com:4000', 'https://primary.example.com:4000/healthz'],
    ['http://primary.example.com:4000', 'http://primary.example.com:4000/healthz'],
  ])('normalizes %s to a pingable %s', async (peerUrl, expectedPingUrl) => {
    const seenUrls: string[] = [];
    setTestPingFn(async (url) => {
      seenUrls.push(url);
      return true;
    });

    const ctrl = createRelayHeartbeat('room-scheme', peerUrl, vi.fn(), { intervalMs: INTERVAL_MS });
    ctrl.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    ctrl.stop();

    expect(seenUrls[0]).toBe(expectedPingUrl);
  });

  it('falls back to the raw peerUrl on a malformed URL (fails the ping, not the constructor)', async () => {
    const seenUrls: string[] = [];
    setTestPingFn(async (url) => {
      seenUrls.push(url);
      return true;
    });

    expect(() =>
      createRelayHeartbeat('room-malformed', 'not-a-url', vi.fn(), { intervalMs: INTERVAL_MS }),
    ).not.toThrow();

    const ctrl = createRelayHeartbeat('room-malformed', 'not-a-url', vi.fn(), { intervalMs: INTERVAL_MS });
    ctrl.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS + 100);
    ctrl.stop();

    expect(seenUrls.at(-1)).toBe('not-a-url/healthz');
  });
});
