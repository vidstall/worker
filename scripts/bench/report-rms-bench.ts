/**
 * relay-mesh-scaling M1 — capacity calibration bench reporter (REQ-RMS-001).
 *
 * Reads the RMS bench sidecar and writes ONE markdown evidence artifact (mirrors
 * report-m2-bench.ts):
 *   in:  <cwd>/.logs/bench/rms/saturation-3mode.json
 *   out: <repo-root>/.evidence/verification/relay-mesh-scaling-m1-bench-<date>.md
 *
 * Pure node:fs/node:path — NO @dvconf/shared import (scripts/ is outside the workspace graph).
 * Run via `pnpm bench:rms` (after the bench tests). Standalone: tsx scripts/bench/report-rms-bench.ts
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const cwd = process.cwd();
const date = process.env['BENCH_DATE'] ?? new Date().toISOString().slice(0, 10);
const inPath = resolve(cwd, '.logs/bench/rms/saturation-3mode.json');
const outPath = resolve(cwd, '..', '.evidence/verification', `relay-mesh-scaling-m1-bench-${date}.md`);

function readSidecar(p: string): Record<string, unknown> | null {
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
}
function n(v: unknown): number { return typeof v === 'number' ? v : Number(v ?? 0); }

const s = readSidecar(inPath);
// Independent recompute: C_worker must be a positive path-count; C_relay = cores * C_worker.
const cWorker = s ? n(s['cWorkerPaths']) : 0;
const cores = s ? n(s['cores']) : 0;
const cRelay = cWorker * cores;
const cRelayMatches = s !== null && n(s['cRelayPaths']) === cRelay; // sidecar agrees with our recompute
const verdict = s !== null && cWorker > 0 && cRelayMatches ? 'MEASURED' : 'INCOMPLETE';

const L: string[] = [];
L.push('# Relay-Mesh Scaling M1 — Capacity Calibration Bench (REQ-RMS-001)');
L.push('');
L.push(`**Date:** ${date}  `);
L.push('**Branch:** quangdm_main  ');
L.push(`**Verdict:** **${verdict}** — EXPLORATORY mechanism-floor (NOT a hard pass/fail gate).`);
L.push('');
L.push('## Measured capacity');
L.push('');
L.push('| Quantity | Value | Notes |');
L.push('|---|---:|---|');
L.push(`| C_worker (per-room ceiling, forward-paths @ knee) | ${cWorker || 'n/a'} | video-only knee; SRTP skipped -> OPTIMISTIC |`);
L.push(`| cores | ${cores || 'n/a'} | os.cpus().length on the bench box |`);
L.push(`| C_relay = cores x C_worker | ${cRelay || 'n/a'} | EXTRAPOLATION, not a measurement (DA-5) |`);
L.push(`| audio baked into C_worker? | ${s ? String(s['audioBakedIn']) : 'n/a'} | mixed-30+70 knee vs video-only knee |`);
L.push('');
L.push('## Methodology');
L.push('');
L.push('- ONE mediasoup Worker (== one core), real C++ subprocess; `worker.getResourceUsage()` cpu cores read over a fixed window.');
L.push('- Three modes: (a) video-only audio-muted; (b) audio-only N-peer (O(N^2) fan); (c) mixed 30-active + 70-audio.');
L.push('- C_worker = video-only knee forward-paths; C_relay = cores x C_worker (extrapolation).');
L.push('- Reproduce: `pnpm bench:rms`.');
L.push('');
L.push('## Honesty / bounds (mechanism-floor)');
L.push('');
L.push('- **DirectTransport SKIPS SRTP** -> measured CPU is OPTIMISTIC; the real WebRTC ceiling is LOWER (+-2-3x variance, not reproducible).');
L.push('- **C_relay is extrapolated**, not measured: a single Worker was benched; cross-worker spread is NOT built in M1.');
L.push('- **Audio fan-out is ~O(N^2)** with no server-side last-N (REQ-RMS-012 deferred); audio paths counted CONSERVATIVELY.');
L.push('- Single box, synthetic RTP, no WAN/jitter. This proves the MECHANISM-FLOOR, not a production capacity number.');
L.push('');

// M1 calibration artifact (relay-mesh-scaling-m1-bench-<date>.md) — written exactly as M1 shipped.
const report = L.join('\n');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report, 'utf8');
// eslint-disable-next-line no-console
console.log(`[rms-bench-report] ${verdict} -> ${outPath}`);

// === M3 (REQ-RMS-012 / REQ-RMS-014) — ADDITIVE: audio last-N + integrated-demo sidecar sections. ===
// Reuses M1's cwd/date/n/L (NOT re-declared); writes a SEPARATE relay-mesh-scaling-m3-bench-<date>.md.
// M1's readSidecar(p) @:20 is PATH-based; the M3 reads are NAME-based -> readNamedSidecar (no collision).
const inDir = resolve(cwd, '.logs/bench/rms');
function readNamedSidecar(name: string): Record<string, unknown> | null {
  const p = resolve(inDir, name);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>; } catch { return null; }
}
const audio = readNamedSidecar('audio-lastn.json');
const demo = readNamedSidecar('mesh-demo.json');

// independent recompute: audio last-N gate (ratio >= floor(N/k)-1). `n` is M1's @:24 — reused.
const audioFloor = audio ? Math.floor(n(audio['n']) / n(audio['k'])) - 1 : 0;
const audioPass = audio !== null && n(audio['ratio']) >= audioFloor && audioFloor > 0;

// PUSH the M3 sections onto M1's existing `const L` (@:34), AFTER M1's saturation block + m1-bench write.
L.push('');
L.push('---');
L.push('# Relay-Mesh-Scaling M3 — Bench Gates (REQ-RMS-012 / REQ-RMS-014)');
L.push('');
L.push('## Gates summary');
L.push('');
L.push('| Gate | REQ | What | Status |');
L.push('|---|---|---|:--:|');
L.push(`| audio last-N | REQ-RMS-012 | top-k forwarded-byte reduction | ${audio === null ? 'NOT RUN' : audioPass ? `PASS (ratio ${n(audio['ratio'])} >= ${audioFloor})` : 'FAIL'} |`);
L.push(`| integrated demo | REQ-RMS-014 | placement + cascade + Byzantine | ${demo === null ? 'NOT RUN' : 'see §demo'} |`);  // 'see §demo' until Task 8 wires computeDemoVerdict
L.push('');

// ── audio gate detail ─────────────────────────────────────────────────────────
L.push('## REQ-RMS-012 — audio last-N');
L.push('');
if (audio === null) {
  L.push('_Sidecar `.logs/bench/rms/audio-lastn.json` not found — gate did not run._');
} else {
  L.push('| Metric | Value | Target | Pass |');
  L.push('|---|---:|---|:--:|');
  L.push(`| N audio producers | ${n(audio['n'])} | — | — |`);
  L.push(`| k (top-k forwarded) | ${n(audio['k'])} | env AUDIO_LASTN_K | — |`);
  L.push(`| all-N forwarded bytes | ${n(audio['baselineBytes'])} | — | — |`);
  L.push(`| top-k forwarded bytes | ${n(audio['optimizedBytes'])} | — | — |`);
  L.push(`| **ratio** | **${n(audio['ratio'])}** | >= ${audioFloor} | ${audioPass ? 'yes' : 'no'} |`);
  L.push('');
  L.push(`- **Honest note:** ${String(audio['honest_note'] ?? '')}`);
}
L.push('');

// Write the M3 doc to a SEPARATE artifact (M1's m1-bench writeFileSync above STAYS). `date` is M1's.
const outPathM3 = resolve(cwd, '..', '.evidence/verification', `relay-mesh-scaling-m3-bench-${date}.md`);
const reportM3 = L.join('\n');
mkdirSync(dirname(outPathM3), { recursive: true });
writeFileSync(outPathM3, reportM3, 'utf8');
// eslint-disable-next-line no-console
console.log(`[bench-report] audio=${audioPass ? 'PASS' : 'CHECK'} -> ${outPathM3}`);
// combined exit-code: M1 INCOMPLETE OR audio-gate fail (Task 8 folds in the demo term).
if (verdict === 'INCOMPLETE' || (audio !== null && !audioPass)) process.exitCode = 1;
