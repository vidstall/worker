import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/__tests__/**/*.test.ts'],
    // Unit/integration split (zero regression): the cp-daemon
    // __tests__/integration/ dir holds LOCALNET-BOOTING tests that spawn
    // `sui start` — they run only via `pnpm test:integration`
    // (vitest.integration.config.ts), never in the hermetic unit suite. This
    // exclude is scoped to cp-daemon ONLY, so the mock-based signaling
    // cap-token-e2e.integration.test.ts (no localnet) keeps running here.
    exclude: [...configDefaults.exclude, '**/cp-daemon/**/__tests__/integration/**'],
    globals: false,
    testTimeout: 10_000,
  },
});
