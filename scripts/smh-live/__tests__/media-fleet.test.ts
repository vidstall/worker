import { describe, it, expect, vi } from 'vitest';
import { pollUntil, retryOnTimeout } from '../media-fleet.js';

// ── pollUntil — the media WARM-UP poller (bytesForwarded>0 before the chaos kill) ──
//
// The D2 hard gate needs SERVER-side bytesForwarded>0 BEFORE the primary is killed.
// Media establishment through the bench mesh is flaky, so the orchestrator polls the
// relay /metrics endpoint until forwarded bytes appear (bounded). `pollUntil` is that
// bounded async poller, extracted pure so it is unit-testable without a live relay.

describe('pollUntil (bounded async poll until predicate truthy)', () => {
  it('returns the first truthy value immediately when the probe already passes', async () => {
    const probe = vi.fn().mockResolvedValue(42);
    const r = await pollUntil(probe, (v) => v > 0, { deadlineMs: 1000, intervalMs: 10 });
    expect(r).toBe(42);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps polling until the predicate passes, then returns that value', async () => {
    let n = 0;
    const probe = vi.fn().mockImplementation(async () => ++n); // 1, 2, 3, ...
    const r = await pollUntil(probe, (v) => v >= 3, { deadlineMs: 1000, intervalMs: 1 });
    expect(r).toBe(3);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns the LAST probed value (even if still failing) once the deadline passes', async () => {
    const probe = vi.fn().mockResolvedValue(0); // never passes
    const r = await pollUntil(probe, (v) => v > 0, { deadlineMs: 25, intervalMs: 5 });
    expect(r).toBe(0); // last observed value, not a throw
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('swallows a probe rejection (one bad tick never aborts the poll) and keeps going', async () => {
    let n = 0;
    const probe = vi.fn().mockImplementation(async () => {
      n++;
      if (n === 1) throw new Error('transient probe error');
      return n; // 2 on the 2nd call
    });
    const r = await pollUntil(probe, (v) => v >= 2, { deadlineMs: 1000, intervalMs: 1 });
    expect(r).toBe(2);
  });
});

// ── retryOnTimeout — bounded retry of a flaky async op (consume/produce) ──
//
// The bench VirtualPeer's cross-relay consume/produce handshake sometimes throws
// 'Relay response timeout'. retryOnTimeout re-runs the op up to `attempts` times so a
// single flaky handshake does not leave a peer with no media.

describe('retryOnTimeout (bounded retry of a flaky async op)', () => {
  it('returns the result on the first success (no retry)', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    const r = await retryOnTimeout(op, { attempts: 3, delayMs: 1 });
    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a timeout rejection and succeeds on a later attempt', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(async () => {
      n++;
      if (n < 3) throw new Error('Relay response timeout');
      return 'ok';
    });
    const r = await retryOnTimeout(op, { attempts: 5, delayMs: 1 });
    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('rethrows after exhausting all attempts', async () => {
    const op = vi.fn().mockRejectedValue(new Error('Relay response timeout'));
    await expect(retryOnTimeout(op, { attempts: 2, delayMs: 1 })).rejects.toThrow('Relay response timeout');
    expect(op).toHaveBeenCalledTimes(2);
  });
});
