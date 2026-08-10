/**
 * RED test for the Node mediasoup-client harness — S23.2.C1.
 *
 * Covers the unit-testable stats/timing surfaces of
 * `mediasoup-client-harness.ts`:
 *
 *   - `computeG2GoptB` — methodology §3.2 arithmetic
 *   - `extractRelevantStats` / `extractRttOnly` / `extractBytesReceived` —
 *     RTCStatsReport walks
 *   - `retryOnTimeout` — retry helper
 *   - `startConsumerPoller` — interval loop, write-on-tick, cancel
 *
 * The `VirtualPeer.run()` integration (live mediasoup-client + relay WS
 * handshake) is validated end-to-end in S23.3 against a running relay.
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.C1
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  computeG2GoptB,
  extractRelevantStats,
  extractRttOnly,
  extractBytesReceived,
  retryOnTimeout,
  startConsumerPoller,
  CAPTURE_ENCODE_RENDER_MS,
} from '../mediasoup-client-harness.js';

// ── computeG2GoptB ───────────────────────────────────────────────────

describe('computeG2GoptB (methodology §3.2)', () => {
  it('computes rtt/2 + jitter + capture-encode-render constant', () => {
    // rtt 100 ms → 0.1 s → contributes 50 ms (rtt/2)
    // jitter 20 ms → 0.02 s → contributes 20 ms
    // const 50 ms
    // = 120 ms
    expect(
      computeG2GoptB({
        currentRoundTripTime: 0.1,
        jitterBufferDelay: 0.02,
      }),
    ).toBe(120);
  });

  it('returns just the constant when rtt + jitter are 0', () => {
    expect(
      computeG2GoptB({ currentRoundTripTime: 0, jitterBufferDelay: 0 }),
    ).toBe(CAPTURE_ENCODE_RENDER_MS);
  });

  it('keeps fractional millisecond precision', () => {
    // rtt 12.5 ms → 0.0125 s → rtt/2 = 6.25 ms
    // jitter 3.5 ms → 0.0035 s → 3.5 ms
    // = 6.25 + 3.5 + 50 = 59.75
    const v = computeG2GoptB({
      currentRoundTripTime: 0.0125,
      jitterBufferDelay: 0.0035,
    });
    expect(v).toBeCloseTo(59.75, 5);
  });
});

// ── extractRelevantStats ─────────────────────────────────────────────

describe('extractRelevantStats', () => {
  function makeReport(
    entries: Array<{ type: string; [k: string]: unknown }>,
  ): { values: () => Iterable<{ type: string; [k: string]: unknown }> } {
    return {
      values: () => entries[Symbol.iterator](),
    };
  }

  it('extracts rtt from candidate-pair + jitter from inbound-rtp', () => {
    const report = makeReport([
      {
        type: 'candidate-pair',
        currentRoundTripTime: 0.05,
        nominated: true,
      },
      {
        type: 'inbound-rtp',
        jitterBufferDelay: 0.01,
        kind: 'audio',
      },
    ]);
    expect(extractRelevantStats(report)).toEqual({
      currentRoundTripTime: 0.05,
      jitterBufferDelay: 0.01,
    });
  });

  it('returns null when rtt is missing', () => {
    const report = makeReport([
      { type: 'inbound-rtp', jitterBufferDelay: 0.01 },
    ]);
    expect(extractRelevantStats(report)).toBeNull();
  });

  it('returns null when jitter is missing', () => {
    const report = makeReport([
      { type: 'candidate-pair', currentRoundTripTime: 0.05 },
    ]);
    expect(extractRelevantStats(report)).toBeNull();
  });

  it('ignores unrelated stat entries', () => {
    const report = makeReport([
      { type: 'transport', bytesSent: 1024 },
      { type: 'candidate-pair', currentRoundTripTime: 0.05 },
      { type: 'inbound-rtp', jitterBufferDelay: 0.01 },
      { type: 'codec', mimeType: 'audio/opus' },
    ]);
    expect(extractRelevantStats(report)).toEqual({
      currentRoundTripTime: 0.05,
      jitterBufferDelay: 0.01,
    });
  });
});

// ── extractRttOnly (S25.C-followup.C) ────────────────────────────────

describe('extractRttOnly', () => {
  it('returns currentRoundTripTime from candidate-pair', () => {
    const report = {
      values: () =>
        [
          { type: 'candidate-pair', currentRoundTripTime: 0.05 },
          { type: 'inbound-rtp', bytesReceived: 1234 },
        ][Symbol.iterator](),
    };
    expect(extractRttOnly(report)).toBe(0.05);
  });

  it('accepts zero RTT (valid on localhost loopback — sub-microsecond probe)', () => {
    const report = {
      values: () =>
        [{ type: 'candidate-pair', currentRoundTripTime: 0 }][Symbol.iterator](),
    };
    expect(extractRttOnly(report)).toBe(0);
  });

  it('returns null when no candidate-pair entry', () => {
    const report = {
      values: () =>
        [{ type: 'inbound-rtp', bytesReceived: 1234 }][Symbol.iterator](),
    };
    expect(extractRttOnly(report)).toBeNull();
  });
});

// ── extractBytesReceived (SMH-LIVE D2 pre-kill media establishment) ────────────────

describe('extractBytesReceived', () => {
  it('sums bytesReceived across all inbound-rtp entries (ignores other stat types)', () => {
    const report = {
      values: () =>
        [
          { type: 'candidate-pair', currentRoundTripTime: 0.05 },
          { type: 'inbound-rtp', bytesReceived: 1200 },
          { type: 'inbound-rtp', bytesReceived: 800 },
          { type: 'outbound-rtp', bytesSent: 5000 },
        ][Symbol.iterator](),
    };
    expect(extractBytesReceived(report)).toBe(2000);
  });

  it('returns 0 when there is no inbound-rtp (no media received yet)', () => {
    const report = {
      values: () => [{ type: 'candidate-pair', currentRoundTripTime: 0 }][Symbol.iterator](),
    };
    expect(extractBytesReceived(report)).toBe(0);
  });
});

// ── retryOnTimeout (SMH-LIVE D2 consume/produce hardening) ────────────

describe('retryOnTimeout', () => {
  it('returns on first success without retrying', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    expect(await retryOnTimeout(op, { attempts: 3, delayMs: 1 })).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('retries a rejected op and returns a later success', async () => {
    let n = 0;
    const op = vi.fn().mockImplementation(async () => {
      if (++n < 2) throw new Error('Relay response timeout');
      return 'ok';
    });
    expect(await retryOnTimeout(op, { attempts: 3, delayMs: 1 })).toBe('ok');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('rethrows the last error after exhausting attempts', async () => {
    const op = vi.fn().mockRejectedValue(new Error('Relay response timeout'));
    await expect(retryOnTimeout(op, { attempts: 2, delayMs: 1 })).rejects.toThrow('Relay response timeout');
    expect(op).toHaveBeenCalledTimes(2);
  });

  it('clamps attempts<1 to a single try', async () => {
    const op = vi.fn().mockResolvedValue('ok');
    expect(await retryOnTimeout(op, { attempts: 0, delayMs: 1 })).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
  });
});

// ── startConsumerPoller ──────────────────────────────────────────────

describe('startConsumerPoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes L_g2g_optB on every successful poll until stopped', async () => {
    const consumer = {
      getStats: vi.fn().mockResolvedValue({
        values: () =>
          [
            { type: 'candidate-pair', currentRoundTripTime: 0.1 },
            { type: 'inbound-rtp', jitterBufferDelay: 0.02 },
          ][Symbol.iterator](),
      }),
    };
    const writer = { write: vi.fn() };
    const stop = startConsumerPoller(
      consumer,
      writer,
      { room_id: 'r1', peer_b: 'pB' },
      1000,
    );

    // Immediate first sample fires synchronously; allow microtasks.
    // S25.C-followup.C: poller now emits L_g2g_RTT_proxy (narrowed Option B)
    // instead of L_g2g_optB — jitter unit on @roamhq/wrtc is non-W3C; see
    // ch5 §5.2.7. Expected: rtt(0.1s)*1000/2 + 50 = 100 ms.
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith('L_g2g_RTT_proxy', 100, {
      room_id: 'r1',
      peer_b: 'pB',
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(writer.write.mock.calls.length).toBeGreaterThanOrEqual(3);

    stop();
    const countAtStop = writer.write.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(writer.write.mock.calls.length).toBe(countAtStop);
  });

  it('skips write when stats are incomplete (no rtt)', async () => {
    const consumer = {
      getStats: vi.fn().mockResolvedValue({
        values: () =>
          [{ type: 'inbound-rtp', jitterBufferDelay: 0.02 }][Symbol.iterator](),
      }),
    };
    const writer = { write: vi.fn() };
    const stop = startConsumerPoller(consumer, writer, {}, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.write).not.toHaveBeenCalled();
    stop();
  });

  it('swallows getStats errors without crashing', async () => {
    const consumer = {
      getStats: vi.fn().mockRejectedValue(new Error('transient')),
    };
    const writer = { write: vi.fn() };
    const stop = startConsumerPoller(consumer, writer, {}, 1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(writer.write).not.toHaveBeenCalled();
    stop();
  });

  it('falls back to transport.getStats when consumer.getStats throws (CI-20)', async () => {
    const consumer = {
      getStats: vi
        .fn()
        .mockRejectedValue(
          new Error('Not yet implemented; file a feature request against node-webrtc'),
        ),
    };
    const transport = {
      getStats: vi.fn().mockResolvedValue({
        values: () =>
          [{ type: 'candidate-pair', currentRoundTripTime: 0.04 }][Symbol.iterator](),
      }),
    };
    const writer = { write: vi.fn() };
    const stop = startConsumerPoller(consumer, writer, { consumer_id: 'c1' }, 1000, {
      transport,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.write).toHaveBeenCalledTimes(1);
    // 0.04 s * 1000 / 2 + 50 = 70 ms
    expect(writer.write).toHaveBeenCalledWith('L_g2g_RTT_proxy', 70, {
      consumer_id: 'c1',
    });
    stop();
  });

  it('prefers transport.getStats result over consumer.getStats when both succeed', async () => {
    const consumer = {
      getStats: vi.fn().mockResolvedValue({
        values: () =>
          [{ type: 'candidate-pair', currentRoundTripTime: 0.9 }][Symbol.iterator](),
      }),
    };
    const transport = {
      getStats: vi.fn().mockResolvedValue({
        values: () =>
          [{ type: 'candidate-pair', currentRoundTripTime: 0.02 }][Symbol.iterator](),
      }),
    };
    const writer = { write: vi.fn() };
    const stop = startConsumerPoller(consumer, writer, {}, 1000, { transport });
    await vi.advanceTimersByTimeAsync(0);
    // Transport's 0.02 used, not consumer's 0.9 → 0.02 * 500 + 50 = 60 ms
    expect(writer.write).toHaveBeenCalledWith('L_g2g_RTT_proxy', 60, {});
    expect(consumer.getStats).not.toHaveBeenCalled();
    stop();
  });
});
