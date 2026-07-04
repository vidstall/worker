// scripts/analysis/tree-latency-measured.ts — REQ-WLM-09: T-L sweep at MEASURED params.
// Driver scaffold only — Step 1 of Task 9 (WAN latency-measurement lane).
// The MEASURED values below are PLACEHOLDERS; replace after the live WAN run produces real numbers.
// Do NOT edit tree-latency-sweep.ts — this file reuses its EXPORTS only.
import { sweepLatency, findNMax, type SweepConfig, type AudioRegime } from './tree-latency-sweep.js';
import type { LatencyParams } from '../../packages/inter-relay-client/src/index.ts';

// PLACEHOLDER — replace with values derived from the live WAN run (Task 9 Step 1):
//   lFixedMs   = Lane A: median(L_encode + L_jitterbuffer + L_decode + L_present)
//   lastMileMs = Lane A: median(L_rtt_send/2) + median(L_rtt_recv/2)   // BOTH legs (B1)
//   tHopMs     = Lane B: median(t_hop_network)                          // MUST be > 0
// Until then these are 0/placeholders and the sweep is NOT authoritative.
const measured: LatencyParams = {
  lFixedMs: 0,    /* TODO measured: Lane A fixed-pipeline floor (ms) */
  lastMileMs: 0,  /* TODO measured: combined both-legs last-mile (ms) */
  tHopMs: 1,      /* TODO measured: one-way inter-relay hop (ms); kept >0 so sweepLatency doesn't throw */
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
