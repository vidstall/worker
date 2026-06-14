/**
 * P17 M2a-P10 — relay health signals (REQ-DOH-014 / DOH-017).
 *
 * The relay's three F61 signals map a synthetic sample to the right level
 * through the `@dvconf/health-monitor` machine: mediasoup worker CPU %
 * (delta over the poll interval, MAX across live workers; 0 live workers => L2),
 * global packet-loss bps, and worker.died count. The CPU reader is the one
 * stateful unit — it computes the delta-% itself from two `getResourceUsage()`
 * snapshots (mediasoup >= 3.14; resolved 3.19.17). Readers consume an injected
 * `deps` bag (the real attach points — `MediasoupManager.workers` +
 * `worker.getResourceUsage()`, `worker.on('died')` at mediasoup-manager.ts:59,
 * the NET-NEW MetricsTracker packet-loss aggregate — are wired in P11).
 * Thresholds come from `readSignalThresholds` so an env override re-maps the
 * level (DOH-017).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  HealthMonitor,
  type DegradationReporter,
  type SignalSample,
  type ThresholdEnv,
} from '@dvconf/health-monitor';
import {
  buildHealthSignals,
  DEFAULT_THRESHOLDS,
  type RelayHealthDeps,
  type RelayWorkerSnapshot,
} from '../health-signals.js';

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

function mockReporter(): DegradationReporter {
  return { report: vi.fn(async () => true) };
}

function deps(over: Partial<RelayHealthDeps> = {}): RelayHealthDeps {
  return {
    getWorkerResourceUsages: () => [],
    getPacketLossBps: () => 0,
    getWorkerDiedCount: () => 0,
    ...over,
  };
}

async function levelFor(d: RelayHealthDeps, env: ThresholdEnv = {}): Promise<number> {
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(d, env),
    reporter: mockReporter(),
    logger: mockLogger(),
  });
  await monitor.tick();
  return monitor.level;
}

function cpuSignal(d: RelayHealthDeps, env: ThresholdEnv = {}) {
  const sig = buildHealthSignals(d, env).find((s) => s.name === 'worker_cpu');
  if (!sig) throw new Error('worker_cpu signal missing');
  return sig;
}

describe('relay health-signals (P10)', () => {
  it('exposes exactly worker_cpu + packet_loss + worker_died signals', () => {
    expect(buildHealthSignals(deps(), {}).map((s) => s.name)).toEqual([
      'worker_cpu',
      'packet_loss',
      'worker_died',
    ]);
  });

  it('DEFAULT_THRESHOLDS = placeholder CPU 70/90% + loss 500/1000bps + died 1/2 (OQ-DOH-3)', () => {
    expect(DEFAULT_THRESHOLDS.WORKER_CPU).toEqual({ degradedAt: 70, unhealthyAt: 90 });
    expect(DEFAULT_THRESHOLDS.PACKET_LOSS).toEqual({ degradedAt: 500, unhealthyAt: 1000 });
    expect(DEFAULT_THRESHOLDS.WORKER_DIED).toEqual({ degradedAt: 1, unhealthyAt: 2 });
  });

  it('packet loss maps to the right level (bps thresholds)', async () => {
    // one live worker primed flat so CPU contributes 0; isolate packet-loss.
    const workers: RelayWorkerSnapshot[] = [{ pid: 1, ru_utime: 0, ru_stime: 0 }];
    expect(await levelFor(deps({ getWorkerResourceUsages: () => workers, getPacketLossBps: () => 700 }))).toBe(1);
    expect(await levelFor(deps({ getWorkerResourceUsages: () => workers, getPacketLossBps: () => 1500 }))).toBe(2);
  });

  it('worker.died count maps to the right level (1 => L1, 2 => L2)', async () => {
    const workers: RelayWorkerSnapshot[] = [{ pid: 1, ru_utime: 0, ru_stime: 0 }];
    expect(await levelFor(deps({ getWorkerResourceUsages: () => workers, getWorkerDiedCount: () => 1 }))).toBe(1);
    expect(await levelFor(deps({ getWorkerResourceUsages: () => workers, getWorkerDiedCount: () => 2 }))).toBe(2);
  });

  it('0 live workers => unhealthy (L2) — the deliberate fail-open exception', async () => {
    expect(await levelFor(deps({ getWorkerResourceUsages: () => [] }))).toBe(2);
  });

  it('CPU reader: first sample primes to value 0 (no prior delta)', async () => {
    let t = 1000;
    const sig = cpuSignal(deps({ getWorkerResourceUsages: () => [{ pid: 1, ru_utime: 0, ru_stime: 0 }], now: () => t }));
    const first = (await sig.read()) as SignalSample;
    expect(first).toEqual({ value: 0 });
  });

  it('CPU reader: computes correct delta-% across two snapshots (MAX across workers)', async () => {
    let snap: RelayWorkerSnapshot[] = [{ pid: 1, ru_utime: 0, ru_stime: 0 }];
    let t = 1000;
    const sig = cpuSignal(deps({ getWorkerResourceUsages: () => snap, now: () => t }));

    await sig.read(); // prime at t=1000

    // 800000 us of CPU consumed over 1000 ms of wall time => 80%.
    snap = [{ pid: 1, ru_utime: 700_000, ru_stime: 100_000 }];
    t = 2000;
    const measured = (await sig.read()) as SignalSample;
    expect(measured.value).toBeCloseTo(80, 5);
  });

  it('CPU reader: MAX across workers (pid-keyed delta)', async () => {
    // pid 1 will consume 80%, pid 2 only 30% over the same window => MAX 80.
    let snap: RelayWorkerSnapshot[] = [
      { pid: 1, ru_utime: 0, ru_stime: 0 },
      { pid: 2, ru_utime: 0, ru_stime: 0 },
    ];
    let t = 1000;
    const sig = cpuSignal(deps({ getWorkerResourceUsages: () => snap, now: () => t }));
    await sig.read();
    snap = [
      { pid: 1, ru_utime: 800_000, ru_stime: 0 },
      { pid: 2, ru_utime: 300_000, ru_stime: 0 },
    ];
    t = 2000;
    const measured = (await sig.read()) as SignalSample;
    expect(measured.value).toBeCloseTo(80, 5);
  });

  it('CPU reader maps a high delta through thresholds end-to-end (95% => L2)', async () => {
    let snap: RelayWorkerSnapshot[] = [{ pid: 1, ru_utime: 0, ru_stime: 0 }];
    let t = 1000;
    const d = deps({ getWorkerResourceUsages: () => snap, now: () => t });
    const monitor = new HealthMonitor({ signals: buildHealthSignals(d, {}), reporter: mockReporter(), logger: mockLogger() });
    await monitor.tick(); // prime
    snap = [{ pid: 1, ru_utime: 950_000, ru_stime: 0 }];
    t = 2000;
    await monitor.tick();
    expect(monitor.level).toBe(2);
  });

  it('env override lowers the CPU degraded bound (DOH-017)', async () => {
    let snap: RelayWorkerSnapshot[] = [{ pid: 1, ru_utime: 0, ru_stime: 0 }];
    let t = 1000;
    const make = (env: ThresholdEnv) => {
      const d = deps({ getWorkerResourceUsages: () => snap, now: () => t });
      return new HealthMonitor({ signals: buildHealthSignals(d, env), reporter: mockReporter(), logger: mockLogger() });
    };
    // 50% delta: default degraded=70 => healthy; override degraded=40 => degraded.
    const def = make({});
    await def.tick();
    snap = [{ pid: 1, ru_utime: 500_000, ru_stime: 0 }];
    t = 2000;
    await def.tick();
    expect(def.level).toBe(0);

    snap = [{ pid: 1, ru_utime: 0, ru_stime: 0 }];
    t = 1000;
    const over = make({ RELAY_DEGRADED_WORKER_CPU: '40' });
    await over.tick();
    snap = [{ pid: 1, ru_utime: 500_000, ru_stime: 0 }];
    t = 2000;
    await over.tick();
    expect(over.level).toBe(1);
  });
});
