/**
 * REQ-CFA-010 — canary integration suite ISOLATION + teardown-hygiene GUARD.
 *
 * HERMETIC (no mediasoup / no localnet boot): this is a plain unit test that runs
 * under `pnpm test`. It statically asserts the vitest config topology that keeps
 * the canary integration suite isolated from the three heavy relay benches:
 *
 *   - vitest.canary.config.ts          (NEW)  — narrow include for canary-*.integration only
 *   - vitest.relay-integration.config.ts (mod) — now EXCLUDES the canary tests
 *
 * It loads BOTH config modules and asserts:
 *   (a) the canary config's include globs MATCH the two canary integration tests
 *       (relay canary-forward + validator-daemon canary-slash-e2e) and do NOT match
 *       any of the 3 heavy benches.
 *   (b) vitest.relay-integration.config.ts now EXCLUDES the canary tests while still
 *       INCLUDING the 3 heavy benches (so the heavy-bench run no longer sweeps in canary).
 *   (c) the canary config sets pool:'forks', singleFork:true, fileParallelism:false
 *       (isolation discipline — mirrors the bench configs) and a sane timeout.
 *   (d) teardown hygiene: the canary config carries the same singleFork / no-parallelism
 *       guarantees as the bench configs (one heavy fixture at a time, no cross-suite
 *       worker leakage). Asserted STATICALLY — a runtime open-handle check would require
 *       booting mediasoup, which belongs in the canary integration suite itself.
 *
 * The config modules live at the daemons ROOT (outside this package's `rootDir:src`),
 * so they are loaded with a RUNTIME dynamic `import()` (specifier built at runtime)
 * rather than a static `import` — this keeps tsc clean (no TS5097 `.ts`-extension /
 * TS6059 cross-rootDir errors that a static cross-root import would introduce).
 *
 * INV-B (content-blind): this guard touches ZERO relay production source. It only
 * reads config module shape. The relay PRODUCTION forward path
 * (room-handler.ts `createConsumer` → `recvTransport.consume`) is untouched.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// ── vitest config shape (only the fields this guard inspects) ───────────────────
interface VitestTestShape {
  include?: string[];
  exclude?: string[];
  pool?: string;
  poolOptions?: { forks?: { singleFork?: boolean } };
  fileParallelism?: boolean;
  testTimeout?: number;
  hookTimeout?: number;
}
interface VitestConfigShape {
  test?: VitestTestShape;
}

// Root-relative-to-this-file specifiers, assembled at RUNTIME so tsc does not try to
// statically resolve a cross-rootDir `.ts` config (vitest/vite transpiles the import).
const ROOT = '../../../../';
async function loadConfig(name: string): Promise<VitestConfigShape> {
  const mod: { default: VitestConfigShape } = await import(/* @vite-ignore */ ROOT + name);
  return mod.default;
}

// ── tiny self-contained glob matcher (hermetic — no glob dependency) ────────────
// Supports the subset used by these vitest configs: leading/mid `**/` (any path
// segments incl. none + slashes), `*` (any chars except `/`), and literal text.
// Anchored full-match. NOTE: a TRAILING `**` dir-glob (e.g. `.../integration/**`)
// is NOT faithfully matched — but every glob these configs feed it ends in a file
// literal (`*.integration.test.ts`), so it is sound here. Do NOT reuse this matcher
// for dir-globs (e.g. vitest.config.ts's dir excludes) — it would silently under-match.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` (optionally followed by `/`) → match any path span including separators
        i++;
        if (glob[i + 1] === '/') i++;
        re += '(?:.*/)?';
      } else {
        re += '[^/]*';
      }
    } else if ('\\^$+?.()|[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchesAny(globs: readonly string[], path: string): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}

// ── sample paths (the actual on-disk test files, repo-relative POSIX) ────────────
const CANARY_RELAY = 'apps/relay/src/__tests__/integration/canary-forward.integration.test.ts';
const CANARY_VALIDATOR =
  'apps/validator-daemon/src/__tests__/integration/canary-slash-e2e.integration.test.ts';
const HEAVY_BENCHES = [
  'apps/relay/src/__tests__/integration/bandwidth-scale-bench.integration.test.ts',
  'apps/relay/src/__tests__/integration/relay-blind-realsframe.integration.test.ts',
  'apps/relay/src/__tests__/integration/relay-overlap-mttr.integration.test.ts',
  'apps/relay/src/__tests__/integration/relay-overlap-m2-bench.integration.test.ts',
] as const;

let canaryConfig: VitestConfigShape;
let relayIntegrationConfig: VitestConfigShape;

beforeAll(async () => {
  // RED: vitest.canary.config.ts does not exist yet → this rejects and the suite fails.
  canaryConfig = await loadConfig('vitest.canary.config.ts');
  relayIntegrationConfig = await loadConfig('vitest.relay-integration.config.ts');
});

describe('REQ-CFA-010 — canary suite isolation (config topology) + teardown hygiene', () => {
  it('self-check: the glob matcher handles **, *, and literals correctly', () => {
    expect(matchesAny(['**/integration/canary-*.integration.test.ts'], CANARY_RELAY)).toBe(true);
    expect(matchesAny(['**/integration/canary-*.integration.test.ts'], HEAVY_BENCHES[0])).toBe(
      false,
    );
    // `**` matches zero segments too
    expect(matchesAny(['**/apps/relay/**/foo.ts'], 'apps/relay/foo.ts')).toBe(true);
  });

  // ── (a) the NEW canary config matches BOTH canary integration tests, NO benches ──
  describe('(a) vitest.canary.config.ts include globs', () => {
    it('matches the relay canary-forward integration test', () => {
      expect(matchesAny(canaryConfig.test?.include ?? [], CANARY_RELAY)).toBe(true);
    });

    it('matches the validator-daemon canary-slash-e2e integration test', () => {
      expect(matchesAny(canaryConfig.test?.include ?? [], CANARY_VALIDATOR)).toBe(true);
    });

    it('does NOT match ANY of the 3+ heavy relay benches', () => {
      const include = canaryConfig.test?.include ?? [];
      for (const bench of HEAVY_BENCHES) {
        expect(matchesAny(include, bench)).toBe(false);
      }
    });
  });

  // ── (b) relay-integration config now EXCLUDES canary, still INCLUDES the benches ──
  describe('(b) vitest.relay-integration.config.ts excludes canary, keeps benches', () => {
    it('still INCLUDES the 3+ heavy benches', () => {
      const include = relayIntegrationConfig.test?.include ?? [];
      for (const bench of HEAVY_BENCHES) {
        expect(matchesAny(include, bench)).toBe(true);
      }
    });

    it('EXCLUDES the relay canary-forward test (no longer swept into the heavy-bench run)', () => {
      const include = relayIntegrationConfig.test?.include ?? [];
      const exclude = relayIntegrationConfig.test?.exclude ?? [];
      // The canary test is matched by the broad include glob...
      expect(matchesAny(include, CANARY_RELAY)).toBe(true);
      // ...but is now actively excluded.
      expect(matchesAny(exclude, CANARY_RELAY)).toBe(true);
    });

    it('does NOT exclude any of the heavy benches (they must still run here)', () => {
      const exclude = relayIntegrationConfig.test?.exclude ?? [];
      for (const bench of HEAVY_BENCHES) {
        expect(matchesAny(exclude, bench)).toBe(false);
      }
    });
  });

  // ── (c) canary config isolation discipline (forks / singleFork / no parallelism) ──
  describe('(c) vitest.canary.config.ts isolation discipline', () => {
    it("uses pool:'forks'", () => {
      expect(canaryConfig.test?.pool).toBe('forks');
    });

    it('uses singleFork:true (one heavy fixture at a time)', () => {
      expect(canaryConfig.test?.poolOptions?.forks?.singleFork).toBe(true);
    });

    it('disables file parallelism', () => {
      expect(canaryConfig.test?.fileParallelism).toBe(false);
    });

    it('sets a sane (generous) timeout for mediasoup + localnet boot (>= 30s)', () => {
      expect(canaryConfig.test?.testTimeout ?? 0).toBeGreaterThanOrEqual(30_000);
      expect(canaryConfig.test?.hookTimeout ?? 0).toBeGreaterThanOrEqual(30_000);
    });
  });

  // ── (d) teardown hygiene: same single-fork / no-parallelism guarantees as benches ──
  describe('(d) teardown hygiene — no cross-suite leakage', () => {
    it('canary config mirrors the bench single-fork guarantee (no worker reuse across suites)', () => {
      const canary = canaryConfig.test ?? {};
      const relayInt = relayIntegrationConfig.test ?? {};
      expect(canary.poolOptions?.forks?.singleFork).toBe(true);
      expect(canary.fileParallelism).toBe(false);
      // matches the heavy-bench config discipline it was split out from
      expect(canary.pool).toBe(relayInt.pool);
      expect(canary.poolOptions?.forks?.singleFork).toBe(relayInt.poolOptions?.forks?.singleFork);
      expect(canary.fileParallelism).toBe(relayInt.fileParallelism);
    });

    it('canary config does not co-run benches (mediasoup workers never share a fork with a bench)', () => {
      const include = canaryConfig.test?.include ?? [];
      // No heavy bench is reachable from the canary config → no shared-fork leakage.
      for (const bench of HEAVY_BENCHES) {
        expect(matchesAny(include, bench)).toBe(false);
      }
    });
  });
});
