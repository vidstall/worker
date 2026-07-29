/**
 * Deterministic replay for P3 localnet submit-to-event latency evidence.
 *
 * Run:
 *   pnpm exec tsx scripts/eval/replay-chain-latency.ts <run-directory> [summary.json] [pushgatewayUrl]
 *
 * The complete evidence bundle is validated before the canonical, write-once
 * (`wx`) summary is emitted. The optional 3rd arg (plus PUSHGATEWAY_TOKEN env
 * var) pushes L_chain_create/L_chain_settle's submit_to_event_ms p50/p95/p99
 * to the observer host's Pushgateway (see packages/shared/src/metrics-prom.ts's
 * pushToGateway()) for the "Blockchain & Consensus" row of the
 * xaisen-academic-eval Grafana dashboard -- additive to (never a replacement
 * for) the canonical JSON summary, which stays the evidence artifact.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CHAIN_LATENCY_BUNDLE_FILES,
  renderCanonicalChainLatencySummary,
  summarizeChainLatencyEvidence,
  validateChainLatencyBundle,
  type ChainLatencyBundleTexts,
  type ChainLatencySummary,
} from './chain-latency-evidence.ts';
import { writeTextExclusive } from './cost-run-safety.ts';
import { pushToGateway } from '@dvconf/shared';

async function pushLatencySummary(summary: ChainLatencySummary, pushgatewayUrl: string): Promise<void> {
  const metrics: { name: string; help: string; value: number; labels: Record<string, string> }[] = [];
  for (const [metricName, metricSummary] of Object.entries(summary.metrics)) {
    const dist = metricSummary.submit_to_event_ms;
    for (const [pct, value] of [
      ['p50', dist.p50],
      ['p95', dist.p95],
      ['p99', dist.p99],
    ] as const) {
      metrics.push({
        name: 'dvconf_chain_finality_ms',
        help: 'submit-to-event on-chain finality latency (ms) -- see scripts/eval/measure-chain-latency.ts',
        value,
        labels: { event: metricName, pct },
      });
    }
  }
  await pushToGateway({
    baseUrl: pushgatewayUrl,
    job: 'xaisen_chain_latency',
    instance: summary.provenance.run_id,
    token: process.env['PUSHGATEWAY_TOKEN'],
    metrics,
  });
}

async function main(argv: string[]): Promise<void> {
  const runArg = argv[0];
  if (runArg === undefined || runArg.startsWith('--')) {
    throw new Error('run directory is required');
  }
  if (argv.length > 3) throw new Error('expected <run-directory> [summary.json] [pushgatewayUrl]');

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
  const summary = summarizeChainLatencyEvidence(bundle.evidence);
  const output = renderCanonicalChainLatencySummary(summary);
  writeTextExclusive(outputPath, output);
  process.stdout.write(output);
  process.stdout.write(`OUT: ${outputPath}\n`);

  const pushgatewayUrl = argv[2];
  if (pushgatewayUrl) {
    await pushLatencySummary(summary, pushgatewayUrl);
    process.stdout.write(`pushed L_chain_create/L_chain_settle p50/p95/p99 to ${pushgatewayUrl}\n`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(
    `replay-chain-latency: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exit(1);
});
