/**
 * P17 M2b-P9 (DOH-021/022/023/024) — signaling main() rewire wiring.
 *
 * Asserts the two cross-cutting composition rules baked into the signaling
 * daemon's graceful-shutdown plan + the SelfShutdownWatcher arms/self-filter:
 *   C-A — the M2a HealthMonitor (chain-submitting reactive loop) stops in
 *         `stopReactive`, NOT first.
 *   C-B — heartbeat-stop + /healthz tear down LAST.
 * + signaling is report-only on slash → arms { degraded, paused } (NO slash —
 *   it never subscribes economic_layer), self-filtered by the cap's miner_id FIELD.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildSignalingShutdownPlan, startSignalingSelfShutdownWatcher } from '../index.js';

function makeDeps() {
  const calls: string[] = [];
  const rec = (name: string) => vi.fn(() => void calls.push(name));
  const recAsync = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    setAccepting: vi.fn((a: boolean) => void calls.push(`setAccepting:${a}`)),
    drainConnections: rec('drainConnections'),
    stopHealthMonitor: rec('stopHealthMonitor'),
    stopWatcher: rec('stopWatcher'),
    stopChainListener: recAsync('stopChainListener'),
    stopAdmission: recAsync('stopAdmission'),
    stopRelayEndpoints: recAsync('stopRelayEndpoints'),
    stopRewardLog: rec('stopRewardLog'),
    stopProbe: rec('stopProbe'),
    stopBench: rec('stopBench'),
    stopHeartbeat: rec('stopHeartbeat'),
    closeHealthz: recAsync('closeHealthz'),
    closeWss: recAsync('closeWss'),
    exit: vi.fn() as never,
    config: { drainTimeoutMs: 30_000, forceKillTimeoutMs: 60_000 },
  };
  return { calls, deps };
}

describe('buildSignalingShutdownPlan', () => {
  it('drain closes peer connections ONLY (heartbeat + /healthz stay up through drain)', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildSignalingShutdownPlan('SIGTERM', deps);
    await plan.drain();
    expect(calls).toEqual(['drainConnections']);
  });

  it('C-A: stopReactive stops the HealthMonitor + watcher + chain listeners, NOT heartbeat/healthz', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildSignalingShutdownPlan('SIGTERM', deps);
    await plan.stopReactive();
    expect(calls).toEqual(
      expect.arrayContaining([
        'stopHealthMonitor',
        'stopWatcher',
        'stopChainListener',
        'stopAdmission',
        'stopRelayEndpoints',
      ]),
    );
    expect(calls).not.toContain('stopHeartbeat'); // C-B → LAST, not here
    expect(calls).not.toContain('closeHealthz'); // /healthz LAST, not here
  });

  it('C-B: stopHeartbeatAndHealthz tears down heartbeat + /healthz + wss LAST', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildSignalingShutdownPlan('SIGTERM', deps);
    await plan.stopHeartbeatAndHealthz();
    expect(calls).toEqual(
      expect.arrayContaining(['stopHeartbeat', 'closeHealthz', 'closeWss']),
    );
  });

  it('wires the configured 30s drain + 60s force-kill bounds + reason', () => {
    const { deps } = makeDeps();
    const plan = buildSignalingShutdownPlan('SIGTERM', deps);
    expect(plan.drainTimeoutMs).toBe(30_000);
    expect(plan.forceKillTimeoutMs).toBe(60_000);
    expect(plan.reason).toBe('SIGTERM');
  });
});

describe('startSignalingSelfShutdownWatcher', () => {
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
    const { watcher, stop } = await startSignalingSelfShutdownWatcher({
      client,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      minerCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(subscribe).toHaveBeenCalledWith(
      'node_health',
      expect.any(Function),
      expect.objectContaining({ dropBacklogOnCapExceeded: true }),
    );
    // signaling is report-only on slash — it MUST NOT subscribe economic_layer.
    expect(subscribe).not.toHaveBeenCalledWith('economic_layer', expect.anything(), expect.anything());
    expect(watcher).toBeDefined();
    stop();
  });

  it('self-filters by the cap miner_id FIELD (reads the cap object, not the cap object id)', async () => {
    const { listener } = makeListener();
    const getObject = vi.fn().mockResolvedValue({
      data: { content: { dataType: 'moveObject', fields: { miner_id: '0xminerprofile' } } },
    });
    const client = { getObject } as never;
    const { stop } = await startSignalingSelfShutdownWatcher({
      client,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      minerCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(getObject).toHaveBeenCalledWith(expect.objectContaining({ id: '0xcap' }));
    stop();
  });
});
