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

const report = L.join('\n');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, report, 'utf8');
// eslint-disable-next-line no-console
console.log(`[rms-bench-report] ${verdict} -> ${outPath}`);
if (verdict === 'INCOMPLETE') process.exitCode = 1;
