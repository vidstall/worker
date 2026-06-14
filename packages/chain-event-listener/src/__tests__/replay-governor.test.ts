/**
 * P17 M2b-P2 (REQ-DOH-027) — ReplayGovernor (PURE, ISOLATED unit).
 *
 * A token-bucket throttle (`acquire()` admits ~rateLimitHz/sec DURING replay,
 * resolves IMMEDIATELY after `goLive()`) + a per-restart event cap (`tick()`
 * returns false / `capExceeded` flips true once `maxEvents` is exceeded). The
 * cap is per-ReplayGovernor-INSTANCE (one instance per listener/module — the
 * decided default; NOT a shared cross-module counter). NOT wired into the
 * listener here — that is P3.
 *
 * Determinism: the bucket reads time through an INJECTED `now` (default
 * `Date.now`). The throttle wait is a `setTimeout`, so vitest fake timers make
 * the spacing exact (mirrors the @dvconf/health-monitor cooldown tests, which
 * also gate on a mocked clock). `readReplayGovernorConfig` mirrors the
 * `readCooldownMs` env idiom: Number() parse, blank-string guard, explicit 0
 * honored; env mutations restored in a finally (as the P1 DATA_DIR tests do).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReplayGovernor, readReplayGovernorConfig } from '../replay-governor.js';

describe('ReplayGovernor — replay throttle (P2, DOH-027)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('admits a burst up to the bucket then throttles the next acquire by ~1/rateLimitHz', async () => {
    // rateLimitHz = 100 -> one token every 10ms. A fresh bucket holds `rateLimitHz`
    // tokens, so the first `rateLimitHz` acquires resolve instantly; the next must
    // wait until a token refills (~10ms).
    const g = new ReplayGovernor(100, 1000, () => Date.now());

    // Drain the full initial bucket — all resolve in the same fake-time instant.
    for (let i = 0; i < 100; i++) {
      await g.acquire();
    }

    // The (rateLimitHz+1)-th acquire has no token: it must NOT resolve yet.
    let resolved = false;
    const pending = g.acquire().then(() => {
      resolved = true;
    });

    // Not enough time for a refill (need ~10ms): still pending.
    await vi.advanceTimersByTimeAsync(9);
    expect(resolved).toBe(false);

    // Cross the 10ms boundary -> a token refills -> the throttled acquire resolves.
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
    // 15s per-test timeout: headroom against the root config's tight 10s testTimeout
    // on a COLD vitest transform/setup (the fake-timer logic itself runs in <20ms warm).
  }, 15000);

  it('spaces consecutive throttled acquires by the token interval', async () => {
    const g = new ReplayGovernor(100, 1000, () => Date.now());
    // Empty the bucket.
    for (let i = 0; i < 100; i++) await g.acquire();

    let r1 = false;
    let r2 = false;
    const p1 = g.acquire().then(() => (r1 = true));
    const p2 = g.acquire().then(() => (r2 = true));

    await vi.advanceTimersByTimeAsync(10); // first refill -> p1 only
    await p1;
    expect(r1).toBe(true);
    expect(r2).toBe(false); // p2 still waiting for the SECOND token

    await vi.advanceTimersByTimeAsync(10); // second refill -> p2
    await p2;
    expect(r2).toBe(true);
  }, 15000); // cold-start headroom (see the burst test above)
});

describe('ReplayGovernor — goLive (P2, DOH-027)', () => {
  it('after goLive() acquire() resolves immediately even when the bucket is empty (no fake-time advance)', async () => {
    // No fake timers here ON PURPOSE: a real microtask must settle without any
    // timer being advanced. If goLive used a setTimeout this would hang the test.
    const g = new ReplayGovernor(1, 1000, () => Date.now()); // tiny rate => bucket empties fast
    await g.acquire(); // drains the single initial token
    g.goLive();

    // These would each need ~1s under the throttle; after goLive they resolve now.
    await g.acquire();
    await g.acquire();
    await g.acquire();
    // Reaching here without a timer advance proves immediate resolution.
    expect(true).toBe(true);
  });

  it('goLive resolves an already-pending throttled acquire immediately', async () => {
    vi.useFakeTimers();
    try {
      const g = new ReplayGovernor(1, 1000, () => Date.now());
      await g.acquire(); // drain the initial token

      let resolved = false;
      const pending = g.acquire().then(() => (resolved = true)); // would wait ~1s
      expect(resolved).toBe(false);

      g.goLive(); // flips to live -> the waiter is released without advancing time
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ReplayGovernor — per-restart cap (P2, DOH-027)', () => {
  it('tick() returns true for the first maxEvents calls and false on maxEvents+1; capExceeded flips and stays', () => {
    const g = new ReplayGovernor(100, 3, () => Date.now());
    expect(g.capExceeded).toBe(false);

    expect(g.tick()).toBe(true); // 1
    expect(g.tick()).toBe(true); // 2
    expect(g.tick()).toBe(true); // 3 (== maxEvents, still admitted)
    expect(g.capExceeded).toBe(false);

    expect(g.tick()).toBe(false); // 4 -> exceeds the cap
    expect(g.capExceeded).toBe(true);

    expect(g.tick()).toBe(false); // stays false / exceeded
    expect(g.capExceeded).toBe(true);
  });

  it('maxEvents = 0 exceeds on the very first tick', () => {
    const g = new ReplayGovernor(100, 0, () => Date.now());
    expect(g.capExceeded).toBe(false);
    expect(g.tick()).toBe(false);
    expect(g.capExceeded).toBe(true);
  });
});

describe('readReplayGovernorConfig (P2, DOH-027)', () => {
  it('defaults to { rateLimitHz: 100, maxEvents: 1000 } when env is unset', () => {
    expect(readReplayGovernorConfig({})).toEqual({ rateLimitHz: 100, maxEvents: 1000 });
  });

  it('reads REPLAY_RATE_LIMIT_HZ / REPLAY_MAX_EVENTS_PER_RESTART overrides', () => {
    const env = { REPLAY_RATE_LIMIT_HZ: '50', REPLAY_MAX_EVENTS_PER_RESTART: '200' };
    expect(readReplayGovernorConfig(env)).toEqual({ rateLimitHz: 50, maxEvents: 200 });
  });

  it('overrides each field INDEPENDENTLY', () => {
    expect(readReplayGovernorConfig({ REPLAY_RATE_LIMIT_HZ: '25' })).toEqual({
      rateLimitHz: 25,
      maxEvents: 1000,
    });
    expect(readReplayGovernorConfig({ REPLAY_MAX_EVENTS_PER_RESTART: '5' })).toEqual({
      rateLimitHz: 100,
      maxEvents: 5,
    });
  });

  it('falls back to defaults on a blank or non-numeric value (no Number("")===0 masking)', () => {
    expect(readReplayGovernorConfig({ REPLAY_RATE_LIMIT_HZ: '   ', REPLAY_MAX_EVENTS_PER_RESTART: 'abc' })).toEqual({
      rateLimitHz: 100,
      maxEvents: 1000,
    });
  });

  it('honors an explicit 0 (not treated as a falsy fallback)', () => {
    expect(readReplayGovernorConfig({ REPLAY_RATE_LIMIT_HZ: '0', REPLAY_MAX_EVENTS_PER_RESTART: '0' })).toEqual({
      rateLimitHz: 0,
      maxEvents: 0,
    });
  });

  it('reads process.env when no env is passed (restores any mutation in finally)', () => {
    const prevRate = process.env.REPLAY_RATE_LIMIT_HZ;
    const prevMax = process.env.REPLAY_MAX_EVENTS_PER_RESTART;
    process.env.REPLAY_RATE_LIMIT_HZ = '7';
    process.env.REPLAY_MAX_EVENTS_PER_RESTART = '77';
    try {
      expect(readReplayGovernorConfig()).toEqual({ rateLimitHz: 7, maxEvents: 77 });
    } finally {
      if (prevRate === undefined) delete process.env.REPLAY_RATE_LIMIT_HZ;
      else process.env.REPLAY_RATE_LIMIT_HZ = prevRate;
      if (prevMax === undefined) delete process.env.REPLAY_MAX_EVENTS_PER_RESTART;
      else process.env.REPLAY_MAX_EVENTS_PER_RESTART = prevMax;
    }
  });
});
