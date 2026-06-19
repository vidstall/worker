import { defineConfig } from 'vitest/config';

/**
 * Canary forwarding-audit integration config (REQ-CFA-010 — isolation).
 *
 * The canary Wave's integration tests boot HEAVY, env-sensitive fixtures and must
 * NOT co-run with the relay-overlap heavy benches (mediasoup worker contention +
 * localnet env). This config gives the canary integration suite its OWN narrow run
 * so it is isolated from `vitest.relay-integration.config.ts` (the 3 heavy benches:
 * bandwidth-scale-bench / relay-blind-realsframe / relay-overlap-mttr, plus
 * relay-overlap-m2-bench). Those benches now EXCLUDE the canary tests; the canary
 * tests live ONLY here. Mirrors the narrow-include precedent of
 * vitest.m2-bench.config.ts.
 *
 * Matches exactly the two canary integration tests:
 *   - REQ-CFA-003/009 forward leg (REAL mediasoup DirectTransport):
 *       apps/relay/src/__tests__/integration/canary-forward.integration.test.ts
 *   - REQ-CFA-006/007/008 slash E2E (boots Sui localnet — ~1/3 flaky on Windows):
 *       apps/validator-daemon/src/__tests__/integration/canary-slash-e2e.integration.test.ts
 *
 * Both are EXCLUDED from the hermetic unit run (`pnpm test`) by the integration-dir
 * excludes in vitest.config.ts, and the validator one is ALSO matched by
 * vitest.integration.config.ts (the localnet gate). Run this isolated suite via:
 *   pnpm exec vitest run --config vitest.canary.config.ts
 *
 * Forks pool / single fork / no file parallelism so the mediasoup Workers (forward
 * leg) and the localnet (slash E2E) never race; mirrors the bench configs. Timeout
 * is generous (60s) to cover mediasoup worker spawn + RTP settling and localnet
 * `sui start` warm-up.
 */
export default defineConfig({
  test: {
    include: [
      '**/apps/relay/**/__tests__/integration/canary-*.integration.test.ts',
      '**/apps/validator-daemon/**/__tests__/integration/canary-*.integration.test.ts',
    ],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
