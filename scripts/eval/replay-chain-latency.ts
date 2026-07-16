/**
 * Deterministic replay for P3 localnet submit-to-event latency evidence.
 *
 * Run:
 *   pnpm exec tsx scripts/eval/replay-chain-latency.ts <run-directory> [summary.json]
 *
 * The complete evidence bundle is validated before the canonical, write-once
 * (`wx`) summary is emitted.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHAIN_LATENCY_BUNDLE_FILES,
  renderCanonicalChainLatencySummary,
  summarizeChainLatencyEvidence,
  validateChainLatencyBundle,
  type ChainLatencyBundleTexts,
} from './chain-latency-evidence.ts';
import { writeTextExclusive } from './cost-run-safety.ts';

function main(argv: string[]): void {
  const runArg = argv[0];
  if (runArg === undefined || runArg.startsWith('--')) {
    throw new Error('run directory is required');
  }
  if (argv.length > 2) throw new Error('expected <run-directory> [summary.json]');

  const runDir = resolve(runArg);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) {
    throw new Error(`run directory does not exist or is not a directory: ${runDir}`);
  }
  const failurePath = resolve(runDir, 'failure.json');
  if (existsSync(failurePath)) {
    throw new Error(`refusing failed evidence bundle because failure.json exists: ${failurePath}`);
  }

  const files = {} as ChainLatencyBundleTexts;
  for (const artifact of CHAIN_LATENCY_BUNDLE_FILES) {
    const artifactPath = resolve(runDir, artifact);
    if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
      throw new Error(`required evidence artifact is missing or not a file: ${artifactPath}`);
    }
    files[artifact] = readFileSync(artifactPath, 'utf8');
  }

  const outputPath = resolve(argv[1] ?? resolve(runDir, 'chain-latency-summary.json'));
  if (!outputPath.toLowerCase().endsWith('.json')) {
    throw new Error(`summary output must end in .json: ${outputPath}`);
  }

  const bundle = validateChainLatencyBundle(files);
  const output = renderCanonicalChainLatencySummary(summarizeChainLatencyEvidence(bundle.evidence));
  writeTextExclusive(outputPath, output);
  process.stdout.write(output);
  process.stdout.write(`OUT: ${outputPath}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `replay-chain-latency: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
}
