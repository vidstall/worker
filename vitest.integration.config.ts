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
 * The validator-daemon canary-slash E2E (Phase 4.1, REQ-CFA-006/007/008) and the
 * liveness-ejection E2E ("i expect that job belong to validator" -- validator-driven
 * liveness enforcement) are localnet-booting tests too — matched by the PRECISE
 * `canary-*` / `liveness-*` globs below so they do NOT pull in the sibling
 * `dual-probe-bw-delta.integration.test.ts` (a loopback-HTTP/UDP bench gated behind
 * `pnpm bench:m2`, not a localnet test).
 *
 * Single localnet at a time: forks pool, single fork, no file parallelism, long
 * timeouts to cover `sui start` + publish.
 */
export default defineConfig({
  test: {
    include: [
      '**/cp-daemon/**/__tests__/integration/**/*.integration.test.ts',
      '**/apps/validator-daemon/**/__tests__/integration/canary-*.integration.test.ts',
      '**/apps/validator-daemon/**/__tests__/integration/liveness-*.integration.test.ts',
      // RMS-live LOCAL L3.3 capstone — the headline test (Assertion A boots a localnet,
      // Assertion B is in-process real-mediasoup). Run via `pnpm test:integration rms-live-local`.
      '**/apps/relay/**/__tests__/integration/live/rms-*.integration.test.ts',
    ],
    globals: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
  },
});
