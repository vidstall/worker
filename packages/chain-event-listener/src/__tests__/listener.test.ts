/**
 * P17 M2b-P1 (REQ-DOH-019) — ChainEventListener SKELETON.
 *
 * The listener WRAPS the shipped @dvconf/shared `EventPoller` BY COMPOSITION —
 * one poller per Move module — and owns the per-module cursor path under
 * DATA_DIR (`<dataDir>/.cursors/<module>.json`). P1 scope = subscribe +
 * per-module cursor + stop + an isDegraded() stub. The ReplayGovernor (P2) and
 * the replay tip-snapshot/`meta.replayed` tagging (P3) are OUT OF SCOPE here:
 * `meta.replayed` is ALWAYS false and `isDegraded()` always returns false.
 *
 * Mirrors the @dvconf/health-monitor test idiom (report.test.ts): vi.hoisted +
 * vi.mock('@dvconf/shared', importOriginal) so the real barrel stays intact and
 * ONLY `EventPoller` is replaced with a constructor-capturing fake. No real
 * chain — the fake poller records its options and exposes start/stop spies.
 */

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';

// Mock EventPoller: a constructor-capturing fake whose start() immediately
// delivers any queued events to the handler and whose stop() is a spy. The rest
// of @dvconf/shared (Logger, etc.) stays real via importOriginal.
const { pollerInstances, FakeEventPoller } = vi.hoisted(() => {
  const pollerInstances: any[] = [];
  class FakeEventPoller {
    public readonly options: any;
    public readonly stop = vi.fn();
    public handler: ((event: any) => Promise<void>) | undefined;
    /** Events the test pre-queues; delivered on start(). */
    public queued: any[] = [];
    constructor(options: any) {
      this.options = options;
      pollerInstances.push(this);
    }
    async start(handler: (event: any) => Promise<void>): Promise<void> {
      this.handler = handler;
      for (const e of this.queued) await handler(e);
    }
  }
  return { pollerInstances, FakeEventPoller };
});

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, EventPoller: FakeEventPoller };
});

// Imported AFTER the mock is registered (vi.mock is hoisted above imports anyway).
import { ChainEventListener, type ListenerHandler } from '../listener.js';

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

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as any,
    packageId: '0xpkg',
    logger: mockLogger(),
    ...overrides,
  };
}

const fakeEvent = (id: string): SuiEvent => ({ id: { txDigest: id, eventSeq: '0' } }) as unknown as SuiEvent;

describe('ChainEventListener — subscribe + per-module cursor (P1, DOH-019)', () => {
  beforeEach(() => {
    pollerInstances.length = 0;
  });

  it('constructs an EventPoller for the module with a <dataDir>/.cursors/<module>.json cursor path', async () => {
    const listener = new ChainEventListener(baseOpts({ dataDir: '/tmp/x' }));
    const handler: ListenerHandler = vi.fn(async () => {});

    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });

    expect(pollerInstances).toHaveLength(1);
    const opts = pollerInstances[0].options;
    expect(opts.packageId).toBe('0xpkg');
    expect(opts.module).toBe('node_health');
    expect(opts.pollingIntervalMs).toBe(1000);
    expect(opts.cursorPath).toBe(join('/tmp/x', '.cursors', 'node_health.json'));
  });

  it('falls back to .cursors/<module>.json relative to CWD when dataDir and DATA_DIR are unset', async () => {
    const prev = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    try {
      const listener = new ChainEventListener(baseOpts()); // no dataDir
      await listener.subscribe('node_health', vi.fn(async () => {}), { pollingIntervalMs: 1000 });

      expect(pollerInstances[0].options.cursorPath).toBe(join('.cursors', 'node_health.json'));
    } finally {
      if (prev !== undefined) process.env.DATA_DIR = prev;
    }
  });

  it('honors process.env.DATA_DIR when dataDir is not passed', async () => {
    const prev = process.env.DATA_DIR;
    process.env.DATA_DIR = '/var/data';
    try {
      const listener = new ChainEventListener(baseOpts()); // no dataDir -> env
      await listener.subscribe('role_voting', vi.fn(async () => {}), { pollingIntervalMs: 500 });

      expect(pollerInstances[0].options.cursorPath).toBe(join('/var/data', '.cursors', 'role_voting.json'));
    } finally {
      if (prev === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = prev;
    }
  });

  it('delivers a polled event to the handler with meta.replayed === false (P1 — never replayed)', async () => {
    const listener = new ChainEventListener(baseOpts({ dataDir: '/tmp/x' }));
    const seen: { event: SuiEvent; replayed: boolean }[] = [];
    const handler: ListenerHandler = vi.fn(async (event, meta) => {
      seen.push({ event, replayed: meta.replayed });
    });

    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });

    // subscribe wired the listener's wrapping closure as the poller's handler;
    // drive an event through the captured closure exactly as the poller would.
    const ev = fakeEvent('0xtx');
    await pollerInstances[0].handler(ev);

    expect(seen).toHaveLength(1);
    expect(seen[0].event).toBe(ev);
    expect(seen[0].replayed).toBe(false); // P1: replayed is ALWAYS false
  });

  it('isDegraded() returns false in P1 (the governor/cap lands in P2/P3)', () => {
    const listener = new ChainEventListener(baseOpts());
    expect(listener.isDegraded()).toBe(false);
  });

  it('stop() stops every poller created by prior subscribe calls and is safe to call twice', async () => {
    const listener = new ChainEventListener(baseOpts({ dataDir: '/tmp/x' }));
    await listener.subscribe('node_health', vi.fn(async () => {}), { pollingIntervalMs: 1000 });
    await listener.subscribe('role_voting', vi.fn(async () => {}), { pollingIntervalMs: 1000 });

    expect(pollerInstances).toHaveLength(2);

    await listener.stop();
    expect(pollerInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(pollerInstances[1].stop).toHaveBeenCalledTimes(1);

    await listener.stop(); // idempotent — must not throw, must not double-stop the same poller
    expect(pollerInstances[0].stop).toHaveBeenCalledTimes(1);
    expect(pollerInstances[1].stop).toHaveBeenCalledTimes(1);
  });
});

// ── P3 (DOH-026/027/028) additive helpers ──────────────────────────────────
// The P1 `fakeEvent` carries only `id`; the replay/live watermark also needs
// `timestampMs` (string | null per the Sui SDK). `mockTipClient` stubs the one
// descending-tip queryEvents the listener issues at subscribe() to seed the
// watermark (events[0] = the newest = the tip). Bare `client:{}` stays the
// fail-open case (the P1 invariant at baseOpts line ~66).
const fakeEventAt = (id: string, tsMs: number | null): SuiEvent =>
  ({
    id: { txDigest: id, eventSeq: '0' },
    timestampMs: tsMs === null ? null : String(tsMs),
  }) as unknown as SuiEvent;

function mockTipClient(events: SuiEvent[]) {
  return {
    queryEvents: vi.fn(async () => ({ data: events, hasNextPage: false })),
  } as any;
}

const txId = (e: { id: any }): string => e.id.txDigest;

describe('ChainEventListener — replay wiring (P3, DOH-026/027/028)', () => {
  beforeEach(() => {
    pollerInstances.length = 0;
  });

  it('RED-1: tags replayed while eventTs<tipTs, latches live at first eventTs>=tipTs (DOH-026)', async () => {
    const listener = new ChainEventListener(
      baseOpts({ dataDir: '/tmp/x', client: mockTipClient([fakeEventAt('tip', 100)]) }),
    );
    const seen: boolean[] = [];
    const handler: ListenerHandler = vi.fn(async (_e, meta) => {
      seen.push(meta.replayed);
    });
    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });
    const h = pollerInstances[0].handler!;

    await h(fakeEventAt('e1', 50)); // 50 < 100  -> replayed
    await h(fakeEventAt('e2', 99)); // 99 < 100  -> replayed
    await h(fakeEventAt('e3', 100)); // 100 >= 100 (strict <) -> live boundary
    await h(fakeEventAt('e4', 40)); // lower ts but live is LATCHED

    expect(seen).toEqual([true, true, false, false]);
    expect(listener.isDegraded()).toBe(false);
  });

  it('RED-2: fail-open tip-read (throws / empty / bare {}) -> replayed always false, subscribe resolves (DOH-026, P1 non-reg)', async () => {
    // (a) bare client:{} — the P1 invariant
    const l1 = new ChainEventListener(baseOpts({ dataDir: '/tmp/x' }));
    const s1: boolean[] = [];
    await l1.subscribe('node_health', vi.fn(async (_e, m) => { s1.push(m.replayed); }), { pollingIntervalMs: 1000 });
    await pollerInstances[0].handler!(fakeEventAt('e1', 1));
    expect(s1).toEqual([false]);
    expect(l1.isDegraded()).toBe(false);

    // (b) queryEvents rejects
    const throwing = { queryEvents: vi.fn(async () => { throw new Error('rpc down'); }) } as any;
    const l2 = new ChainEventListener(baseOpts({ dataDir: '/tmp/x', client: throwing }));
    const s2: boolean[] = [];
    await l2.subscribe('node_health', vi.fn(async (_e, m) => { s2.push(m.replayed); }), { pollingIntervalMs: 1000 });
    await pollerInstances[1].handler!(fakeEventAt('e2', 1));
    expect(s2).toEqual([false]);

    // (c) empty tip page
    const l3 = new ChainEventListener(baseOpts({ dataDir: '/tmp/x', client: mockTipClient([]) }));
    const s3: boolean[] = [];
    await l3.subscribe('node_health', vi.fn(async (_e, m) => { s3.push(m.replayed); }), { pollingIntervalMs: 1000 });
    await pollerInstances[2].handler!(fakeEventAt('e3', 1));
    expect(s3).toEqual([false]);
  });

  it('RED-3: null-timestamp backlog forces live (no Number(null)===0 wedge), never trips degraded (DOH-026)', async () => {
    // maxEvents=2: a naive null->0 design keeps these "replayed" forever and would
    // exhaust the cap on the 3rd event -> false HALT. null->live backstop prevents it.
    const listener = new ChainEventListener(
      baseOpts({ dataDir: '/tmp/x', client: mockTipClient([fakeEventAt('tip', 100)]), replayMaxEvents: 2 }),
    );
    const seen: boolean[] = [];
    const handler: ListenerHandler = vi.fn(async (_e, m) => { seen.push(m.replayed); });
    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });
    const h = pollerInstances[0].handler!;

    await h(fakeEventAt('e1', null));
    await h(fakeEventAt('e2', null));
    await h(fakeEventAt('e3', null));

    expect(seen).toEqual([false, false, false]); // forced live, never tagged replayed
    expect(listener.isDegraded()).toBe(false); // cap never reached
  });

  it('RED-4: throttles DURING replay only; live events never acquire()/tick() (DOH-027)', async () => {
    vi.useFakeTimers();
    try {
      const listener = new ChainEventListener(
        baseOpts({
          dataDir: '/tmp/x',
          client: mockTipClient([fakeEventAt('tip', 10_000)]),
          replayRateLimitHz: 1, // 1 token / 1000ms; bucket capacity 1
          replayMaxEvents: 1000,
        }),
      );
      const seen: boolean[] = [];
      const handler: ListenerHandler = vi.fn(async (_e, m) => { seen.push(m.replayed); });
      await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });
      const h = pollerInstances[0].handler!;

      await h(fakeEventAt('e1', 1)); // replay; drains the single initial token instantly
      expect(seen).toEqual([true]);

      // e2 replay: bucket empty -> parks ~1000ms
      let r2 = false;
      const p2 = h(fakeEventAt('e2', 2)).then(() => { r2 = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(r2).toBe(false); // still throttled
      await vi.advanceTimersByTimeAsync(1);
      await p2;
      expect(r2).toBe(true);
      expect(seen).toEqual([true, true]);

      // a LIVE event must resolve WITHOUT any timer advance (no throttle path)
      let r3 = false;
      const p3 = h(fakeEventAt('e3', 10_000)).then(() => { r3 = true; });
      await p3;
      expect(r3).toBe(true);
      expect(seen).toEqual([true, true, false]);
    } finally {
      vi.useRealTimers();
    }
  }, 15000);

  it('RED-5: HALT default — cap-exceeded stops delivery, stops the poller, latches degraded (bounded-loss) (DOH-027)', async () => {
    const listener = new ChainEventListener(
      baseOpts({
        dataDir: '/tmp/x',
        client: mockTipClient([fakeEventAt('tip', 10_000)]),
        replayRateLimitHz: 1000, // high so acquire never parks (no fake timers needed)
        replayMaxEvents: 2,
      }),
    );
    const seen: string[] = [];
    const handler: ListenerHandler = vi.fn(async (e) => { seen.push(txId(e)); });
    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });
    const h = pollerInstances[0].handler!;

    await h(fakeEventAt('e1', 1)); // replay delivered (tick 1)
    await h(fakeEventAt('e2', 2)); // replay delivered (tick 2 == maxEvents)
    await h(fakeEventAt('e3', 3)); // tick 3 -> false -> HALT (NOT delivered)
    expect(seen).toEqual(['e1', 'e2']);
    expect(listener.isDegraded()).toBe(true);
    expect(pollerInstances[0].stop).toHaveBeenCalledTimes(1);

    // bounded-loss: further in-flight replay events are dropped at the wrapper
    await h(fakeEventAt('e4', 4));
    await h(fakeEventAt('e5', 5));
    expect(seen).toEqual(['e1', 'e2']);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('RED-6: DRAIN-FAST opt-in — cap-exceeded goes live, keeps delivering, NOT degraded (DOH-027/028)', async () => {
    const listener = new ChainEventListener(
      baseOpts({
        dataDir: '/tmp/x',
        client: mockTipClient([fakeEventAt('tip', 10_000)]),
        replayRateLimitHz: 1000,
        replayMaxEvents: 2,
      }),
    );
    const seen: { id: string; replayed: boolean }[] = [];
    const handler: ListenerHandler = vi.fn(async (e, m) => { seen.push({ id: txId(e), replayed: m.replayed }); });
    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000, dropBacklogOnCapExceeded: true });
    const h = pollerInstances[0].handler!;

    await h(fakeEventAt('e1', 1)); // replay delivered
    await h(fakeEventAt('e2', 2)); // replay delivered (tick 2)
    await h(fakeEventAt('e3', 3)); // tick 3 false -> DRAIN-FAST: goLive + still deliver (tagged replayed)
    await h(fakeEventAt('e4', 4)); // now live-latched -> delivered live

    expect(seen.map((s) => s.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(seen[0].replayed).toBe(true);
    expect(seen[1].replayed).toBe(true);
    expect(seen[2].replayed).toBe(true); // the cap-tripping event still delivered, tagged replayed
    expect(seen[3].replayed).toBe(false); // subsequent events live
    expect(listener.isDegraded()).toBe(false);
    expect(pollerInstances[0].stop).not.toHaveBeenCalled();
  });

  it('RED-7: isDegraded() is a listener-level OR-latch across modules (DOH-027)', async () => {
    const listener = new ChainEventListener(
      baseOpts({
        dataDir: '/tmp/x',
        client: mockTipClient([fakeEventAt('tip', 10_000)]),
        replayRateLimitHz: 1000,
        replayMaxEvents: 1,
      }),
    );
    await listener.subscribe('node_health', vi.fn(async () => {}), { pollingIntervalMs: 1000 });
    await listener.subscribe('economic_layer', vi.fn(async () => {}), { pollingIntervalMs: 1000 });
    expect(pollerInstances).toHaveLength(2);

    const hHealth = pollerInstances[0].handler!;
    await hHealth(fakeEventAt('a', 1)); // tick 1 (== maxEvents) delivered
    await hHealth(fakeEventAt('b', 2)); // tick 2 -> false -> HALT module 0
    expect(listener.isDegraded()).toBe(true); // listener-level latch tripped by ONE module
    expect(pollerInstances[0].stop).toHaveBeenCalledTimes(1);

    // module 1's poller is independent and untouched
    expect(pollerInstances[1].stop).not.toHaveBeenCalled();
  });

  it('RED-8: no dedup — identical event delivered replayed/live/duplicate; F49 idempotency documented (DOH-028)', async () => {
    const listener = new ChainEventListener(
      baseOpts({ dataDir: '/tmp/x', client: mockTipClient([fakeEventAt('tip', 100)]) }),
    );
    const seen: { id: string; replayed: boolean }[] = [];
    const handler: ListenerHandler = vi.fn(async (e, m) => { seen.push({ id: txId(e), replayed: m.replayed }); });
    await listener.subscribe('node_health', handler, { pollingIntervalMs: 1000 });
    const h = pollerInstances[0].handler!;

    await h(fakeEventAt('dup', 50)); // replayed (50 < 100)
    await h(fakeEventAt('dup', 50)); // SAME event re-delivered -> still delivered (no dedup)
    await h(fakeEventAt('dup', 150)); // live (>= 100), same txDigest -> delivered

    expect(seen).toEqual([
      { id: 'dup', replayed: true },
      { id: 'dup', replayed: true },
      { id: 'dup', replayed: false },
    ]);

    // DOH-028 documentation obligation: the listener docs cite the F49 idempotent-rebuild baseline.
    const src = readFileSync(new URL('../listener.ts', import.meta.url), 'utf-8');
    expect(src).toMatch(/F49/);
    expect(src).toMatch(/idempoten/i);
  });
});
