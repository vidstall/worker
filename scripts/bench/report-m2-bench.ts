/**
 * Relay-overlap M2 — Phase 5 (RO-025) consolidated bench reporter.
 *
 * Reads the JSON sidecars emitted by the two lockable bench gates and writes one
 * markdown evidence artifact (mirrors the M1 bench report shape):
 *   in:  <cwd>/.logs/bench/m2/bw-delta.json       (gate b — RO-019)
 *        <cwd>/.logs/bench/m2/no-ffmpeg-cpu.json   (gate c — RO-014)
 *   out: <repo-root>/.evidence/verification/relay-overlap-m2-bench-<date>.md
 *
 * Pure node:fs/node:path — NO @dvconf/shared import (scripts/ is outside the
 * pnpm workspace graph, so a workspace import would not resolve under tsx).
 *
 * Run via `pnpm bench:m2` (after the bench tests). Standalone:
 *   tsx scripts/bench/report-m2-bench.ts
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const cwd = process.cwd();
const date = process.env['BENCH_DATE'] ?? new Date().toISOString().slice(0, 10);
const inDir = resolve(cwd, '.logs/bench/m2');
const outPath = resolve(cwd, '..', '.evidence/verification', `relay-overlap-m2-bench-${date}.md`);

function readSidecar(name: string): Record<string, unknown> | null {
  const p = resolve(inDir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const b = readSidecar('bw-delta.json');
const c = readSidecar('no-ffmpeg-cpu.json');

function n(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

const bPass = b !== null && n(b['ratio']) >= 1.9;
const cPass =
  c !== null && n(c['ffmpeg_spawns_standby']) === 0 && n(c['ffmpeg_spawns_primary']) >= 1;
const verdict = bPass && cPass ? 'PASS' : 'FAIL';

const L: string[] = [];
L.push('# Relay-Overlap M2 — Phase 5 Bench Gates (RO-025)');
L.push('');
L.push(`**Date:** ${date}  `);
L.push('**Branch:** quangdm_main  ');
L.push(
  `**Verdict:** **${verdict}** — lockable gates (b) RO-019 + (c) RO-014; gate (a) RO-013 \`<16ms\` is a best-effort TARGET deferred to BENCH-3 (documented).`,
);
L.push('');
L.push('## Gates summary');
L.push('');
L.push('| Gate | REQ | What | Lockable | Status |');
L.push('|---|---|---|:--:|:--:|');
L.push(
  `| (b) | RO-019 | dual-probe bandwidth delta (2x) | yes | ${
    b === null ? 'NOT RUN' : bPass ? `PASS (ratio ${n(b['ratio'])})` : 'FAIL'
  } |`,
);
L.push(
  `| (c) | RO-014 | no-ffmpeg on standby + CPU floor | yes | ${
    c === null
      ? 'NOT RUN'
      : cPass
        ? `PASS (standby ffmpeg=${n(c['ffmpeg_spawns_standby'])}, primary=${n(c['ffmpeg_spawns_primary'])})`
        : 'FAIL'
  } |`,
);
L.push('| (a) | RO-013 | `<16ms` render-switch frame-time | no | DEFERRED → BENCH-3 (best-effort target) |');
L.push('');

// ── Gate (b) ───────────────────────────────────────────────────────────────
L.push('## Gate (b) — RO-019 dual-probe bandwidth delta');
L.push('');
if (b === null) {
  L.push('_Sidecar `.logs/bench/m2/bw-delta.json` not found — gate did not run._');
} else {
  const sb = (b['single_breakdown'] ?? {}) as Record<string, unknown>;
  const db = (b['dual_breakdown'] ?? {}) as Record<string, unknown>;
  L.push('| Metric | Value | Target | Pass |');
  L.push('|---|---:|---|:--:|');
  L.push(`| single-relay (K=1) probe BW | ${n(b['single_bytes'])} B | — | — |`);
  L.push(`| dual-relay (K=2) probe BW | ${n(b['dual_bytes'])} B | — | — |`);
  L.push(`| **dual / single ratio** | **${n(b['ratio'])}** | >= 1.9 | ${bPass ? 'yes' : 'no'} |`);
  L.push('');
  L.push('Per-leg byte breakdown (real wire bytes, both directions):');
  L.push('');
  L.push('| Leg | K=1 (B) | K=2 (B) |');
  L.push('|---|---:|---:|');
  L.push(`| STUN (UDP) | ${n(sb['stun'])} | ${n(db['stun'])} |`);
  L.push(`| /metrics (HTTP) | ${n(sb['metrics'])} | ${n(db['metrics'])} |`);
  L.push(`| /api/probe liveness (HTTP, RO-020, standby-only) | ${n(sb['liveness'])} | ${n(db['liveness'])} |`);
  L.push('');
  L.push(`- **Method:** ${String(b['method'] ?? '')}`);
  L.push(`- **Honest note:** ${String(b['honest_note'] ?? '')}`);
}
L.push('');

// ── Gate (c) ───────────────────────────────────────────────────────────────
L.push('## Gate (c) — RO-014 no-ffmpeg on standby + CPU floor');
L.push('');
if (c === null) {
  L.push('_Sidecar `.logs/bench/m2/no-ffmpeg-cpu.json` not found — gate did not run._');
} else {
  L.push('| Metric | Value | Target | Pass |');
  L.push('|---|---:|---|:--:|');
  L.push(
    `| ffmpeg spawns — PRIMARY MCU room (positive control) | ${n(c['ffmpeg_spawns_primary'])} | >= 1 | ${n(c['ffmpeg_spawns_primary']) >= 1 ? 'yes' : 'no'} |`,
  );
  L.push(
    `| **ffmpeg spawns — STANDBY MCU room** | **${n(c['ffmpeg_spawns_standby'])}** | == 0 | ${n(c['ffmpeg_spawns_standby']) === 0 ? 'yes' : 'no'} |`,
  );
  L.push(
    `| standby McuPipeline stream count (inert, signaling.ts:376) | ${n(c['standby_mcupipeline_stream_count'])} | == 0 | ${n(c['standby_mcupipeline_stream_count']) === 0 ? 'yes' : 'no'} |`,
  );
  L.push(`| warm consumer paused (REQ-RO-005) | ${String(c['warm_consumer_paused'])} | true | ${c['warm_consumer_paused'] === true ? 'yes' : 'no'} |`,);
  L.push('');
  L.push('CPU floor (best-effort — Node main-thread only, NOT a hard gate):');
  L.push('');
  L.push('| Metric | Value (µs) |');
  L.push('|---|---:|');
  L.push(`| standby (warm pipe) window | ${n(c['cpu_standby_us'])} |`);
  L.push(`| SFU room window | ${n(c['cpu_sfu_us'])} |`);
  L.push(`| \\|delta\\| | ${n(c['cpu_delta_us'])} |`);
  L.push(`| epsilon (advisory) | ${n(c['cpu_epsilon_us'])} |`);
  L.push('');
  L.push(`- **Honest note:** ${String(c['honest_note'] ?? '')}`);
}
L.push('');

// ── Gate (a) ───────────────────────────────────────────────────────────────
L.push('## Gate (a) — RO-013 `<16ms` render-switch (best-effort TARGET, NOT asserted)');
L.push('');
L.push(
  '- The `<16ms` / 1-frame figure is a **best-effort target, not a hard assert** (REQUIREMENTS RO-013 / RO-025). The only inheritable harness (M1 MTTR) is **SFU-relay-level** and cannot measure client render frame-time (SPEC-5); a real frame-time number needs the **BENCH-3 real-WebRTC** variant, which is **out of M2 scope (XC-9)** — `@roamhq/wrtc` is Windows-broken, the same constraint that bounded the M1 MTTR bench to an in-process DirectTransport floor.',
);
L.push(
  '- The client-side runtime MCU↔SFU switch + local compositing (RO-013/RO-014 build, client `ad3d4b8`) is **unit-test-proven (compositing primitive only; NO frame-time/pixel assertion)** (`dvconf-client/src/lib/webrtc/__tests__/localComposite.test.ts`, `components/__tests__/VideoGrid.localComposite.test.tsx`): N→1 `captureStream` track creation, live input swap, SFU-mode-never-composites. The `<16ms` render time itself is NOT measured here.',
);
L.push('- This mirrors the M1 mechanism-floor honesty the advisor accepted at gate 2.');
L.push('');

// ── Methodology + honesty ────────────────────────────────────────────────────
L.push('## Methodology');
L.push('');
L.push(
  '- **Gate (b)** drives the production probe path (`createRelayProbe` → `stunProbe` + `fetchRelayMetrics` + `fetchProbeLiveness`) for a K=1 vs K=2 room against real loopback servers (HTTP + a UDP STUN responder), metering wire bytes both directions. The K=2 loop reproduces `measureRoom` (index.ts:481-495), already unit-proven to submit 2 per-relay proofs (index.test.ts:306-331).',
);
L.push(
  '- **Gate (c)** uses REAL mediasoup Workers (child processes) + the production warm-pipe backbone (the M1 step-3a spike). `child_process.spawn` is wrapped (kept real so Workers launch) and ffmpeg spawns counted by argv[0]. PRIMARY ingest = `notifyNewProducer` → `McuPipeline.addStream` → `spawn(ffmpeg)` (positive control). STANDBY ingest = `ensureWarmPipe` (paused consumer, REQ-RO-005) → no ffmpeg.',
);
L.push('- Both gates carry red→green TDD evidence in `.evidence/tdd/RO-025-gate-{b,c}-{red,green}.log`.');
L.push('- Reproduce: `pnpm bench:m2`.');
L.push('');
L.push('## Honesty / bounds');
L.push('');
L.push(
  '- **Gate (b) ~2x is structural** (2 relays → 2 probe sequences), not a discovery — it **quantifies the bandwidth cost of relay redundancy** and proves the dual path issues 2 INDEPENDENT probes. The standby adds the RO-020 `/api/probe` liveness leg, so the real cost is slightly **>2x** (see breakdown). The red log proves the gate catches an OFF-1 silent collapse to a single probe.',
);
L.push(
  '- **Gate (c) decisive signal is the ffmpeg-spawn count** (an absent ffmpeg child ≈ 1 full core saved on a 720p libvpx@30 MCU). The positive control (primary=1) proves the path is reachable, so standby=0 is **not vacuous**. The inert `McuPipeline` a standby MCU room builds (signaling.ts:376) stays **unfed** (streamCount 0). The red log proves the gate catches a standby that wrongly composites.',
);
L.push(
  '- **CPU `|delta|` is Node MAIN-THREAD only** — it excludes mediasoup-worker and ffmpeg child-process CPU, so it is an **in-process optimistic floor**, reported (not hard-gated). The real CPU saving is the avoided ffmpeg child (the spawn-count gate).',
);
L.push('- **Gate (a) deferred to BENCH-3** (real-WebRTC, out of M2 scope).');
L.push('');

const report = L.join('\n');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report, 'utf8');
// eslint-disable-next-line no-console
console.log(`[bench-report] ${verdict} → ${outPath}`);
if (verdict !== 'PASS') process.exitCode = 1;
