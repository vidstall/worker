/**
 * Relay-overlap M1 — client-perceived cutover MTTR bench (Phase 5.3, step 3b).
 *
 * Produces THE number for advisor gate 2 and asserts it against the
 * REQUIREMENTS success-metric (P95 <= 100 ms / P99 <= 200 ms).
 *
 * See relay-overlap-mttr.fixtures.ts for the full methodology / honesty-bounds
 * narrative, env-knob reference, the replicated rtp-timeout-watcher, and the
 * armRun/measureOnce/buildReport scaffold this bench drives.
 *
 * Run: pnpm exec vitest run --config vitest.relay-integration.config.ts \
 *        apps/relay/src/__tests__/integration/relay-overlap-mttr.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LatencyWriter } from '@dvconf/shared';
import {
  RTP_TIMEOUT_MS,
  RUNS,
  BENCH_RUN_ID,
  BENCH_COMMIT,
  BENCH_EVIDENCE_DIR,
  BENCH_RAW_DIR,
  percentile,
  sleep,
  measureOnce,
  fmt,
  buildReport,
  type RunResult,
} from './relay-overlap-mttr.fixtures.js';

describe('relay-overlap M1 — client-perceived cutover MTTR (P95/P99 bench)', () => {
  it(
    `runs N=${RUNS} cutovers and meets P95<=100ms / P99<=200ms`,
    async () => {
      const evidencePath = resolve(
        process.cwd(),
        BENCH_EVIDENCE_DIR,
        `relay-overlap-m1-bench-${BENCH_RUN_ID}.md`,
      );
      const rawEvidencePath = resolve(
        process.cwd(),
        BENCH_RAW_DIR,
        `adhoc-client-${BENCH_RUN_ID}.jsonl`,
      );
      if (existsSync(evidencePath) || existsSync(rawEvidencePath)) {
        throw new Error(
          `refusing to overwrite existing MTTR evidence: report=${evidencePath} raw=${rawEvidencePath}`,
        );
      }

      const writer = new LatencyWriter({
        source: 'client',
        instance: `relay-overlap-mttr:${BENCH_RUN_ID}`,
        outputDir: resolve(process.cwd(), BENCH_RAW_DIR),
        scenario: 'adhoc',
        traceId: BENCH_RUN_ID,
      });
      expect(writer.getFilePath()).toBe(rawEvidencePath);

      const results: RunResult[] = [];
      let failures = 0;
      for (let i = 0; i < RUNS; i++) {
        try {
          const r = await measureOnce();
          results.push(r);
          writer.write('L_g2g_optA', r.mttrMs, {
            run: i,
            detect_ms: r.detectMs,
            resume_to_first_ms: r.resumeToFirstMs,
            primary_pkts: r.primaryPkts,
            standby_pkts: r.standbyPkts,
            rtp_timeout_ms: RTP_TIMEOUT_MS,
            run_id: BENCH_RUN_ID,
            bench_commit: BENCH_COMMIT,
          });
          // eslint-disable-next-line no-console
          console.log(
            `[mttr-bench] run ${i + 1}/${RUNS}: MTTR=${fmt(r.mttrMs)}ms ` +
              `(detect=${fmt(r.detectMs)} resume+relay=${fmt(r.resumeToFirstMs)}) ` +
              `pPkts=${r.primaryPkts} sPkts=${r.standbyPkts}`,
          );
        } catch (e) {
          failures++;
          // eslint-disable-next-line no-console
          console.error(`[mttr-bench] run ${i + 1}/${RUNS} FAILED: ${String(e)}`);
        }
        await sleep(50);
      }
      writer.close();

      expect(results.length).toBeGreaterThan(0);

      const report = buildReport(results, failures, rawEvidencePath);
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, report, { encoding: 'utf8', flag: 'wx' });
      // eslint-disable-next-line no-console
      console.log(`\n[mttr-bench] report -> ${evidencePath}`);
      // eslint-disable-next-line no-console
      console.log('\n' + report);

      const mttr = results.map((r) => r.mttrMs).sort((a, b) => a - b);
      const p95 = percentile(mttr, 0.95);
      const p99 = percentile(mttr, 0.99);
      // Hard assertions on the advisor-gate success metric.
      expect(results.length).toBeGreaterThanOrEqual(30);
      expect(failures).toBe(0);
      expect(p95).toBeLessThanOrEqual(100);
      expect(p99).toBeLessThanOrEqual(200);
    },
    180_000,
  );
});
