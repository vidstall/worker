import { describe, it, expect } from 'vitest';
import { assembleOneWay, RESIDUAL_MS } from '../join-g2g.js';
import type { LatencyEvent } from '@dvconf/shared';

const ev = (metric: string, value_ms: number, ctx: Record<string, unknown>): LatencyEvent => ({
  schema_version: '1.0', ts: 0, trace_id: 't', scenario: 's-wan', source: 'client',
  instance: ctx['peer_id'] as string, metric: metric as LatencyEvent['metric'], value_ms, context: ctx,
});

describe('assembleOneWay', () => {
  it('joins send+recv halves for one flow and sums BOTH last-mile legs', () => {
    const send = { room_id: 'r1', flow_id: 'p1', direction: 'send', peer_id: 'A' };
    const recv = { room_id: 'r1', flow_id: 'p1', direction: 'recv', peer_id: 'B' };
    const rows = assembleOneWay([
      ev('L_encode', 8, send), ev('L_rtt_send', 30, send),
      ev('L_jitterbuffer', 22, recv), ev('L_decode', 4, recv),
      ev('L_rtt_recv', 28, recv), ev('L_present', 9, recv),
    ]);
    expect(rows).toHaveLength(1);
    // 8 + (30/2 + 28/2) + 22 + 4 + 9 + RESIDUAL = 8 + 29 + 22 + 4 + 9 + RESIDUAL
    expect(rows[0]!.oneWayMs).toBeCloseTo(72 + RESIDUAL_MS, 5);
    expect(rows[0]!.flowId).toBe('p1');
    expect(rows[0]!.network.rttSendHalf).toBeCloseTo(15, 5);
    expect(rows[0]!.network.rttRecvHalf).toBeCloseTo(14, 5);
  });

  it('drops an unpaired flow (send with no matching recv) and reports it', () => {
    const rows = assembleOneWay([ev('L_encode', 8, { room_id: 'r1', flow_id: 'solo', direction: 'send', peer_id: 'A' })]);
    expect(rows).toHaveLength(0);
  });

  it('drops a paired flow that is missing a required component (L_encode absent), never NaN', () => {
    const send = { room_id: 'r1', flow_id: 'p1', direction: 'send', peer_id: 'A' };
    const recv = { room_id: 'r1', flow_id: 'p1', direction: 'recv', peer_id: 'B' };
    const rows = assembleOneWay([
      ev('L_rtt_send', 30, send), // send half present but NO L_encode
      ev('L_jitterbuffer', 22, recv), ev('L_decode', 4, recv), ev('L_rtt_recv', 28, recv),
    ]);
    expect(rows).toHaveLength(0);
  });

  it('uses the per-session MEDIAN of multi-sample components', () => {
    const send = { room_id: 'r1', flow_id: 'p1', direction: 'send', peer_id: 'A' };
    const recv = { room_id: 'r1', flow_id: 'p1', direction: 'recv', peer_id: 'B' };
    const rows = assembleOneWay([
      // L_encode samples 6,8,10 -> median 8 ; L_rtt_send 28,30,32 -> median 30
      ev('L_encode', 6, send), ev('L_encode', 10, send), ev('L_encode', 8, send),
      ev('L_rtt_send', 32, send), ev('L_rtt_send', 28, send), ev('L_rtt_send', 30, send),
      // recv: L_rtt_recv 26,28,30 -> 28 ; jitter 20,22,24 -> 22 ; decode 3,4,5 -> 4 ; present 8,9,10 -> 9
      ev('L_rtt_recv', 30, recv), ev('L_rtt_recv', 26, recv), ev('L_rtt_recv', 28, recv),
      ev('L_jitterbuffer', 24, recv), ev('L_jitterbuffer', 20, recv), ev('L_jitterbuffer', 22, recv),
      ev('L_decode', 5, recv), ev('L_decode', 3, recv), ev('L_decode', 4, recv),
      ev('L_present', 10, recv), ev('L_present', 8, recv), ev('L_present', 9, recv),
    ]);
    expect(rows).toHaveLength(1);
    // 8 + (30/2 + 28/2) + 22 + 4 + 9 + RESIDUAL = 8 + 29 + 22 + 4 + 9 + 12.5
    expect(rows[0]!.oneWayMs).toBeCloseTo(72 + RESIDUAL_MS, 5);
  });
});
