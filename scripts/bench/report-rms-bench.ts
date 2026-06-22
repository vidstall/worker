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
import { computeDemoVerdict, type DemoVerdict } from './report-rms-verdict.js';

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

// independent recompute (BOTH gates) up front, so the gates-summary table can show
// each verdict (no 'see §demo' placeholder). `n` is M1's @:24 — reused.
const audioFloor = audio ? Math.floor(n(audio['n']) / n(audio['k'])) - 1 : 0;
const audioPass = audio !== null && n(audio['ratio']) >= audioFloor && audioFloor > 0;

const demoCascade = (demo?.['cascade'] ?? {}) as Record<string, unknown>;
const demoByz = (demo?.['byzantine'] ?? {}) as Record<string, unknown>;
const demoVerdict: DemoVerdict = demo === null
  ? { pass: false, reasons: ['demo did not run'] }
  : computeDemoVerdict({
      optimizedMaxLoad: n(demo['optimizedMaxLoad']), lowerBound: n(demo['lowerBound']),
      cascade: { zeroCrossHopLoss: demoCascade['zeroCrossHopLoss'] === true, e2eeByteIdentity: demoCascade['e2eeByteIdentity'] === true },
      byzantine: { detectRound: n(demoByz['detectRound']), slashTriggerSet: demoByz['slashTriggerSet'] === true },
    });

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
L.push(`| integrated demo | REQ-RMS-014 | placement + cascade + Byzantine | ${demo === null ? 'NOT RUN' : demoVerdict.pass ? 'PASS' : 'FAIL'} |`);
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

// ── integrated-demo gate detail (REQ-RMS-014) ─────────────────────────────────
L.push('## REQ-RMS-014 — integrated demo');
L.push('');
if (demo === null) {
  L.push('_Sidecar `.logs/bench/rms/mesh-demo.json` not found — demo did not run._');
} else {
  const cascade = demoCascade;
  const byz = demoByz;
  L.push(`**Demo verdict (independently recomputed):** **${demoVerdict.pass ? 'PASS' : 'FAIL'}**${demoVerdict.pass ? '' : ' — ' + demoVerdict.reasons.join('; ')}`);
  L.push('');
  L.push('| Metric | Value | Target | Pass |');
  L.push('|---|---:|---|:--:|');
  L.push(`| M (relay pool) / R (rooms) | ${n(demo['M'])} / ${n(demo['R'])} | M=5 R=20-30 | — |`);
  L.push(`| baseline algo | ${String(demo['baselineAlgo'])} | named | — |`);
  L.push(`| baseline max-load | ${n(demo['baselineMaxLoad'])} | — | — |`);
  L.push(`| optimized max-load | ${n(demo['optimizedMaxLoad'])} | <= 1.2x lower bound | ${n(demo['optimizedMaxLoad']) <= Math.ceil(n(demo['lowerBound']) * 1.2) ? 'yes' : 'no'} |`);
  L.push(`| lower bound | ${n(demo['lowerBound'])} | — | — |`);
  L.push(`| max-load reduction vs baseline | ${n(demo['maxLoadReductionVsBaseline'])}x | materially below | — |`);
  L.push(`| cascade zero cross-hop loss | ${String(cascade['zeroCrossHopLoss'])} | true | ${cascade['zeroCrossHopLoss'] === true ? 'yes' : 'no'} |`);
  L.push(`| E2EE byte-identity across hops | ${String(cascade['e2eeByteIdentity'])} | true | ${cascade['e2eeByteIdentity'] === true ? 'yes' : 'no'} |`);
  L.push(`| Byzantine detect round | ${n(byz['detectRound'])} | <= 7 | ${n(byz['detectRound']) >= 0 && n(byz['detectRound']) <= 7 ? 'yes' : 'no'} |`);
  L.push(`| Byzantine slash-trigger | ${String(byz['slashTriggerSet'])} (${String(byz['slashMode'])}) | set | ${byz['slashTriggerSet'] === true ? 'yes' : 'no'} |`);
  L.push('');
  L.push(`- **Honest note:** ${String(demo['honest_note'] ?? '')}`);
}
L.push('');
L.push('## Methodology');
L.push('');
L.push('- **Placement** (legs a/b): a named round-robin baseline vs the load-aware i*=argmin scorer over M relays / R rooms; max-relay-load is the metric; the RED hook `RMS_DEMO_DISABLE_SCORER=1` collapses placement to the degenerate `placeAllOnFirst` (all rooms on relay 0), which overloads past 1.2x the lower bound and FAILS the gate — proving the scorer is load-bearing.');
L.push('- **Cascade** (legs c/d): a real 2-router mediasoup pipe via the M2 primitives (`createPrimaryPipeTransport` / `pipeProducerOntoPrimaryTransport`); zero cross-hop loss = downstream packetCount>0; E2EE byte-identity = forwarded body bytes equal the sent ciphertext (mediasoup rewrites only the RTP header).');
L.push('- **Byzantine** (legs e/f): the SHIPPED hermetic canary pipeline (`runCanaryVerifyRound`) is fed real per-(relay,room) DROP observations; detect-latency = rounds until the cumulative bound crosses; the slash-trigger is ASSERTED set (a proof is submitted to the injected seam), NOT a live on-chain slash.');
L.push('- Reproduce: `pnpm bench:rms`.');
L.push('');
L.push('## Honesty / bounds');
L.push('');
L.push('- **Mechanism-floor:** >100 users/room is synthetic path-count load (not 100 real browsers), C_worker is an order-of-magnitude figure pending the M1 calibration bench, no WAN / glass-to-glass (BENCH-3-deferred).');
L.push('- **Canary reuse is HERMETIC:** the Byzantine detect+slash reuses a hermetically-proven pipeline; live cross-validator media capture + the live on-chain slash submit are canary-M4b. The SECONDARY >=k receiver signal is SIMULATED (W-M3-SIM). The slash-trigger is ASSERTED, not executed live (stated per REQ-RMS-014).');
L.push('- **No new Byzantine mechanism + no change to the 145-byte frozen proof / classifier** — the mesh reuses the shipped canary lane verbatim.');
L.push('');

// Write the M3 doc to a SEPARATE artifact (M1's m1-bench writeFileSync above STAYS). `date` is M1's.
const outPathM3 = resolve(cwd, '..', '.evidence/verification', `relay-mesh-scaling-m3-bench-${date}.md`);
const reportM3 = L.join('\n');
mkdirSync(dirname(outPathM3), { recursive: true });
writeFileSync(outPathM3, reportM3, 'utf8');
// eslint-disable-next-line no-console
console.log(`[bench-report] audio=${audioPass ? 'PASS' : 'CHECK'} -> ${outPathM3}`);
// combined exit-code: M1 INCOMPLETE OR audio-gate fail OR demo-gate fail (ONE write).
if (verdict === 'INCOMPLETE' || (audio !== null && !audioPass) || (demo !== null && !demoVerdict.pass)) process.exitCode = 1;
