/**
 * P17 M2a-P6 (REQ-DOH-013 / REQ-DOH-018) — HealthMonitor level state machine.
 *
 * The generic F61 self-degradation core: poll signals -> map each to 0/1/2 ->
 * worst-wins MAX -> report on a level CHANGE. Fail-OPEN on a reader error
 * (level 0 + a WARN log). Cooldown (P7), the chain reporter (P8) and the
 * isPaused gate (P9) layer on later — NOT exercised here.
 *
 * Mirrors the @dvconf/shared test idiom: cast mock logger, fake timers for the
 * interval, no real chain. Covers the ROADMAP P6 RED set:
 *   0->1->2 escalation, 2->0 recovery, worst-wins (max), reader-throws->L0+WARN.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HealthMonitor,
  type HealthLevel,
  type HealthSignal,
  type SignalSample,
  type DegradationReporter,
} from '../health-monitor.js';

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

/** A reporter that records every level handed to it (mock chain sink). */
function recordingReporter() {
  const levels: HealthLevel[] = [];
  const reporter: DegradationReporter = {
    report: vi.fn(async (level: HealthLevel) => {
      levels.push(level);
      return true;
    }),
  };
  return { reporter, levels };
}

/** A signal whose returned sample (or thrown error) we mutate between ticks. */
function controllableSignal(name = 'ctl') {
  let next: SignalSample | null = { value: 0, level: 0 };
  let thrown: unknown;
  const signal: HealthSignal = {
    name,
    read: () => {
      if (thrown !== undefined) throw thrown;
      return next;
    },
  };
  return {
    signal,
    set: (s: SignalSample | null) => {
      thrown = undefined;
      next = s;
    },
    setThrow: (e: unknown) => {
      thrown = e;
    },
  };
}

describe('HealthMonitor — level state machine (P6)', () => {
  it('starts healthy and stays silent when the first tick is level 0', async () => {
    const { reporter, levels } = recordingReporter();
    const { signal } = controllableSignal();
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger() });

    await m.tick();

    expect(m.level).toBe(0);
    expect(levels).toEqual([]); // a healthy startup emits no NodeDegraded
  });

  it('escalates 0 -> 1 -> 2 and reports each transition', async () => {
    const { reporter, levels } = recordingReporter();
    const { signal, set } = controllableSignal();
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger() });

    set({ value: 0, level: 0 });
    await m.tick();
    expect(m.level).toBe(0);

    set({ value: 0, level: 1 });
    await m.tick();
    expect(m.level).toBe(1);

    set({ value: 0, level: 2 });
    await m.tick();
    expect(m.level).toBe(2);

    expect(levels).toEqual([1, 2]);
  });

  it('recovers 2 -> 0 and reports the recovery', async () => {
    const { reporter, levels } = recordingReporter();
    const { signal, set } = controllableSignal();
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger() });

    set({ value: 0, level: 2 });
    await m.tick();
    set({ value: 0, level: 0 });
    await m.tick();

    expect(m.level).toBe(0);
    expect(levels).toEqual([2, 0]);
  });

  it('does not re-report an unchanged level', async () => {
    const { reporter, levels } = recordingReporter();
    const { signal, set } = controllableSignal();
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger() });

    set({ value: 0, level: 1 });
    await m.tick();
    await m.tick(); // still level 1
    await m.tick();

    expect(levels).toEqual([1]); // reported exactly once, on the change
  });

  it('aggregates worst-wins (MAX) across multiple signals', async () => {
    const { reporter, levels } = recordingReporter();
    const a = controllableSignal('a');
    const b = controllableSignal('b');
    a.set({ value: 0, level: 1 });
    b.set({ value: 0, level: 2 });
    const m = new HealthMonitor({ signals: [a.signal, b.signal], reporter, logger: mockLogger() });

    await m.tick();

    expect(m.level).toBe(2);
    expect(levels).toEqual([2]);
  });

  it('maps a raw value through thresholds when no explicit level is given', async () => {
    const { reporter } = recordingReporter();
    let value = 10;
    const signal: HealthSignal = {
      name: 'cpu',
      read: () => ({ value }),
      thresholds: { degradedAt: 70, unhealthyAt: 90 },
    };
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger() });

    value = 10;
    await m.tick();
    expect(m.level).toBe(0);

    value = 75;
    await m.tick();
    expect(m.level).toBe(1);

    value = 95;
    await m.tick();
    expect(m.level).toBe(2);
  });

  it('fails open: a reader that throws yields level 0 and logs a warning', async () => {
    const { reporter, levels } = recordingReporter();
    const logger = mockLogger();
    const { signal, setThrow } = controllableSignal('flaky');
    setThrow(new Error('probe boom'));
    const m = new HealthMonitor({ signals: [signal], reporter, logger });

    await m.tick();

    expect(m.level).toBe(0); // fail-OPEN, NOT a false unhealthy
    expect(levels).toEqual([]); // no spurious degraded report
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fails open: a reader returning null yields level 0 and logs a warning', async () => {
    const { reporter } = recordingReporter();
    const logger = mockLogger();
    const { signal, set } = controllableSignal('empty');
    set(null);
    const m = new HealthMonitor({ signals: [signal], reporter, logger });

    await m.tick();

    expect(m.level).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('fails open: a signal with neither an explicit level nor thresholds yields level 0 and warns', async () => {
    const { reporter, levels } = recordingReporter();
    const logger = mockLogger();
    const signal: HealthSignal = { name: 'misconfigured', read: () => ({ value: 999 }) }; // no level, no thresholds
    const m = new HealthMonitor({ signals: [signal], reporter, logger });

    await m.tick();

    expect(m.level).toBe(0); // a misconfigured signal cannot self-report degraded
    expect(levels).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a failing reader does not mask a genuine degradation from another signal', async () => {
    const { reporter, levels } = recordingReporter();
    const flaky = controllableSignal('flaky');
    flaky.setThrow(new Error('boom'));
    const real = controllableSignal('real');
    real.set({ value: 0, level: 2 });
    const m = new HealthMonitor({ signals: [flaky.signal, real.signal], reporter, logger: mockLogger() });

    await m.tick();

    expect(m.level).toBe(2);
    expect(levels).toEqual([2]);
  });

  it('awaits async readers', async () => {
    const { reporter } = recordingReporter();
    const signal: HealthSignal = {
      name: 'async',
      read: async () => ({ value: 0, level: 1 }),
    };
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger() });

    await m.tick();

    expect(m.level).toBe(1);
  });
});

describe('HealthMonitor — start/stop interval (P6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('start() polls once per interval, stop() halts it, both idempotent', async () => {
    const { reporter, levels } = recordingReporter();
    const readSpy = vi.fn((): SignalSample => ({ value: 0, level: 1 }));
    const signal: HealthSignal = { name: 'ctl', read: readSpy };
    const m = new HealthMonitor({ signals: [signal], reporter, logger: mockLogger(), intervalMs: 1000 });

    m.start();
    m.start(); // idempotent — must NOT double-schedule
    await vi.advanceTimersByTimeAsync(1000);
    expect(readSpy).toHaveBeenCalledTimes(1); // exactly one poll per interval
    expect(m.level).toBe(1);
    expect(levels).toEqual([1]);

    m.stop();
    m.stop(); // idempotent
    await vi.advanceTimersByTimeAsync(5000);
    expect(readSpy).toHaveBeenCalledTimes(1); // no further polls after stop
    expect(m.level).toBe(1); // state frozen after stop
    expect(levels).toEqual([1]);
  });

  it('start(): a scheduled tick that rejects is caught and logged, not left unhandled', async () => {
    const logger = mockLogger();
    const signal: HealthSignal = { name: 'ctl', read: () => ({ value: 0, level: 1 }) };
    const reporter: DegradationReporter = {
      report: vi.fn(async () => {
        throw new Error('chain down');
      }),
    };
    const m = new HealthMonitor({ signals: [signal], reporter, logger, intervalMs: 1000 });

    m.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(m.level).toBe(1); // aggregation completed before the failing report
    expect(logger.error).toHaveBeenCalledTimes(1); // the tick rejection was caught
    m.stop();
  });
});
