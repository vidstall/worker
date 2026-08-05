/**
 * P17 M2b-P10 (DOH-021/023/024) — cp-daemon main() rewire wiring.
 *
 * The cp-daemon is poller-only (no WS accept, nothing to drain) → the SMALLEST of
 * the 3 daemon rewires. It funnels the old `main().shutdown` through ONE
 * runGracefulShutdown plan, encoding the cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor (chain-submitting reactive loop) stops in
 *         `stopReactive`, NOT first.
 *   C-B — heartbeat-stop + /healthz tear down LAST.
 *   setAccepting / drain — NO-OPs (cp has no connection accept, nothing in-flight).
 * + cp is NOT slashable (D-F60-4) and CP self-degradation is out of scope → arms
 *   { paused } ONLY → it subscribes NEITHER economic_layer NOR node_health.
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCpShutdownPlan, startCpSelfShutdownWatcher } from '../index.js';

function makeDeps() {
  const calls: string[] = [];
  const rec = (name: string) => vi.fn(() => void calls.push(name));
  const recAsync = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    stopHealthMonitor: rec('stopHealthMonitor'),
    stopWatcher: rec('stopWatcher'),
    stopChainListener: recAsync('stopChainListener'),
    stopRoleVoting: rec('stopRoleVoting'),
    stopRevoteWatcher: rec('stopRevoteWatcher'),
    stopRelayHeartbeatWatcher: rec('stopRelayHeartbeatWatcher'),
    stopWorkerConfirmedDeadListener: rec('stopWorkerConfirmedDeadListener'),
    stopRoomHealthSweep: rec('stopRoomHealthSweep'),
    stopRoomExpirySweep: rec('stopRoomExpirySweep'),
    stopTurnIssuer: rec('stopTurnIssuer'),
    stopCapTokenIssuer: rec('stopCapTokenIssuer'),
    stopTurnRpc: rec('stopTurnRpc'),
    stopPollers: rec('stopPollers'),
    stopHeartbeat: rec('stopHeartbeat'),
    closeHealthz: recAsync('closeHealthz'),
    exit: vi.fn() as never,
    config: { drainTimeoutMs: 30_000, forceKillTimeoutMs: 60_000 },
  };
  return { calls, deps };
}

describe('buildCpShutdownPlan', () => {
  it('setAccepting is a NO-OP (cp has no connection accept)', () => {
    const { calls, deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', deps);
    plan.setAccepting(false);
    expect(calls).toEqual([]); // nothing recorded — pure no-op
  });

  it('drain is a NO-OP (poller-only, nothing in-flight)', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', deps);
    await plan.drain();
    expect(calls).toEqual([]);
  });

  it('C-A: stopReactive stops the HealthMonitor + watcher + listener + all watchers/issuers/pollers, NOT heartbeat/healthz', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', deps);
    await plan.stopReactive();
    expect(calls).toEqual(
      expect.arrayContaining([
        'stopHealthMonitor',
        'stopWatcher',
        'stopChainListener',
        'stopRoleVoting',
        'stopRevoteWatcher',
        'stopRelayHeartbeatWatcher',
        'stopWorkerConfirmedDeadListener',
        'stopTurnIssuer',
        'stopCapTokenIssuer',
        'stopTurnRpc',
        'stopPollers',
      ]),
    );
    expect(calls).not.toContain('stopHeartbeat'); // C-B → LAST, not here
    expect(calls).not.toContain('closeHealthz'); // /healthz LAST, not here
  });

  it('C-A: HealthMonitor stops FIRST in stopReactive (before the rest of the loop)', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', deps);
    await plan.stopReactive();
    expect(calls[0]).toBe('stopHealthMonitor');
  });

  it('C-B: stopHeartbeatAndHealthz tears down heartbeat + /healthz LAST', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', deps);
    await plan.stopHeartbeatAndHealthz();
    expect(calls).toEqual(['stopHeartbeat', 'closeHealthz']);
  });

  it('tolerates a missing stopTurnRpc (TURN RPC disabled — optional)', async () => {
    const { calls, deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', { ...deps, stopTurnRpc: undefined });
    await plan.stopReactive();
    expect(calls).not.toContain('stopTurnRpc');
    expect(calls).toContain('stopHealthMonitor');
  });

  it('wires the configured 30s drain + 60s force-kill bounds + reason', () => {
    const { deps } = makeDeps();
    const plan = buildCpShutdownPlan('SIGTERM', deps);
    expect(plan.drainTimeoutMs).toBe(30_000);
    expect(plan.forceKillTimeoutMs).toBe(60_000);
    expect(plan.reason).toBe('SIGTERM');
  });
});

describe('startCpSelfShutdownWatcher', () => {
  function makeListener() {
    const subscribe = vi.fn().mockResolvedValue(undefined);
    return { listener: { subscribe, stop: vi.fn() } as never, subscribe };
  }

  it('arms { paused } only — NEVER subscribes economic_layer NOR node_health (cp not slashable + degraded off)', async () => {
    const { listener, subscribe } = makeListener();
    const { watcher, stop } = await startCpSelfShutdownWatcher({
      client: {} as never,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      cpCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(subscribe).not.toHaveBeenCalledWith('economic_layer', expect.anything(), expect.anything());
    expect(subscribe).not.toHaveBeenCalledWith('node_health', expect.anything(), expect.anything());
    expect(subscribe).not.toHaveBeenCalled(); // both event arms off → no subscribe at all
    expect(watcher).toBeDefined();
    stop();
  });

  it('does NOT read the cap object (no readCapMinerId RPC — ownMinerId unused when both id-filtered arms are off)', async () => {
    const { listener } = makeListener();
    const getObject = vi.fn();
    const { stop } = await startCpSelfShutdownWatcher({
      client: { getObject } as never,
      config: { packageId: '0xpkg', networkRegistryId: '0xnet' } as never,
      cpCapId: '0xcap',
      listener,
      onSelfShutdown: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    });
    expect(getObject).not.toHaveBeenCalled();
    stop();
  });
});
