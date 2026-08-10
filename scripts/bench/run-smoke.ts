/**
 * Bench smoke bring-up — S25 (TS replacement for run-local.ps1 + run-e2e-tests.ps1
 * on the bench critical path).
 *
 * Pure cross-platform Node orchestrator that brings the DVConf stack up against
 * a fresh Sui localnet, drives the existing 2/4-peer mediasoup harness, and tears
 * everything down. Replaces the PowerShell + python3 pipe pattern that surfaced
 * the PS-5.1 NativeCommandError class blocking S23.3.
 *
 * Module layout:
 *
 *   ── Pure helpers (vitest-covered, S25.A) — scripts/bench/smoke/parsers.ts ──
 *   - parsePublishJson(json)               — extract 6 identities from sui test-publish
 *   - parseSharedObjectFromCreate(json, s) — extract shared ID from module::create
 *   - buildEnvContent(ids, keys, extras)   — format dvconf-daemons/.env
 *   - waitForPort(host, port, timeoutMs)   — TCP poll
 *
 *   ── Sui node lifecycle — scripts/bench/smoke/sui-node.ts ──
 *   - spawnSuiNode / waitForSuiRpc / setupSuiClient / publishPackage / loadActiveSigner
 *
 *   ── On-chain bench fixtures — scripts/bench/smoke/fixtures.ts ──
 *   - bringUpBench / createBenchRoom / runBenchScenario
 *
 *   ── Daemon lifecycle — scripts/bench/smoke/daemons.ts ──
 *   - spawnAllDaemons / waitForDaemonReady / teardownDaemons
 *
 *   ── Orchestrator (S25.B/C, integration-tested manually) ──
 *   - main()                               — full bring-up + drive + teardown
 *
 * Plan: docs/00-meta/progress.md § Session 25 (TS bench bring-up)
 * Hook:  pnpm bench:smoke (added in S25.D)
 */

import { DAEMONS_DIR, LOGS_DIR } from './smoke/sui-node.ts';
import { bringUpBench, ensureUserRegistered, createBenchRoom, runBenchScenario } from './smoke/fixtures.ts';
import { spawnAllDaemons, teardownDaemons } from './smoke/daemons.ts';

// Re-export every symbol the original single-file module exported, so
// existing imports of `run-smoke.ts` (e.g. the vitest suite) keep working
// unchanged. Note: sui-node.ts / daemons.ts / fixtures.ts additionally expose
// a few module-internal helpers (e.g. path constants, `runCli`) needed only
// for wiring between the split files — those were never part of the
// original file's public surface, so they're re-exported by name below
// rather than via a blanket `export *` on every module.
export * from './smoke/parsers.ts';
export type { SuiNodeHandle } from './smoke/sui-node.ts';
export {
  spawnSuiNode,
  waitForSuiRpc,
  setupSuiClient,
  publishPackage,
  loadActiveSigner,
} from './smoke/sui-node.ts';
export * from './smoke/fixtures.ts';
export * from './smoke/daemons.ts';

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const reuseRunning = process.argv.includes('--reuse-running');
  const bringupOnly = process.argv.includes('--bringup-only');
  const daemonsOnly = process.argv.includes('--daemons-only');
  const peers = pickIntArg('--peers', 4);
  const runs = pickIntArg('--runs', 5);
  const durationSec = pickIntArg('--duration', 60);

  const result = await bringUpBench({ reuseRunning });
  console.log('[bench] bring-up complete');
  if (bringupOnly) {
    console.log('[bench] --bringup-only set; leaving sui node running');
    return;
  }

  const daemonHandles = await spawnAllDaemons(DAEMONS_DIR, LOGS_DIR);
  console.log(`[bench] all ${daemonHandles.length} daemons ready`);

  if (daemonsOnly) {
    console.log(
      '[bench] --daemons-only set; leaving daemons + sui running. SIGINT to clean up.',
    );
    return;
  }

  try {
    await ensureUserRegistered(result.client, result.deployer, result.ids);
    const roomId = await createBenchRoom(
      result.client,
      result.deployer,
      result.ids,
    );
    await runBenchScenario({
      daemonsDir: DAEMONS_DIR,
      roomId,
      peers,
      runs,
      durationSec,
    });
  } finally {
    await teardownDaemons(daemonHandles);
    if (!reuseRunning) {
      await result.sui.stop();
    }
  }
}

/** Read an integer CLI flag like `--peers 4` from argv, or fall back. */
function pickIntArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  const n = parseInt(process.argv[idx + 1]!, 10);
  return Number.isFinite(n) ? n : fallback;
}

const isMain =
  process.argv[1]?.endsWith('run-smoke.ts') === true ||
  process.argv[1]?.endsWith('run-smoke.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
