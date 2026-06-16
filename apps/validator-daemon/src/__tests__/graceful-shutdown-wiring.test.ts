/**
 * P17 M2b-P9 (DOH-021/022/023/024) — validator main() rewire wiring.
 *
 * The validator unifies the old `stopDaemon` + `main().shutdown` into ONE
 * runGracefulShutdown plan, encoding the cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor (chain-submitting reactive loop) stops in
 *         `stopReactive`, NOT first.
 *   C-B — heartbeat-stop + /healthz tear down LAST.
 *   drain — awaits the in-flight measurement cycle (no cancel), bounded by 30s.
 * + validator is report-only on slash → arms { degraded, paused } (NO slash —
 *   it never subscribes economic_layer), self-filtered by the cap's miner_id FIELD.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildValidatorShutdownPlan, startValidatorSelfShutdownWatcher } from '../index.js';

function makeDeps() {
  const calls: string[] = [];
  const rec = (name: string) => vi.fn(() => void calls.push(name));
  const recAsync = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    setRunning: vi.fn((r: boolean) => void calls.push(`setRunning:${r}`)),
    drainMeasurement: recAsync('drainMeasurement'),
    stopHealthMonitor: rec('stopHealthMonitor'),
    stopWatcher: rec('stopWatcher'),
    stopChainListener: recAsync('stopChainListener'),
    stopMeasurementTimer: rec('stopMeasurementTimer'),
    stopPollers: rec('stopPollers'),
    stopProbe: rec('stopProbe'),
    stopHeartbeat: rec('stopHeartbeat'),
    closeHealthz: recAsync('closeHealthz'),
    exit: vi.fn() as never,
    config: { drainTimeoutMs: 30_000, forceKillTimeoutMs: 60_000 },
  };
  return { calls, deps };
}

describe('buildValidatorShutdownPlan', () => {
  it('setAccepting flips running=false (no new measurement cycles start)', () => {
    const { calls, deps } = makeDeps();
    const plan = buildValidatorShutdownPlan('SIGTERM', deps);
    plan.setAccepting(false);
    expect(calls).toEqual(['setRunning:false']);
  });

  it('drain awaits the in-flight measurement cycle ONLY (heartbeat/healthz stay up)', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildValidatorShutdownPlan('SIGTERM', deps);
    await plan.drain();
    expect(calls).toEqual(['drainMeasurement']);
  });

  it('C-A: stopReactive stops the HealthMonitor + watcher + listeners + pollers, NOT heartbeat/healthz', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildValidatorShutdownPlan('SIGTERM', deps);
    await plan.stopReactive();
    expect(calls).toEqual(
      expect.arrayContaining([
        'stopHealthMonitor',
        'stopWatcher',
        'stopChainListener',
        'stopMeasurementTimer',
        'stopPollers',
        'stopProbe',
      ]),
    );
    expect(calls).not.toContain('stopHeartbeat'); // C-B → LAST, not here
    expect(calls).not.toContain('closeHealthz'); // /healthz LAST, not here
  });

  it('C-B: stopHeartbeatAndHealthz tears down heartbeat + /healthz LAST', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildValidatorShutdownPlan('SIGTERM', deps);
    await plan.stopHeartbeatAndHealthz();
    expect(calls).toEqual(expect.arrayContaining(['stopHeartbeat', 'closeHealthz']));
  });

  it('wires the configured 30s drain + 60s force-kill bounds + reason', () => {
    const { deps } = makeDeps();
    const plan = buildValidatorShutdownPlan('SIGTERM', deps);
    expect(plan.drainTimeoutMs).toBe(30_000);
    expect(plan.forceKillTimeoutMs).toBe(60_000);
    expect(plan.reason).toBe('SIGTERM');
  });
});

describe('startValidatorSelfShutdownWatcher', () => {
  function makeListener() {
    const subscribe = vi.fn().mockResolvedValue(undefined);
    return { listener: { subscribe, stop: vi.fn() } as never, subscribe };
  }

  it('arms { degraded, paused } only — report-only on slash (NEVER subscribes economic_layer)', async () => {
    const { listener, subscribe } = makeListener();
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', fields: { miner_id: '0xminerprofile' } } },
      }),
    } as never;
    const { watcher, stop } = await startValidatorSelfShutdownWatcher({
      client,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      validatorCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(subscribe).toHaveBeenCalledWith(
      'node_health',
      expect.any(Function),
      expect.objectContaining({ dropBacklogOnCapExceeded: true }),
    );
    expect(subscribe).not.toHaveBeenCalledWith('economic_layer', expect.anything(), expect.anything());
    expect(watcher).toBeDefined();
    stop();
  });

  it('self-filters by the cap miner_id FIELD (reads the validator cap object, not its object id)', async () => {
    const { listener } = makeListener();
    const getObject = vi.fn().mockResolvedValue({
      data: { content: { dataType: 'moveObject', fields: { miner_id: '0xminerprofile' } } },
    });
    const client = { getObject } as never;
    const { stop } = await startValidatorSelfShutdownWatcher({
      client,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      validatorCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(getObject).toHaveBeenCalledWith(expect.objectContaining({ id: '0xcap' }));
    stop();
  });
});
