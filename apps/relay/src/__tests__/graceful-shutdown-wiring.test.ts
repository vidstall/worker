/**
 * P17 M2b-P8 (DOH-020/021/024) — relay main() rewire wiring.
 *
 * Asserts the two cross-cutting composition rules baked into the relay's
 * graceful-shutdown plan + the SelfShutdownWatcher arms/self-filter:
 *   C-A — the M2a HealthMonitor (chain-submitting reactive loop) stops in
 *         `stopReactive`, NOT first.
 *   C-B — heartbeat-stop + /healthz + /api/probe tear down LAST (so the chain
 *         sees the relay live through the whole drain — F1=Option A heartbeat-safe).
 * + the relay is the only slashable daemon → arms { slash, degraded, paused },
 *   self-filtered by the cap's miner_id FIELD (not the cap object id).
 */
import { describe, it, expect, vi } from 'vitest';
import { buildRelayShutdownPlan, startRelaySelfShutdownWatcher } from '../graceful-shutdown.js';

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
    closeRooms: rec('closeRooms'),
    stopHealthMonitor: rec('stopHealthMonitor'),
    stopWatcher: rec('stopWatcher'),
    stopChainListener: recAsync('stopChainListener'),
    stopStandbyLink: rec('stopStandbyLink'),
    stopRelayEndpoints: recAsync('stopRelayEndpoints'),
    stopRoomPoller: rec('stopRoomPoller'),
    stopHeartbeat: rec('stopHeartbeat'),
    stopWsHeartbeat: rec('stopWsHeartbeat'),
    closeRelayProbe: rec('closeRelayProbe'),
    closeMetricsServer: rec('closeMetricsServer'),
    closeMediasoup: rec('closeMediasoup'),
    closeWss: recAsync('closeWss'),
    exit: vi.fn() as never,
    config: { drainTimeoutMs: 30_000, forceKillTimeoutMs: 60_000 },
  };
  return { calls, deps };
}

describe('buildRelayShutdownPlan', () => {
  it('drain closes client rooms ONLY (heartbeat + /healthz stay up through drain)', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildRelayShutdownPlan('SIGTERM', deps);
    await plan.drain();
    expect(calls).toEqual(['closeRooms']);
  });

  it('C-A: stopReactive stops the HealthMonitor + watcher + chain listeners, NOT heartbeat/healthz', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildRelayShutdownPlan('SIGTERM', deps);
    await plan.stopReactive();
    expect(calls).toEqual(
      expect.arrayContaining([
        'stopHealthMonitor',
        'stopWatcher',
        'stopChainListener',
        'stopStandbyLink',
        'stopRelayEndpoints',
        'stopRoomPoller',
      ]),
    );
    expect(calls).not.toContain('stopHeartbeat'); // C-B → LAST, not here
    expect(calls).not.toContain('closeMetricsServer'); // /healthz LAST, not here
  });

  it('C-B: stopHeartbeatAndHealthz tears down heartbeat + /healthz + /api/probe + mediasoup LAST', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildRelayShutdownPlan('SIGTERM', deps);
    await plan.stopHeartbeatAndHealthz();
    expect(calls).toEqual(
      expect.arrayContaining([
        'stopHeartbeat',
        'stopWsHeartbeat',
        'closeRelayProbe',
        'closeMetricsServer',
        'closeMediasoup',
        'closeWss',
      ]),
    );
  });

  it('wires the configured 30s drain + 60s force-kill bounds + reason', () => {
    const { deps } = makeDeps();
    const plan = buildRelayShutdownPlan('SIGTERM', deps);
    expect(plan.drainTimeoutMs).toBe(30_000);
    expect(plan.forceKillTimeoutMs).toBe(60_000);
    expect(plan.reason).toBe('SIGTERM');
  });
});

describe('startRelaySelfShutdownWatcher', () => {
  function makeListener() {
    const subscribe = vi.fn().mockResolvedValue(undefined);
    return { listener: { subscribe, stop: vi.fn() } as never, subscribe };
  }

  it('arms all three triggers (relay is the only slashable daemon) + opts into DRAIN-FAST', async () => {
    const { listener, subscribe } = makeListener();
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { dataType: 'moveObject', fields: { miner_id: '0xminerprofile' } } },
      }),
    } as never;
    const { watcher, stop } = await startRelaySelfShutdownWatcher({
      client,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      minerCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(subscribe).toHaveBeenCalledWith(
      'economic_layer',
      expect.any(Function),
      expect.objectContaining({ dropBacklogOnCapExceeded: true }),
    );
    expect(subscribe).toHaveBeenCalledWith(
      'node_health',
      expect.any(Function),
      expect.objectContaining({ dropBacklogOnCapExceeded: true }),
    );
    expect(watcher).toBeDefined();
    stop(); // clear the pause-poll interval
  });

  it('self-filters by the cap miner_id FIELD (reads the cap object, not the cap object id)', async () => {
    const { listener } = makeListener();
    const getObject = vi.fn().mockResolvedValue({
      data: { content: { dataType: 'moveObject', fields: { miner_id: '0xminerprofile' } } },
    });
    const client = { getObject } as never;
    const { stop } = await startRelaySelfShutdownWatcher({
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

  it('warns (not crashes) when the cap miner_id cannot be resolved', async () => {
    const { listener } = makeListener();
    const client = { getObject: vi.fn().mockResolvedValue({ data: null }) } as never;
    const warn = vi.fn();
    const { stop } = await startRelaySelfShutdownWatcher({
      client,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      minerCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn, error: vi.fn() } as never,
    });
    expect(warn).toHaveBeenCalled();
    stop();
  });
});
