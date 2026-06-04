import { defineConfig } from 'vitest/config';

/**
 * Relay integration test config -- REAL-mediasoup-worker tests only.
 *
 * Mirrors the cp-daemon integration split (vitest.integration.config.ts): the
 * relay `apps/relay/src/__tests__/integration/` dir holds tests that spawn REAL
 * mediasoup Workers (child processes) and push real RTP. They are EXCLUDED from
 * the hermetic unit run (`pnpm test`, see the exclude added to vitest.config.ts)
 * and gated behind this config (`pnpm test:integration:relay`).
 *
 * Forks pool, single fork, no file parallelism, longer timeouts to cover worker
 * spawn + RTP settling.
 */
export default defineConfig({
  test: {
    include: ['**/apps/relay/**/__tests__/integration/**/*.integration.test.ts'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
