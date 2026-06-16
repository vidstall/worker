/**
 * P17 M2b-P4 (REQ-DOH-020/021/024/028) — SelfShutdownWatcher.
 *
 * The watcher subscribes (via a ChainEventListener) to the frozen-contract
 * reactive events FILTERED BY THIS NODE'S OWN miner id — `RelaySlashed` (slash
 * arm, economic_layer) + `NodeDegraded` level 2 (degraded arm, node_health) —
 * plus a periodic `is_paused()` poll (paused arm). The FIRST match invokes
 * `onSelfShutdown(reason)` AT MOST ONCE (one-shot, DOH-028).
 *
 * These tests inject a FAKE ChainEventListener that captures the per-module
 * handler + subscribe opts (mirroring listener.test.ts's FakeEventPoller idiom),
 * then drive synthetic SuiEvents through the captured closures. The is_paused
 * poll is exercised both directly (`checkPauseOnce`, the HealthMonitor.tick
 * idiom) and via the real `setInterval` under vitest fake timers.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import {
  SelfShutdownWatcher,
  type SelfShutdownWatcherOptions,
} from '../self-shutdown-watcher.js';
import type { ListenerHandler } from '../listener.js';

const OWN = '0xself';
const FOREIGN = '0xother';
const PKG = '0xpkg';

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

const slashEvent = (relayMinerId: string): SuiEvent =>
  ({
    type: `${PKG}::economic_layer::RelaySlashed`,
    parsedJson: { room_id: '0xroom', relay_miner_id: relayMinerId, slash_amount: '100' },
    id: { txDigest: 'tx', eventSeq: '0' },
  }) as unknown as SuiEvent;

const degradedEvent = (minerId: string, level: number): SuiEvent =>
  ({
    type: `${PKG}::node_health::NodeDegraded`,
    parsedJson: { miner_id: minerId, node_type: 2, level, operator: '0xop', epoch: '7' },
    id: { txDigest: 'tx', eventSeq: '0' },
  }) as unknown as SuiEvent;

// Adversarial: a NON-RelaySlashed economic_layer event that ALSO carries
// `relay_miner_id` (SessionProof-shaped) — must be ignored by the type filter.
const sessionProofEvent = (relayMinerId: string): SuiEvent =>
  ({
    type: `${PKG}::economic_layer::SessionProofSubmitted`,
    parsedJson: { relay_miner_id: relayMinerId },
    id: { txDigest: 'tx', eventSeq: '0' },
  }) as unknown as SuiEvent;

interface FakeListener {
  handlers: Map<string, ListenerHandler>;
  calls: { module: string; opts: any }[];
  subscribe: ReturnType<typeof vi.fn>;
  isDegraded: () => boolean;
  stop: ReturnType<typeof vi.fn>;
}

function fakeListener(): FakeListener {
  const handlers = new Map<string, ListenerHandler>();
  const calls: { module: string; opts: any }[] = [];
  return {
    handlers,
    calls,
    isDegraded: () => false,
    stop: vi.fn(async () => {}),
    subscribe: vi.fn(async (module: string, handler: ListenerHandler, opts: any) => {
      handlers.set(module, handler);
      calls.push({ module, opts });
    }),
  };
}

const started: SelfShutdownWatcher[] = [];

function makeWatcher(over: Partial<SelfShutdownWatcherOptions> = {}, fl: FakeListener = fakeListener()) {
  const onSelfShutdown = vi.fn();
  const isPaused = vi.fn(async () => false);
  const logger = mockLogger();
  const watcher = new SelfShutdownWatcher({
    listener: fl as any,
    ownMinerId: OWN,
    arms: { slash: true, degraded: true, paused: true },
    onSelfShutdown,
    logger,
    isPaused,
    ...over,
  });
  started.push(watcher);
  return { watcher, fl, onSelfShutdown, isPaused, logger };
}

afterEach(() => {
  for (const w of started) w.stop();
  started.length = 0;
});

describe('SelfShutdownWatcher (P4, DOH-020/021/024/028)', () => {
  it('RED-1: fires onSelfShutdown("slashed") once on a self RelaySlashed (relay, DOH-020/021)', async () => {
    const { watcher, fl, onSelfShutdown } = makeWatcher();
    await watcher.start();
    await fl.handlers.get('economic_layer')!(slashEvent(OWN), { replayed: false });
    expect(onSelfShutdown).toHaveBeenCalledTimes(1);
    expect(onSelfShutdown).toHaveBeenCalledWith('slashed');
  });

  it('RED-2: degraded arm fires ONLY on self NodeDegraded level===2 (level<2 + foreign ignored, DOH-024)', async () => {
    const { watcher, fl, onSelfShutdown } = makeWatcher();
    await watcher.start();
    const h = fl.handlers.get('node_health')!;
    await h(degradedEvent(OWN, 1), { replayed: false }); // level 1 -> ignore
    await h(degradedEvent(FOREIGN, 2), { replayed: false }); // foreign id -> ignore
    expect(onSelfShutdown).not.toHaveBeenCalled();
    await h(degradedEvent(OWN, 2), { replayed: false }); // self level 2 -> fire
    expect(onSelfShutdown).toHaveBeenCalledTimes(1);
    expect(onSelfShutdown).toHaveBeenCalledWith('degraded');
  });

  it('RED-3: a RelaySlashed for a FOREIGN relay_miner_id never triggers shutdown (self-filter, C7)', async () => {
    const { watcher, fl, onSelfShutdown } = makeWatcher();
    await watcher.start();
    await fl.handlers.get('economic_layer')!(slashEvent(FOREIGN), { replayed: false });
    expect(onSelfShutdown).not.toHaveBeenCalled();
  });

  it('RED-4: a non-RelaySlashed economic_layer event with OUR relay_miner_id does NOT trigger (type-filter guard)', async () => {
    const { watcher, fl, onSelfShutdown } = makeWatcher();
    await watcher.start();
    await fl.handlers.get('economic_layer')!(sessionProofEvent(OWN), { replayed: false });
    expect(onSelfShutdown).not.toHaveBeenCalled();
  });

  it('RED-5: paused arm fires once when is_paused()===true, never when false (DOH-020/021)', async () => {
    const { watcher, onSelfShutdown, isPaused } = makeWatcher();
    await watcher.start();
    isPaused.mockResolvedValueOnce(false);
    await watcher.checkPauseOnce();
    expect(onSelfShutdown).not.toHaveBeenCalled();
    isPaused.mockResolvedValueOnce(true);
    await watcher.checkPauseOnce();
    expect(onSelfShutdown).toHaveBeenCalledTimes(1);
    expect(onSelfShutdown).toHaveBeenCalledWith('paused');
  });

  it('RED-6: one-shot guard — at most once across replay+live+pause overlap, first match wins (DOH-028)', async () => {
    const { watcher, fl, onSelfShutdown, isPaused } = makeWatcher();
    await watcher.start();
    const slashH = fl.handlers.get('economic_layer')!;
    const degH = fl.handlers.get('node_health')!;
    await slashH(slashEvent(OWN), { replayed: true }); // replayed self-slash -> fire 'slashed'
    await slashH(slashEvent(OWN), { replayed: false }); // live re-delivery -> ignored
    await degH(degradedEvent(OWN, 2), { replayed: false }); // also matches -> ignored
    isPaused.mockResolvedValue(true);
    await watcher.checkPauseOnce(); // paused -> ignored
    expect(onSelfShutdown).toHaveBeenCalledTimes(1);
    expect(onSelfShutdown).toHaveBeenCalledWith('slashed');
  });

  it('RED-7: disabled arms are not subscribed (validator/signaling no-slash; cp paused-only)', async () => {
    const { watcher: w1, fl: fl1 } = makeWatcher({ arms: { slash: false, degraded: true, paused: true } });
    await w1.start();
    expect(fl1.handlers.has('economic_layer')).toBe(false); // slash arm not subscribed
    expect(fl1.handlers.has('node_health')).toBe(true);

    const { watcher: w2, fl: fl2 } = makeWatcher({ arms: { slash: false, degraded: false, paused: true } });
    await w2.start();
    expect(fl2.calls).toHaveLength(0); // cp subscribes NEITHER event module
    expect(fl2.handlers.size).toBe(0);
  });

  it('RED-8: both event subscribes opt into dropBacklogOnCapExceeded=true (sole DRAIN-FAST opt-in, DOH-028)', async () => {
    const { watcher, fl } = makeWatcher();
    await watcher.start();
    const eco = fl.calls.find((c) => c.module === 'economic_layer')!;
    const nh = fl.calls.find((c) => c.module === 'node_health')!;
    expect(eco.opts.dropBacklogOnCapExceeded).toBe(true);
    expect(nh.opts.dropBacklogOnCapExceeded).toBe(true);
  });

  it('RED-9: start() polls is_paused on the interval; a true reading triggers once then stops polling (DOH-021)', async () => {
    vi.useFakeTimers();
    try {
      const { watcher, onSelfShutdown, isPaused } = makeWatcher({ pausePollIntervalMs: 1000 });
      isPaused.mockResolvedValueOnce(false).mockResolvedValue(true);
      await watcher.start();
      await vi.advanceTimersByTimeAsync(1000); // poll #1 -> false
      expect(onSelfShutdown).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000); // poll #2 -> true -> fire
      expect(onSelfShutdown).toHaveBeenCalledTimes(1);
      expect(onSelfShutdown).toHaveBeenCalledWith('paused');
      await vi.advanceTimersByTimeAsync(5000); // further ticks must NOT re-fire (one-shot + interval cleared)
      expect(onSelfShutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('RED-10: stop() clears the pause poll and is idempotent (no shutdown after stop)', async () => {
    vi.useFakeTimers();
    try {
      const { watcher, onSelfShutdown, isPaused } = makeWatcher({ pausePollIntervalMs: 1000 });
      isPaused.mockResolvedValue(true);
      await watcher.start();
      watcher.stop();
      watcher.stop(); // idempotent
      await vi.advanceTimersByTimeAsync(5000);
      expect(onSelfShutdown).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('RED-12: a thrown is_paused() read is fail-open — no shutdown, WARN logged (C8 safety)', async () => {
    // Pins the fail-open contract: a transient RPC hiccup must NOT self-kill the
    // daemon. A fail-open->fail-closed regression (trigger on error) fails here.
    const { watcher, onSelfShutdown, isPaused, logger } = makeWatcher();
    await watcher.start();
    isPaused.mockRejectedValueOnce(new Error('rpc down'));
    await watcher.checkPauseOnce();
    expect(onSelfShutdown).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('RED-13: a non-NodeDegraded node_health event with OUR miner_id + level 2 does NOT trigger (type-filter guard, symmetric with RED-4)', async () => {
    const { watcher, fl, onSelfShutdown } = makeWatcher();
    await watcher.start();
    const wrongType = {
      type: `${PKG}::node_health::SomeOtherEvent`,
      parsedJson: { miner_id: OWN, level: 2 },
      id: { txDigest: 'tx', eventSeq: '0' },
    } as unknown as SuiEvent;
    await fl.handlers.get('node_health')!(wrongType, { replayed: false });
    expect(onSelfShutdown).not.toHaveBeenCalled();
  });

  it('RED-11: paused arm enabled without an isPaused reader warns and skips (no crash)', async () => {
    const fl = fakeListener();
    const onSelfShutdown = vi.fn();
    const logger = mockLogger();
    const watcher = new SelfShutdownWatcher({
      listener: fl as any,
      ownMinerId: OWN,
      arms: { slash: false, degraded: false, paused: true },
      onSelfShutdown,
      logger,
      // no isPaused
    });
    started.push(watcher);
    await watcher.start();
    await watcher.checkPauseOnce(); // no reader -> no-op
    expect(onSelfShutdown).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
