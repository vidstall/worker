import { describe, it, expect, vi } from 'vitest';
import { startAttestedLoadPoller } from '../attested-load-poller.js';
import type { AttestedLoad } from '../coverage-load-reader.js';

const mockLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never;
const row = (paths: number): AttestedLoad => ({ attestedLoadPaths: paths, heartbeatFreshEpochs: 0 });

describe('startAttestedLoadPoller (REQ-RMS-022 D1)', () => {
  it('refreshes the long-lived map IN PLACE on each tick (same Map identity)', async () => {
    vi.useFakeTimers();
    const results = [new Map([['r1', row(5)]]), new Map([['r1', row(9)], ['r2', row(1)]])];
    const fetcher = vi.fn(async () => results.shift() ?? new Map());
    const poller = startAttestedLoadPoller({ feedUrl: 'http://x', pollMs: 1000, logger: mockLogger(), fetcher });
    const ref = poller.attestedLoad;
    await vi.waitFor(() => expect(ref.get('r1')?.attestedLoadPaths).toBe(5)); // immediate first fetch
    await vi.advanceTimersByTimeAsync(1000);
    expect(poller.attestedLoad).toBe(ref);            // SAME object -- capacityCtx holds this reference
    expect(ref.get('r1')?.attestedLoadPaths).toBe(9);
    expect(ref.get('r2')?.attestedLoadPaths).toBe(1);
    poller.stop();
  });

  it('feed-down => the map is REPLACED WITH EMPTY (strict defer, spec §2-D1.3), not last-known-good', async () => {
    vi.useFakeTimers();
    const results = [new Map([['r1', row(5)]]), new Map<string, AttestedLoad>()]; // fetchAttestedLoad fail-opens to empty
    const fetcher = vi.fn(async () => results.shift() ?? new Map());
    const poller = startAttestedLoadPoller({ feedUrl: 'http://x', pollMs: 1000, logger: mockLogger(), fetcher });
    await vi.waitFor(() => expect(poller.attestedLoad.size).toBe(1));
    await vi.advanceTimersByTimeAsync(1000);
    expect(poller.attestedLoad.size).toBe(0);
    poller.stop();
  });

  it('stop() halts polling', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Map<string, AttestedLoad>());
    const poller = startAttestedLoadPoller({ feedUrl: 'http://x', pollMs: 1000, logger: mockLogger(), fetcher });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
