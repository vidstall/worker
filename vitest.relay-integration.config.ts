import { defineConfig, configDefaults } from 'vitest/config';

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
 *
 * REQ-CFA-010 (canary isolation): the broad `integration/**` include below ALSO
 * matches the canary forward-leg test (`canary-forward.integration.test.ts`).
 * That canary suite is now isolated into its OWN run (vitest.canary.config.ts) so
 * it does not co-run with the 3 heavy relay-overlap benches here. We therefore
 * EXCLUDE the `canary-*` integration tests from this heavy-bench config; the
 * benches (bandwidth-scale / relay-blind-realsframe / relay-overlap-mttr /
 * relay-overlap-m2-bench) stay included and unchanged.
 */
export default defineConfig({
  test: {
    include: ['**/apps/relay/**/__tests__/integration/**/*.integration.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      '**/apps/relay/**/__tests__/integration/canary-*.integration.test.ts',
      // F1 Tier-3 live-link gate runs under its OWN config (vitest.relay-livelink.config.ts):
      // it binds a metrics port + ws server, so keep it OUT of the heavy-bench run.
      '**/apps/relay/**/__tests__/integration/live/**',
    ],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
