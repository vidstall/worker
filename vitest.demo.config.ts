import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Demo-scenario config — DOCKER-STACK E2E only (F47 Phase 5.5, REQ-RV-015).
 *
 * Runs `tests/demo-scenarios/revote-m1.test.ts`, which boots the docker demo
 * stack (`docker-compose-demo*.yml`) and drives the re-vote scenarios against the
 * docker-published chain. EXCLUDED from both the hermetic unit run (`pnpm test`)
 * and the in-process localnet run (`pnpm test:integration`); gated behind
 * `pnpm test:demo:revote` (this config). Requires Docker + the
 * `dvconf-demo-daemons:latest` image.
 *
 * `tests/` sits OUTSIDE the apps/* package graph, so the bare `@dvconf/shared`
 * specifier (used by both the test and the cp-daemon source it imports) is
 * aliased to the package SOURCE here — same approach the Phase 5.4 scripts use.
 *
 * Single stack at a time: forks pool, single fork, no file parallelism, long
 * timeouts to cover `up --wait` (~90s) + ~60s idle waits + scenario drive.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@dvconf/shared': resolve(HERE, 'packages/shared/src/index.ts') },
  },
  test: {
    include: ['tests/demo-scenarios/**/*.test.ts'],
    globals: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    reporters: ['verbose', 'junit'],
    outputFile: { junit: '.evidence/verification/req-rv-015.junit.xml' },
  },
});
