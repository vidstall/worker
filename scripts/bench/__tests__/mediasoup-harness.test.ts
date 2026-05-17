/**
 * RED test for the Node mediasoup-client harness — S23.2.C1.
 *
 * Covers the unit-testable surfaces of `mediasoup-client-harness.ts`:
 *
 *   - `computeG2GoptB` — methodology §3.2 arithmetic
 *   - `extractRelevantStats` — RTCStatsReport walk
 *   - `startConsumerPoller` — interval loop, write-on-tick, cancel
 *   - `parseArgs` — CLI parsing
 *   - `RelayClient` — request/response routing with mocked WS
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
import { EventEmitter } from 'node:events';
import {
  computeG2GoptB,
  extractRelevantStats,
  startConsumerPoller,
  parseArgs,
  peerLabel,
  RelayClient,
  CAPTURE_ENCODE_RENDER_MS,
  type RelayMessage,
  type WsLike,
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
    await vi.advanceTimersByTimeAsync(0);
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith('L_g2g_optB', 120, {
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
});

// ── parseArgs ────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('honours --relay-url --room-id --duration', () => {
    const args = parseArgs([
      'node',
      'harness.ts',
      '--relay-url',
      'ws://relay:4000',
      '--room-id',
      'room-x',
      '--duration',
      '10',
    ]);
    expect(args).toEqual({
      relayUrl: 'ws://relay:4000',
      roomId: 'room-x',
      durationMs: 10_000,
      peers: 2,
    });
  });

  it('defaults relay-url, duration, peers when flags are absent', () => {
    const args = parseArgs(['node', 'harness.ts']);
    expect(args.relayUrl).toBe('ws://localhost:4000');
    expect(args.durationMs).toBe(60_000);
    expect(args.peers).toBe(2);
    expect(args.roomId).toMatch(/^bench-\d+$/);
  });

  it('rounds fractional --duration to ms', () => {
    const args = parseArgs(['node', 'harness.ts', '--duration', '0.5']);
    expect(args.durationMs).toBe(500);
  });

  it('honours --peers N (S25.C.4 — N-peer extension)', () => {
    const args = parseArgs(['node', 'harness.ts', '--peers', '4']);
    expect(args.peers).toBe(4);
  });

  it('rejects --peers below 2', () => {
    expect(() => parseArgs(['node', 'harness.ts', '--peers', '1'])).toThrow(
      /peers/,
    );
  });

  it('rejects --peers above 26', () => {
    expect(() => parseArgs(['node', 'harness.ts', '--peers', '27'])).toThrow(
      /peers/,
    );
  });

  it('rejects non-numeric --peers', () => {
    expect(() => parseArgs(['node', 'harness.ts', '--peers', 'four'])).toThrow(
      /peers/,
    );
  });
});

// ── peerLabel ────────────────────────────────────────────────────────

describe('peerLabel', () => {
  it('maps 0..3 to A..D', () => {
    expect(peerLabel(0)).toBe('A');
    expect(peerLabel(1)).toBe('B');
    expect(peerLabel(2)).toBe('C');
    expect(peerLabel(3)).toBe('D');
  });

  it('maps 25 to Z', () => {
    expect(peerLabel(25)).toBe('Z');
  });

  it('throws on out-of-range indices', () => {
    expect(() => peerLabel(-1)).toThrow(/range/);
    expect(() => peerLabel(26)).toThrow(/range/);
  });
});

// ── RelayClient ──────────────────────────────────────────────────────

class MockWs extends EventEmitter implements WsLike {
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit('close');
  }
}

describe('RelayClient', () => {
  let ws: MockWs;
  let client: RelayClient;

  beforeEach(() => {
    ws = new MockWs();
    client = new RelayClient(ws);
  });

  it('resolves ready when the underlying ws fires open', async () => {
    let resolved = false;
    void client.ready.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    ws.emit('open');
    await client.ready;
    expect(resolved).toBe(true);
  });

  it('serialises send payloads as JSON', () => {
    client.send({ type: 'join', roomId: 'r', peerId: 'p' });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'join',
      roomId: 'r',
      peerId: 'p',
    });
  });

  it('waitFor resolves with the first matching message', async () => {
    const promise = client.waitFor((m) => m.type === 'routerRtpCapabilities');
    // Push an unrelated message first — must NOT resolve the predicate.
    ws.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'error', message: 'noise' })),
    );
    ws.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'routerRtpCapabilities',
          rtpCapabilities: { codecs: [] },
        }),
      ),
    );
    const msg = await promise;
    expect(msg.type).toBe('routerRtpCapabilities');
    expect(msg['rtpCapabilities']).toEqual({ codecs: [] });
  });

  it('routes newProducer push messages to the onProducer callback', () => {
    const onProducer = vi.fn();
    const c = new RelayClient(new MockWs(), onProducer);
    c.routeIncoming({
      type: 'newProducer',
      peerId: 'pA',
      producerId: 'prod1',
      kind: 'audio',
    });
    expect(onProducer).toHaveBeenCalledOnce();
    expect(onProducer).toHaveBeenCalledWith({
      type: 'newProducer',
      peerId: 'pA',
      producerId: 'prod1',
      kind: 'audio',
    });
  });

  it('waitFor rejects on timeout when no matching message arrives', async () => {
    vi.useFakeTimers();
    try {
      const promise = client.waitFor((m) => m.type === 'never', 1000);
      const caught = promise.catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(1500);
      expect(await caught).toContain('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores malformed JSON instead of throwing', () => {
    expect(() => ws.emit('message', Buffer.from('not-json'))).not.toThrow();
  });
});
