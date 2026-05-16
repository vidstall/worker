/**
 * RED test for the signaling latency probe — S23.1.A2.
 *
 * Locks the bench-ping/bench-pong WebSocket exchange behaviour before the
 * probe is wired into `index.ts` createServer (Finding 1 of S23 plan:
 * methodology §9 falsely claimed DONE-session-11; reality was importable but
 * not wired). The plan's reference to `heartbeat.ts` as the wire-in target is
 * incorrect — `heartbeat.ts` is the chain heartbeat (Sui TX), not WebSocket
 * pong handler. The probe author's own header comment (line 7-8 of
 * `latency-probe.ts`) names `index.ts` as the wire-in site, which matches the
 * probe's bench-ping/bench-pong API surface tested below.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.1.A2 (CI-7)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

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
      source: 'signaling' as const,
      instance: 'signaling-test',
      getFilePath: () => '/tmp/signaling-test.jsonl',
      write: (metric: string, value_ms: number, context?: Record<string, unknown>) => {
        harness.writeCalls.push({ metric, value_ms, context });
      },
      close: () => {},
    })),
  };
});

import { createSignalingLatencyProbe } from '../latency-probe.js';

class MockWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  sent: string[] = [];

  send = vi.fn((msg: string): void => {
    this.sent.push(msg);
  });
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
  } as unknown as Parameters<typeof createSignalingLatencyProbe>[1];
}

describe('createSignalingLatencyProbe', () => {
  beforeEach(() => {
    harness.resetCalls();
    harness.setBenchEnabled(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when BENCH_LATENCY is unset (off-by-default)', () => {
    harness.setBenchEnabled(false);
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger());
    expect(probe).toBeNull();
  });

  it('returns a probe when BENCH_LATENCY=1', () => {
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger());
    expect(probe).not.toBeNull();
    expect(probe?.attach).toBeInstanceOf(Function);
    expect(probe?.close).toBeInstanceOf(Function);
  });

  it('attach() sends a bench-ping on the configured interval', async () => {
    vi.useFakeTimers();
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger())!;
    const ws = new MockWs();

    const detach = probe.attach(ws as unknown as import('ws').WebSocket, 'peer-1');

    await vi.advanceTimersByTimeAsync(5050);
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);

    const sent = JSON.parse(ws.sent[0]!) as { type: string; send_ts: number };
    expect(sent.type).toBe('bench-ping');
    expect(typeof sent.send_ts).toBe('number');

    detach();
  });

  it('records L_sig_rtt when a bench-pong arrives with matching send_ts', async () => {
    vi.useFakeTimers();
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger())!;
    const ws = new MockWs();

    const detach = probe.attach(ws as unknown as import('ws').WebSocket, 'peer-1');

    await vi.advanceTimersByTimeAsync(5000);
    const ping = JSON.parse(ws.sent[0]!) as { type: string; send_ts: number };

    await vi.advanceTimersByTimeAsync(15);
    ws.emit('message', JSON.stringify({ type: 'bench-pong', send_ts: ping.send_ts }));

    expect(harness.writeCalls).toHaveLength(1);
    expect(harness.writeCalls[0]).toEqual({
      metric: 'L_sig_rtt',
      value_ms: 15,
      context: { peer_id: 'peer-1' },
    });

    detach();
  });

  it('ignores non-bench-pong messages (e.g. join/offer/answer)', async () => {
    vi.useFakeTimers();
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger())!;
    const ws = new MockWs();
    const detach = probe.attach(ws as unknown as import('ws').WebSocket, 'peer-1');

    ws.emit('message', JSON.stringify({ type: 'join', roomId: 'r1' }));
    ws.emit('message', JSON.stringify({ type: 'offer', sdp: {}, targetPeerId: 'p2' }));

    expect(harness.writeCalls).toHaveLength(0);

    detach();
  });

  it('ignores malformed JSON', async () => {
    vi.useFakeTimers();
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger())!;
    const ws = new MockWs();
    const detach = probe.attach(ws as unknown as import('ws').WebSocket, 'peer-1');

    ws.emit('message', 'not json');
    ws.emit('message', '{"type":"bench-pong"}'); // missing send_ts

    expect(harness.writeCalls).toHaveLength(0);

    detach();
  });

  it('detach() halts further bench-ping emissions', async () => {
    vi.useFakeTimers();
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger())!;
    const ws = new MockWs();
    const detach = probe.attach(ws as unknown as import('ws').WebSocket, 'peer-1');

    await vi.advanceTimersByTimeAsync(5000);
    const callsBeforeDetach = ws.sent.length;
    expect(callsBeforeDetach).toBeGreaterThanOrEqual(1);

    detach();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(ws.sent.length).toBe(callsBeforeDetach);
  });

  it('skips ping when ws.readyState !== OPEN (1)', async () => {
    vi.useFakeTimers();
    const probe = createSignalingLatencyProbe('signaling-test', mockLogger())!;
    const ws = new MockWs();
    ws.readyState = 3;

    const detach = probe.attach(ws as unknown as import('ws').WebSocket, 'peer-1');
    await vi.advanceTimersByTimeAsync(5000);

    expect(ws.sent.length).toBe(0);

    detach();
  });
});
