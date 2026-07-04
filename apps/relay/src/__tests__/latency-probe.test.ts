/**
 * RED test for the relay latency probe — S23.1.A1.
 *
 * Locks the behavioural contract of `createRelayLatencyProbe` before the probe
 * is wired into `room-handler.ts` / `signaling.ts` (Finding 1 of S23 plan:
 * methodology §9 falsely claimed DONE-session-11; reality was importable but
 * not wired). Module-singleton + `vi.hoisted` + `vi.mock` pattern keeps the
 * test fully in-process — no filesystem writes, no real `LatencyWriter`.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.1.A1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const writeCalls: Array<{
    metric: string;
    value_ms: number;
    context: Record<string, unknown> | undefined;
  }> = [];
  let benchEnabled = true;
  return {
    writeCalls,
    getBenchEnabled: () => benchEnabled,
    setBenchEnabled: (v: boolean) => {
      benchEnabled = v;
    },
    resetCalls: () => {
      writeCalls.length = 0;
    },
  };
});

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return {
    ...actual,
    isBenchEnabled: () => harness.getBenchEnabled(),
    LatencyWriter: vi.fn().mockImplementation(() => ({
      traceId: 'test-trace',
      scenario: 'adhoc' as const,
      source: 'relay' as const,
      instance: 'relay-test',
      getFilePath: () => '/tmp/relay-test.jsonl',
      write: (metric: string, value_ms: number, context?: Record<string, unknown>) => {
        harness.writeCalls.push({ metric, value_ms, context });
      },
      close: () => {},
    })),
  };
});

import type { types as msTypes } from 'mediasoup';
import { createRelayLatencyProbe, tHopNetworkFromRtt } from '../latency-probe.js';

function mockTransport(rtt: number | undefined) {
  return {
    getStats: vi.fn().mockResolvedValue([{ rtt }]),
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof createRelayLatencyProbe>>['sample']
  >[0];
}

function mockFailingTransport() {
  return {
    getStats: vi.fn().mockRejectedValue(new Error('mediasoup getStats failed')),
  } as unknown as Parameters<
    NonNullable<ReturnType<typeof createRelayLatencyProbe>>['sample']
  >[0];
}

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => mockLogger()),
  } as unknown as Parameters<typeof createRelayLatencyProbe>[1];
}

/** Fake producer whose getStats resolves a single inbound-rtp stat with roundTripTime. */
function mockProducer(roundTripTime: number | undefined) {
  return {
    getStats: vi.fn().mockResolvedValue([{ type: 'inbound-rtp', roundTripTime }]),
    once: vi.fn(),
    on: vi.fn(),
  } as unknown as msTypes.Producer;
}

/** Fake producer whose getStats rejects. */
function mockFailingProducer() {
  return {
    getStats: vi.fn().mockRejectedValue(new Error('producer getStats failed')),
    once: vi.fn(),
    on: vi.fn(),
  } as unknown as msTypes.Producer;
}

describe('createRelayLatencyProbe', () => {
  beforeEach(() => {
    harness.resetCalls();
    harness.setBenchEnabled(true);
  });

  it('returns null when BENCH_LATENCY is unset (off-by-default)', () => {
    harness.setBenchEnabled(false);
    const probe = createRelayLatencyProbe('relay-test', mockLogger());
    expect(probe).toBeNull();
  });

  it('returns a non-null probe when BENCH_LATENCY=1', () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger());
    expect(probe).not.toBeNull();
    expect(probe?.sample).toBeInstanceOf(Function);
    expect(probe?.startSampler).toBeInstanceOf(Function);
    expect(probe?.close).toBeInstanceOf(Function);
  });

  it('sample() writes L_relay_fwd with rtt + room/peer/transport context', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const transport = mockTransport(12.5);

    await probe.sample(transport, { roomId: 'r1', peerId: 'p1', transportId: 't1' });

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]).toEqual({
      metric: 'L_relay_fwd',
      value_ms: 12.5,
      context: { roomId: 'r1', peerId: 'p1', transportId: 't1' },
    });
  });

  it('sample() skips emission when RTT is undefined (no RTCP report yet)', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const transport = mockTransport(undefined);

    await probe.sample(transport, { roomId: 'r1', peerId: 'p1', transportId: 't1' });

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('sample() skips emission when getStats() rejects', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const transport = mockFailingTransport();

    await probe.sample(transport, { roomId: 'r1', peerId: 'p1', transportId: 't1' });

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('sample() skips emission when RTT is zero (treated as missing)', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const transport = mockTransport(0);

    await probe.sample(transport, { roomId: 'r1', peerId: 'p1', transportId: 't1' });

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('startSampler() returns a stop fn that halts further emissions', async () => {
    vi.useFakeTimers();
    try {
      const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
      const transport = mockTransport(20);

      const stop = probe.startSampler(transport, {
        roomId: 'r1',
        peerId: 'p1',
        transportId: 't1',
      });

      await vi.advanceTimersByTimeAsync(1050);
      const callsAfterOneTick = harness.writeCalls.length;
      expect(callsAfterOneTick).toBeGreaterThanOrEqual(1);

      stop();

      await vi.advanceTimersByTimeAsync(3000);
      expect(harness.writeCalls.length).toBe(callsAfterOneTick);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('tHopNetworkFromRtt', () => {
  it('halves the round-trip rtt into a one-way network hop', () => {
    expect(tHopNetworkFromRtt(30)).toBe(15);
  });
  it('returns null for a non-positive rtt (no RTCP report yet)', () => {
    expect(tHopNetworkFromRtt(0)).toBeNull();
    expect(tHopNetworkFromRtt(-1)).toBeNull();
  });
});

// ── Lane-B RTP-stream sampler (t_hop_network via piped-producer inbound-rtp roundTripTime) ──

describe('probe.sampleRtpStream — t_hop_network via piped-producer inbound-rtp roundTripTime (Lane B)', () => {
  beforeEach(() => {
    harness.resetCalls();
    harness.setBenchEnabled(true);
  });

  it('emits t_hop_network = rtt/2 (15) when roundTripTime = 30', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const producer = mockProducer(30);

    await probe.sampleRtpStream(producer, { fromRelay: 'relay-primary', toRelay: 'relay-standby' });

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]).toEqual({
      metric: 't_hop_network',
      value_ms: 15,
      context: { fromRelay: 'relay-primary', toRelay: 'relay-standby', leg: 'inter-relay' },
    });
  });

  it('emits nothing when roundTripTime is 0 (treated as missing)', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const producer = mockProducer(0);

    await probe.sampleRtpStream(producer, { fromRelay: 'relay-primary', toRelay: 'relay-standby' });

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('emits nothing when producer getStats rejects', async () => {
    const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
    const producer = mockFailingProducer();

    await probe.sampleRtpStream(producer, { fromRelay: 'relay-primary', toRelay: 'relay-standby' });

    expect(harness.writeCalls).toHaveLength(0);
  });

  it('startRtpStreamSampler returns a stop fn that halts further t_hop_network emissions', async () => {
    vi.useFakeTimers();
    try {
      const probe = createRelayLatencyProbe('relay-test', mockLogger())!;
      const producer = mockProducer(20);

      const stop = probe.startRtpStreamSampler(producer, {
        fromRelay: 'relay-primary',
        toRelay: 'relay-standby',
      });

      await vi.advanceTimersByTimeAsync(1050);
      const callsAfterOneTick = harness.writeCalls.length;
      expect(callsAfterOneTick).toBeGreaterThanOrEqual(1);
      // Every emission must be t_hop_network = 10 (rtt 20 / 2).
      for (const c of harness.writeCalls) {
        expect(c.metric).toBe('t_hop_network');
        expect(c.value_ms).toBe(10);
      }

      stop();

      await vi.advanceTimersByTimeAsync(3000);
      expect(harness.writeCalls.length).toBe(callsAfterOneTick);
    } finally {
      vi.useRealTimers();
    }
  });
});
