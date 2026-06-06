import { defineConfig } from 'vitest/config';

/**
 * Relay-overlap M2 — Phase 5 bench config (RO-025).
 *
 * Runs the two lockable bench gates, both EXCLUDED from the hermetic unit run
 * (`pnpm test`) and gated here behind `pnpm bench:m2`:
 *   - gate (b) RO-019 dual-probe bandwidth delta
 *       apps/validator-daemon/src/__tests__/integration/dual-probe-bw-delta.integration.test.ts
 *       (real loopback HTTP + UDP STUN responder; no mediasoup)
 *   - gate (c) RO-014 no-ffmpeg + CPU floor
 *       apps/relay/src/__tests__/integration/relay-overlap-m2-bench.integration.test.ts
 *       (REAL mediasoup Workers — child processes — + child_process.spawn spy)
 *
 * Forks pool / single fork / no file parallelism so the mediasoup Workers in
 * gate (c) do not race (mirrors vitest.relay-integration.config.ts). The
 * consolidated markdown report is assembled afterwards by
 * `scripts/bench/report-m2-bench.ts` from the JSON sidecars each gate emits.
 */
export default defineConfig({
  test: {
    include: [
      '**/apps/validator-daemon/**/__tests__/integration/dual-probe-bw-delta.integration.test.ts',
      '**/apps/relay/**/__tests__/integration/relay-overlap-m2-bench.integration.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
