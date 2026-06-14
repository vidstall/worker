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
