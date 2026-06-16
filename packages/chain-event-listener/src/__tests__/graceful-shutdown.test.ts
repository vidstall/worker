/**
 * P17 M2b-P5 (REQ-DOH-021/022/023) — runGracefulShutdown orchestrator.
 *
 * A PURE, exit-injected ordered-teardown sequence:
 *   (1) setAccepting(false)
 *   (2) race(drain, DRAIN_TIMEOUT_MS=30000)        — a hung drain unblocks (DOH-022)
 *   (3) stopReactive                                — chain listeners + business
 *                                                     pollers + HealthMonitor (C-A)
 *   (4) stopHeartbeatAndHealthz                     — heartbeat + /healthz LAST
 *                                                     (the P15 split-brain fix)
 *   (5) exit(0)
 * A FORCE_KILL_TIMEOUT_MS=60000 timer wraps the WHOLE sequence → exit(1) (DOH-023).
 *
 * These tests inject every collaborator as a spy and assert the call order via a
 * shared log; the two timeout paths are driven under vitest fake timers with an
 * injected `exit` (never actually terminates the test runner). `exit` is also the
 * exactly-once latch under test: a force-kill that wins a race against a late
 * normal completion must exit exactly once.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  runGracefulShutdown,
  readGracefulShutdownConfig,
  type GracefulShutdownPlan,
} from '../graceful-shutdown.js';

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

function makePlan(over: Partial<GracefulShutdownPlan> = {}) {
  const calls: string[] = [];
  const logger = mockLogger();
  const exit = vi.fn((code: number) => {
    calls.push(`exit(${code})`);
  }) as unknown as (code: number) => never;
  const setAccepting = vi.fn((accepting: boolean) => {
    calls.push(`setAccepting(${accepting})`);
  });
  const drain = vi.fn(async () => {
    calls.push('drain');
  });
  const stopReactive = vi.fn(async () => {
    calls.push('stopReactive');
  });
  const stopHeartbeatAndHealthz = vi.fn(async () => {
    calls.push('stopHeartbeatAndHealthz');
  });
  const plan: GracefulShutdownPlan = {
    reason: 'test',
    logger,
    setAccepting,
    drain,
    stopReactive,
    stopHeartbeatAndHealthz,
    exit,
    ...over,
  };
  return { plan, calls, logger, exit, setAccepting, drain, stopReactive, stopHeartbeatAndHealthz };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runGracefulShutdown (P5, DOH-021/022/023)', () => {
  it('RED-1: runs the full teardown in order setAccepting(false)→drain→stopReactive→stopHeartbeatAndHealthz→exit(0) (DOH-021)', async () => {
    const { plan, calls, exit } = makePlan();
    await runGracefulShutdown(plan);
    expect(calls).toEqual([
      'setAccepting(false)',
      'drain',
      'stopReactive',
      'stopHeartbeatAndHealthz',
      'exit(0)',
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('RED-2: stopHeartbeatAndHealthz does NOT begin until stopReactive fully completes (C-A / teardown-LAST)', async () => {
    const order: string[] = [];
    const { plan } = makePlan({
      stopReactive: vi.fn(async () => {
        order.push('reactive:start');
        await Promise.resolve();
        await Promise.resolve();
        order.push('reactive:end');
      }),
      stopHeartbeatAndHealthz: vi.fn(async () => {
        order.push('hb:start');
      }),
    });
    await runGracefulShutdown(plan);
    expect(order).toEqual(['reactive:start', 'reactive:end', 'hb:start']);
  });

  it('RED-3: a hung drain unblocks at DRAIN_TIMEOUT_MS=30000 then the sequence proceeds to exit(0) (DOH-022 default + race)', async () => {
    vi.useFakeTimers();
    const { plan, exit, stopReactive } = makePlan({
      drain: vi.fn(() => new Promise<void>(() => {})), // never resolves
    });
    const p = runGracefulShutdown(plan);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(stopReactive).not.toHaveBeenCalled(); // still draining
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 30000 → drain race resolves
    await p;
    expect(stopReactive).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  }, 15000);

  it('RED-4: a hung sequence is force-killed at FORCE_KILL_TIMEOUT_MS=60000 → exit(1), never exit(0) (DOH-023 default)', async () => {
    vi.useFakeTimers();
    const { plan, exit } = makePlan({
      drain: vi.fn(async () => {}),
      stopReactive: vi.fn(() => new Promise<void>(() => {})), // hangs forever
    });
    void runGracefulShutdown(plan); // never resolves — do not await
    await vi.advanceTimersByTimeAsync(59_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 60000 → force kill
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  }, 15000);

  it('RED-5: force-kill is exactly-once — a late normal completion does NOT also exit(0) (one-shot latch)', async () => {
    vi.useFakeTimers();
    let releaseReactive: (() => void) | undefined;
    const { plan, exit } = makePlan({
      drain: vi.fn(async () => {}),
      stopReactive: vi.fn(
        () =>
          new Promise<void>((r) => {
            releaseReactive = r;
          }),
      ),
    });
    const p = runGracefulShutdown(plan);
    await vi.advanceTimersByTimeAsync(60_000); // force kill → exit(1)
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    releaseReactive!(); // stopReactive now resolves → would reach exit(0)
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(exit).toHaveBeenCalledTimes(1); // STILL once — exit(0) suppressed
    expect(exit).toHaveBeenLastCalledWith(1);
  }, 15000);

  it('RED-6: a clean completion clears the force-kill timer — no late exit(1) (DOH-023)', async () => {
    vi.useFakeTimers();
    const { plan, exit } = makePlan();
    const p = runGracefulShutdown(plan);
    await vi.advanceTimersByTimeAsync(0); // instant teardown → exit(0)
    await p;
    expect(exit).toHaveBeenCalledWith(0);
    await vi.advanceTimersByTimeAsync(120_000); // long past force-kill
    expect(exit).toHaveBeenCalledTimes(1); // no spurious exit(1)
  }, 15000);

  it('RED-7: a rejected drain is swallowed (logged) — the sequence still proceeds to exit(0)', async () => {
    const { plan, calls, logger, exit } = makePlan({
      drain: vi.fn(() => Promise.reject(new Error('drain boom'))),
    });
    await runGracefulShutdown(plan);
    expect(logger.warn).toHaveBeenCalled();
    expect(calls).toContain('stopReactive');
    expect(calls).toContain('stopHeartbeatAndHealthz');
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('RED-8: a teardown error (stopReactive throws) → exit(1), error logged, force timer cleared', async () => {
    vi.useFakeTimers();
    const { plan, logger, exit, stopHeartbeatAndHealthz } = makePlan({
      stopReactive: vi.fn(() => Promise.reject(new Error('reactive boom'))),
    });
    const p = runGracefulShutdown(plan);
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
    expect(stopHeartbeatAndHealthz).not.toHaveBeenCalled(); // short-circuits to exit(1)
    await vi.advanceTimersByTimeAsync(120_000);
    expect(exit).toHaveBeenCalledTimes(1); // force timer was cleared
  }, 15000);

  it('RED-9: a custom drainTimeoutMs is honored', async () => {
    vi.useFakeTimers();
    const { plan, exit, stopReactive } = makePlan({
      drain: vi.fn(() => new Promise<void>(() => {})),
      drainTimeoutMs: 5_000,
    });
    const p = runGracefulShutdown(plan);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stopReactive).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 5000 → custom drain timeout
    await p;
    expect(stopReactive).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  }, 15000);

  it('RED-10: a custom forceKillTimeoutMs is honored', async () => {
    vi.useFakeTimers();
    const { plan, exit } = makePlan({
      drain: vi.fn(async () => {}),
      stopReactive: vi.fn(() => new Promise<void>(() => {})),
      forceKillTimeoutMs: 8_000,
    });
    void runGracefulShutdown(plan);
    await vi.advanceTimersByTimeAsync(7_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); // 8000 → custom force kill
    expect(exit).toHaveBeenCalledWith(1);
  }, 15000);

  it('RED-11: setAccepting(false) is called before drain begins (stop-accept first)', async () => {
    const seen: string[] = [];
    const { plan } = makePlan({
      setAccepting: vi.fn(() => {
        seen.push('accept');
      }),
      drain: vi.fn(async () => {
        seen.push('drain');
      }),
    });
    await runGracefulShutdown(plan);
    expect(seen[0]).toBe('accept');
    expect(seen[1]).toBe('drain');
  });
});

describe('readGracefulShutdownConfig (P5, DOH-022/023 env)', () => {
  it('RED-12: defaults to 30000 drain / 60000 force-kill when env is unset', () => {
    expect(readGracefulShutdownConfig({})).toEqual({
      drainTimeoutMs: 30_000,
      forceKillTimeoutMs: 60_000,
    });
  });

  it('RED-13: reads DRAIN_TIMEOUT_MS / FORCE_KILL_TIMEOUT_MS from env', () => {
    expect(
      readGracefulShutdownConfig({
        DRAIN_TIMEOUT_MS: '15000',
        FORCE_KILL_TIMEOUT_MS: '45000',
      }),
    ).toEqual({ drainTimeoutMs: 15_000, forceKillTimeoutMs: 45_000 });
  });

  it('RED-14: blank/NaN fall back to defaults; an explicit 0 is honored', () => {
    expect(
      readGracefulShutdownConfig({ DRAIN_TIMEOUT_MS: '   ', FORCE_KILL_TIMEOUT_MS: 'abc' }),
    ).toEqual({ drainTimeoutMs: 30_000, forceKillTimeoutMs: 60_000 });
    expect(readGracefulShutdownConfig({ DRAIN_TIMEOUT_MS: '0' }).drainTimeoutMs).toBe(0);
  });
});
