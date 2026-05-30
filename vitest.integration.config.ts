import { defineConfig } from 'vitest/config';

/**
 * Integration test config — LOCALNET-BOOTING tests only.
 *
 * Split rationale (mirrors the exclude in vitest.config.ts): the cp-daemon
 * `__tests__/integration/` dir holds tests that spawn a real `sui start`
 * localnet (heavy, env-sensitive). They are EXCLUDED from the hermetic unit run
 * (`pnpm test`) and gated behind `pnpm test:integration` (this config). The
 * signaling `__tests__/integration/cap-token-e2e.integration.test.ts` is
 * mock-based (no localnet) and deliberately NOT matched here — it stays in the
 * unit run.
 *
 * Single localnet at a time: forks pool, single fork, no file parallelism, long
 * timeouts to cover `sui start` + publish.
 */
export default defineConfig({
  test: {
    include: ['**/cp-daemon/**/__tests__/integration/**/*.integration.test.ts'],
    globals: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
