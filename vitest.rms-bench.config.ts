import { defineConfig } from 'vitest/config';

/**
 * relay-mesh-scaling M1 — capacity-calibration bench config (REQ-RMS-001).
 *
 * Explicit-include + forks/singleFork (real mediasoup Workers must not race), cloned from
 * vitest.m2-bench.config.ts. Includes BOTH the NEW audio spike AND the (extended) single-worker
 * saturation bench so `pnpm bench:rms` is a true one-shot that emits the saturation-3mode.json
 * sidecar the reporter consumes. Both files are env-gated (RMS_BENCH / SAT_BENCH) so neither runs
 * under the default `pnpm test`. The saturation bench ALSO remains discoverable by the broad
 * vitest.relay-integration.config.ts (SAT_BENCH-gated) for standalone runs.
 * Run via `pnpm bench:rms`.
 */
export default defineConfig({
  test: {
    include: [
      '**/apps/relay/**/__tests__/integration/audio-spike.integration.test.ts',                    // M1 (keep)
      '**/apps/relay/**/__tests__/integration/single-worker-saturation-bench.integration.test.ts',  // M1 (keep)
      // REQ-RMS-014/012 (M3): the heavy mesh-demo capstone + audio last-N benches run ONLY here
      // (forks/singleFork). `pnpm bench:rms` sets RMS_BENCH=1 SAT_BENCH=1 so all 4 run one-shot.
      '**/apps/relay/**/__tests__/integration/mesh-placement-demo.integration.test.ts',             // M3 (add)
      '**/apps/relay/**/__tests__/integration/audio-lastN.integration.test.ts',                     // M3 (add)
    ],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
