import { defineConfig } from 'vitest/config';

/**
 * F1 Tier-3 LIVE-LINK gate (REQ-RO-003) — real inter-relay WS link + real
 * metrics server + real mediasoup, single-process real-link-loopback (design
 * OQ#5 accepted fallback; two-process full-daemon spawn = documented STRETCH).
 *
 * Isolated into its OWN config (mirrors vitest.canary.config.ts / vitest.m2-bench.config.ts):
 * it binds a metrics HTTP port + a ws server + spawns mediasoup workers, so it must
 * NOT co-run with the heavy relay-overlap benches. Forks / single fork / no parallelism.
 */
export default defineConfig({
  test: {
    include: ['**/apps/relay/**/__tests__/integration/live/**/*.integration.test.ts'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
