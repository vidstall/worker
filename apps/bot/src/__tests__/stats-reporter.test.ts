import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  extractRawSample,
  computeDeltaStats,
  buildReportSample,
  relayHttpOrigin,
  startStatsReporter,
  mergeRawExtract,
  type StatsTransportLike,
} from '../stats-reporter.js';

// Mirrors client's useConnectionStats.test.ts report-mocking convention: a
// Map keyed by index, cast to RTCStatsReport (Map-like: forEach() works
// identically).
const report = (entries: Record<string, unknown>[]) =>
  new Map(entries.map((e, i) => [String(i), e])) as unknown as RTCStatsReport;

describe('extractRawSample', () => {
  it('pulls rtt, packet loss, jitter from candidate-pair + inbound-rtp video', () => {
    const r = report([
      { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.05 },
      { type: 'inbound-rtp', kind: 'video', packetsLost: 5, packetsReceived: 95, jitter: 0.012, timestamp: 1000 },
    ]);
    const raw = extractRawSample(r);
    expect(raw.rtt).toBe(50);
    expect(raw.packetLoss).toBe(5);
    expect(raw.jitter).toBe(12);
  });

  it('sums bytesSent/bytesReceived across audio + video streams', () => {
    const r = report([
      { type: 'outbound-rtp', kind: 'audio', bytesSent: 1000 },
      { type: 'outbound-rtp', kind: 'video', bytesSent: 9000, totalEncodeTime: 1, framesEncoded: 100 },
      { type: 'inbound-rtp', kind: 'audio', bytesReceived: 500 },
      { type: 'inbound-rtp', kind: 'video', bytesReceived: 4500 },
    ]);
    const raw = extractRawSample(r);
    expect(raw.bytesSent).toBe(10_000);
    expect(raw.bytesReceived).toBe(5000);
  });

  it('returns zeroed/null fields when the report is empty (send-only bot, no inbound-rtp)', () => {
    const raw = extractRawSample(report([]));
    expect(raw.rtt).toBe(0);
    expect(raw.packetLoss).toBe(0);
    expect(raw.resolutionWidth).toBeNull();
    expect(raw.framerate).toBeNull();
  });
});

describe('mergeRawExtract', () => {
  it('takes outbound fields from the send extract and inbound fields from the recv extract', () => {
    const send = extractRawSample(
      report([
        { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.02 },
        { type: 'outbound-rtp', kind: 'video', bytesSent: 9000, totalEncodeTime: 1, framesEncoded: 100 },
      ]),
    );
    const recv = extractRawSample(
      report([
        { type: 'inbound-rtp', kind: 'video', bytesReceived: 4500, packetsLost: 5, packetsReceived: 95, jitter: 0.012 },
      ]),
    );
    const merged = mergeRawExtract(send, recv);
    expect(merged.rtt).toBe(20);
    expect(merged.bytesSent).toBe(9000);
    expect(merged.bytesReceived).toBe(4500);
    expect(merged.jitter).toBe(12);
    expect(merged.packetLoss).toBe(5);
  });

  it('a send-only bot (no recv activity) merges to the same jitter=0 it always reported', () => {
    const send = extractRawSample(report([{ type: 'outbound-rtp', kind: 'video', bytesSent: 1000 }]));
    const recv = extractRawSample(report([]));
    const merged = mergeRawExtract(send, recv);
    expect(merged.jitter).toBe(0);
    expect(merged.bytesSent).toBe(1000);
  });

  it('prefers the recv side timestamp, falling back to send when recv has none', () => {
    const send = extractRawSample(report([{ type: 'outbound-rtp', kind: 'video', bytesSent: 1, timestamp: 111 }]));
    const recvWithTs = extractRawSample(report([{ type: 'inbound-rtp', kind: 'video', timestamp: 222 }]));
    expect(mergeRawExtract(send, recvWithTs).timestampMs).toBe(222);

    const recvNoTs = extractRawSample(report([]));
    expect(mergeRawExtract(send, recvNoTs).timestampMs).toBe(111);
  });
});

describe('computeDeltaStats', () => {
  it('returns zeroed rates with no prior sample (first poll)', () => {
    const cur = extractRawSample(report([{ type: 'outbound-rtp', kind: 'video', bytesSent: 1000, timestamp: 1000 }]));
    const out = computeDeltaStats(cur, null, 2000);
    expect(out.bitrateUpBps).toBe(0);
    expect(out.encodeLatencyMs).toBeNull();
  });

  it('computes bitrate as bits/sec from a byte delta over the stat-reported interval', () => {
    const prev = extractRawSample(report([{ type: 'outbound-rtp', kind: 'video', bytesSent: 0, timestamp: 0 }]));
    const cur = extractRawSample(
      report([{ type: 'outbound-rtp', kind: 'video', bytesSent: 25_000, timestamp: 1000 }]),
    );
    const out = computeDeltaStats(
      cur,
      {
        timestampMs: prev.timestampMs,
        bytesSent: prev.bytesSent,
        bytesReceived: prev.bytesReceived,
        totalEncodeTime: prev.totalEncodeTime,
        framesEncoded: prev.framesEncoded,
        totalDecodeTime: prev.totalDecodeTime,
        framesDecoded: prev.framesDecoded,
        jitterBufferDelay: prev.jitterBufferDelay,
        jitterBufferEmittedCount: prev.jitterBufferEmittedCount,
      },
      // Matches the real elapsed time here (1000ms) -- computeDeltaStats
      // treats a timestampMs of exactly 0 as falsy/absent (same `&&` check
      // as the client's original), so this fallback is what actually
      // drives the calculation below, not cur.timestampMs - prev.timestampMs.
      1000,
    );
    // 25,000 bytes over 1s = 200,000 bits/sec.
    expect(out.bitrateUpBps).toBe(200_000);
  });
});

describe('buildReportSample', () => {
  it('produces every field relay validates as a finite number, or a boolean for iceSuccess', () => {
    const delta = computeDeltaStats(extractRawSample(report([])), null, 2000);
    const sample = buildReportSample(delta, {
      connectionSetupMs: null,
      iceSuccessRate: null,
      reconnectionTimeMs: null,
    });
    for (const [key, value] of Object.entries(sample)) {
      if (key === 'iceSuccess') {
        expect(typeof value).toBe('boolean');
      } else {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('reports iceSuccess=true once iceSuccessRate is positive', () => {
    const delta = computeDeltaStats(extractRawSample(report([])), null, 2000);
    const sample = buildReportSample(delta, {
      connectionSetupMs: 120,
      iceSuccessRate: 1,
      reconnectionTimeMs: null,
    });
    expect(sample['iceSuccess']).toBe(true);
    expect(sample['connectionSetupMs']).toBe(120);
  });

  it('converts bitrate from bits/sec (delta math) to kbps (relay body)', () => {
    const delta = computeDeltaStats(extractRawSample(report([])), null, 2000);
    const sample = buildReportSample(
      { ...delta, bitrateUpBps: 200_000, bitrateDownBps: 0 },
      { connectionSetupMs: null, iceSuccessRate: null, reconnectionTimeMs: null },
    );
    expect(sample['bitrateUpKbps']).toBe(200);
    expect(sample['bitrateDownKbps']).toBe(0);
  });
});

describe('relayHttpOrigin', () => {
  it('swaps wss:// to https://, keeping a non-default port', () => {
    // :443 is https's default port -- URL.origin normalizes it away, so a
    // non-default port is what actually proves the port is preserved.
    expect(relayHttpOrigin('wss://relay.example.com:8443/ws')).toBe('https://relay.example.com:8443');
  });

  it('swaps ws:// to http://', () => {
    expect(relayHttpOrigin('ws://localhost:4000')).toBe('http://localhost:4000');
  });
});

describe('startStatsReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeTransport(connectionState = 'connected'): StatsTransportLike & { emit: (s: string) => void } {
    let state = connectionState;
    let listener: ((s: string) => void) | null = null;
    return {
      get connectionState() {
        return state;
      },
      getStats: vi.fn().mockResolvedValue(report([])),
      on: (_event, cb) => {
        listener = cb;
      },
      emit: (s: string) => {
        state = s;
        listener?.(s);
      },
    };
  }

  it('POSTs a sample to <relayHttpOrigin>/stats/report immediately on start', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const transport = makeTransport();

    const stop = startStatsReporter({ send: transport }, {
      relayUrl: 'wss://relay.example.com',
      roomId: '0xroom',
      peerId: 'bot-1',
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    stop();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://relay.example.com/stats/report');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string) as { roomId: string; peerId: string; sample: unknown };
    expect(body.roomId).toBe('0xroom');
    expect(body.peerId).toBe('bot-1');
  });

  it('stops polling once stop() is called', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const transport = makeTransport();

    const stop = startStatsReporter({ send: transport }, {
      relayUrl: 'ws://localhost:4000',
      roomId: '0xroom',
      peerId: 'bot-1',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when the transport is already closed', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const transport = makeTransport('closed');

    const stop = startStatsReporter({ send: transport }, {
      relayUrl: 'ws://localhost:4000',
      roomId: '0xroom',
      peerId: 'bot-1',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    stop();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('merges recv-transport jitter into the POSTed sample when a recv transport is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const sendTransport = makeTransport();
    const recvTransport: StatsTransportLike = {
      connectionState: 'connected',
      getStats: vi
        .fn()
        .mockResolvedValue(report([{ type: 'inbound-rtp', kind: 'video', jitter: 0.02, timestamp: 500 }])),
      on: () => undefined,
    };

    const stop = startStatsReporter(
      { send: sendTransport, recv: recvTransport },
      { relayUrl: 'wss://relay.example.com', roomId: '0xroom', peerId: 'bot-1' },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    stop();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { sample: Record<string, number> };
    expect(body.sample['jitterMs']).toBe(20);
  });

  it('falls back to send-only stats when recv getStats() fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const sendTransport = makeTransport();
    const recvTransport: StatsTransportLike = {
      connectionState: 'connected',
      getStats: vi.fn().mockRejectedValue(new Error('recv getStats boom')),
      on: () => undefined,
    };

    const stop = startStatsReporter(
      { send: sendTransport, recv: recvTransport },
      { relayUrl: 'wss://relay.example.com', roomId: '0xroom', peerId: 'bot-1' },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    stop();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { sample: Record<string, number> };
    expect(body.sample['jitterMs']).toBe(0);
  });
});
