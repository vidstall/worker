// scripts/analysis/tree-latency-measured.ts — REQ-WLM-09: T-L sweep at MEASURED params.
// Populated 2026-07-05 from the live Azure WAN run (Lane A + Lane B).
// Do NOT edit tree-latency-sweep.ts — this file reuses its EXPORTS only.
// Source of the numbers + fidelity caveats: docs/80-research/evaluation/star-wan-results.md.
import { sweepLatency, findNMax, type SweepConfig, type AudioRegime } from './tree-latency-sweep.js';
import type { LatencyParams } from '../../packages/inter-relay-client/src/index.ts';

// MEASURED (LatencyParams contract, tree-topology.ts:155):
//   lFixedMs   = capture + encode + jitter + decode + render (non-network floor)
//   lastMileMs = t_up + t_down combined (both user<->edge-relay legs)
//   tHopMs     = ONE inter-relay hop, one-way (network + forward)
//
// Lane A (S-baseline-internet, RUN wan-20260705T060736, n=30 sessions):
//   encode 3.1 + jitterbuffer 8.36 + decode 1.06 + present 0(lower-bound) + display-scanout 12.5
//     => lFixedMs = 25.0.  CAPTURE = 0 here (Chromium FAKE device) — REQ-WLM-01a real-camera is
//     user-hands, so lFixedMs is a LOWER BOUND; a real webcam adds ~tens of ms (up to ~100 for USB).
//   RTT_send/2 p50 19.5 + RTT_recv/2 p50 19.5 => lastMileMs = 39.0 (both legs, same-ISP reduced-fidelity).
// Lane B (cross-relay, RUN wanhop-1783237350, n=116, malaysiawest<->koreacentral):
//   t_hop_network p50 => tHopMs = 34.5 (one-way inter-relay forward; RTCP RTT/2 on the piped producer).
//
// Self-consistency: at diameter 0 (single relay) worstMs = lFixedMs+lastMileMs = 64.0 ms, matching the
// Lane-A measured one-way p50 = 64.8 ms. Each added relay level costs tHopMs = 34.5 ms.
const measured: LatencyParams = {
  lFixedMs: 25.0,   // Lane A capture(0,fake)+encode+jitter+decode+render — LOWER BOUND (no real camera)
  lastMileMs: 39.0, // Lane A both-legs last mile (RTT_send/2 + RTT_recv/2), same-ISP reduced-fidelity
  tHopMs: 34.5,     // Lane B one-way inter-relay hop (t_hop_network p50, cross-region WAN)
};

const base: Omit<SweepConfig, 'audioRegime' | 'degreeCap'> = {
  roomClass: 'large', relayMode: 'sfu', cWorker: 300, krMin: 2, maxHeight: 999,
  params: measured, budgetMs: 300,
  nRange: Array.from({ length: 20 }, (_, i) => (i + 1) * 10), // 10..200
};

const blocks: Array<{ audioRegime: AudioRegime; degreeCap: number }> = [
  { audioRegime: 'linear', degreeCap: 2 },
  { audioRegime: 'quadratic', degreeCap: 3 },
  { audioRegime: 'quadratic', degreeCap: 4 },
];

for (const b of blocks) {
  const rows = sweepLatency({ ...base, ...b });
  // eslint-disable-next-line no-console
  console.table(rows.map((r) => ({ N: r.n, kR: r.kR, D: r.degreeCap, diameter: r.diameter, worstMs: r.worstMs, ok: r.withinBudget })));
  // eslint-disable-next-line no-console
  console.log(`[${rows[0]?.label}]  N_max = ${findNMax(rows)}\n`);
}
