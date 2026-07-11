/**
 * Offline glass-to-glass join (spec `wan-latency-measurement` REQ-WLM-03).
 * Browser A cannot see browser B's getStats, so each emits its own half tagged
 * (room_id, flow_id, direction). This assembles the one-way estimate per flow:
 *
 *   L_oneway = encode_send + (RTT_send/2 + RTT_recv/2)
 *            + jitterBuffer_recv + decode_recv + present_recv + residual
 *
 * BOTH candidate-pair RTTs are summed — each measures only its own last-mile
 * leg; a single RTT/2 drops one (~15-25 ms same-region), the defect in
 * mediasoup-client-harness.ts:289. Residual = the recv-side display present/scan-out
 * tail ONLY (see RESIDUAL_MS); camera-sensor+USB capture is NOT folded here — it is
 * the dominant unmeasured term for real webcams and is reported separately, never
 * folded silently (spec D3, ND-3).
 */
import { loadTrace, percentile } from './replay.js';
import type { LatencyEvent } from '@dvconf/shared';

/**
 * ND-3 (RESOLVED 2026-07-05): display present/scan-out residual — the recv-side tail
 * AFTER present_recv (requestVideoFrameCallback fires at compositor hand-off, before
 * photons). At 60 Hz the frame period is 1000/60 = 16.67 ms; scan-out adds ~half-frame
 * (~8.3 ms) on average plus ~5 ms panel GtG, and an infinite-mirror teardown attributes
 * up to ~17 ms to display refresh. 12.5 ms is the midpoint of that ~[8.3, 17] ms band.
 *
 * Camera-sensor+USB capture is deliberately NOT in this constant: RTCStats timing starts
 * at the encoder, so the whole capture path is upstream of every measured term. Fake-device
 * sessions have ~0 capture (residual = display only), but 12.5 ms remains a fixed modelling
 * constant (band midpoint), not a measured value; the
 * REQ-WLM-01a real-camera subset must report capture as a measured/bounded term (~tens of ms,
 * up to ~100 ms dominant for USB webcams), never folded into RESIDUAL_MS.
 * Ref: Transitive Robotics, "WebRTC Latency: A Breakdown" (infinite-mirror measurement).
 */
export const RESIDUAL_MS = 12.5;

export interface OneWayRow {
  roomId: string;
  flowId: string;
  oneWayMs: number;
  components: {
    encodeSend: number; jitterBufferRecv: number; decodeRecv: number; presentRecv: number; residual: number;
  };
  network: { rttSendHalf: number; rttRecvHalf: number };
}

type Ctx = { room_id?: unknown; flow_id?: unknown; direction?: unknown };
/** Median of a component's samples within one session group (robust to 1 Hz autocorrelation — Concern-4). */
const median = (evs: LatencyEvent[], metric: string): number | undefined => {
  const v = evs.filter((e) => e.metric === metric).map((e) => e.value_ms).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
};

export function assembleOneWay(events: LatencyEvent[]): OneWayRow[] {
  // group by room_id|flow_id, split by direction
  const groups = new Map<string, { send: LatencyEvent[]; recv: LatencyEvent[]; roomId: string; flowId: string }>();
  for (const e of events) {
    const c = (e.context ?? {}) as Ctx;
    if (typeof c.room_id !== 'string' || typeof c.flow_id !== 'string' || typeof c.direction !== 'string') continue;
    const key = `${c.room_id}|${c.flow_id}`;
    let g = groups.get(key);
    if (g === undefined) { g = { send: [], recv: [], roomId: c.room_id, flowId: c.flow_id }; groups.set(key, g); }
    (c.direction === 'send' ? g.send : g.recv).push(e);
  }

  const rows: OneWayRow[] = [];
  for (const g of groups.values()) {
    if (g.send.length === 0 || g.recv.length === 0) continue; // unpaired -> drop
    const encodeSend = median(g.send, 'L_encode');
    const rttSend = median(g.send, 'L_rtt_send');
    const rttRecv = median(g.recv, 'L_rtt_recv');
    const jitterBufferRecv = median(g.recv, 'L_jitterbuffer');
    const decodeRecv = median(g.recv, 'L_decode');
    const presentRecv = median(g.recv, 'L_present') ?? 0;
    // L_present (requestVideoFrameCallback) absent -> treated as 0, making oneWayMs a conservative
    // LOWER BOUND for that session. Coverage (RESOLVED 2026-07-05): rVFC is Baseline "widely available"
    // since Oct 2024 — Chrome/Edge 83+ (2020-05), Safari 15.4+ (2022-03), Firefox 132+ (2024-10) [MDN/
    // caniuse]. The Playwright driver runs Chromium and rVFC is Baseline-available, so a harness that
    // surfaces present_recv COULD capture it; empirically, however, the STAR run wan-20260705T060736
    // emitted ZERO L_present samples (see docs/80-research/evaluation/raw/README.md), so this `?? 0`
    // fallback DID fire for every session and the reported figure is a LOWER BOUND, not exact. The
    // fallback is safe -- folding 0 for a non-negative term cannot inflate the total -- by design;
    // the absence itself is a property of this run, not a guarantee.
    if (
      encodeSend === undefined || rttSend === undefined || rttRecv === undefined ||
      jitterBufferRecv === undefined || decodeRecv === undefined
    ) continue;
    // all five are now `number` — no casts below this line.
    const rttSendHalf = rttSend / 2;
    const rttRecvHalf = rttRecv / 2;
    const oneWayMs =
      encodeSend + rttSendHalf + rttRecvHalf +
      jitterBufferRecv + decodeRecv + presentRecv + RESIDUAL_MS;
    rows.push({
      roomId: g.roomId, flowId: g.flowId, oneWayMs,
      components: {
        encodeSend, jitterBufferRecv,
        decodeRecv, presentRecv, residual: RESIDUAL_MS,
      },
      network: { rttSendHalf, rttRecvHalf },
    });
  }
  return rows;
}

// ── CLI: assemble from a trace ────────────────────────────────────────
function main(): void {
  const traceId = process.argv[2];
  const outputDir = process.argv[3] ?? 'bench-output';
  if (traceId === undefined) throw new Error('Usage: tsx scripts/bench/join-g2g.ts <trace-id> [output-dir]');
  const events = loadTrace(outputDir, traceId);
  const rows = assembleOneWay(events);
  if (rows.length === 0) { console.warn('No flows assembled — verify the trace ID and output directory.'); return; }
  console.table(rows.map((r) => ({ session: r.roomId, flow: r.flowId, oneWayMs: r.oneWayMs.toFixed(1), ...r.network })));

  // Per-session p95 ACROSS sessions (REQ-WLM-05, B2): each row = one session's estimate.
  const oneWays = rows.map((r) => r.oneWayMs).sort((a, b) => a - b);
  if (oneWays.length >= 5) {
    console.log(
      `per-session one-way (n=${oneWays.length} sessions): ` +
      `p50=${percentile(oneWays, 0.5).toFixed(1)} p95=${percentile(oneWays, 0.95).toFixed(1)} ` +
      `p99=${percentile(oneWays, 0.99).toFixed(1)} ms`,
    );
  } else {
    console.log(`per-session one-way: n=${oneWays.length} sessions (<5 -> percentiles suppressed; REQ-WLM-05 wants >=30)`);
  }

  // Concern-5: surface dropped (unpaired / incomplete) flows instead of silently continuing.
  const groups = new Set(
    events
      .map((e) => e.context as { room_id?: string; flow_id?: string; direction?: string } | undefined)
      .filter((c) => typeof c?.room_id === 'string' && typeof c?.flow_id === 'string' && typeof c?.direction === 'string')
      .map((c) => `${c!.room_id}|${c!.flow_id}`),
  );
  const dropped = groups.size - rows.length;
  if (dropped > 0) console.warn(`WARNING: ${dropped} flow(s) dropped (unpaired send/recv or missing a component).`);
}
const isMain = process.argv[1]?.endsWith('join-g2g.ts') === true || process.argv[1]?.endsWith('join-g2g.js') === true;
if (isMain) main();
