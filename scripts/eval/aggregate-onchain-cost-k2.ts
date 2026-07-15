/**
 * Deterministic replay for the actual K=2/N=4 cost run.
 *
 * Run:
 *   pnpm exec tsx scripts/eval/aggregate-onchain-cost-k2.ts <raw.jsonl> [aggregate.txt] [suiUsd]
 *
 * The output is write-once (`wx`). Replaying to an existing path fails closed.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { aggregateK2Session, parseK2Evidence, renderK2Aggregate } from './cost-k2-evidence.ts';
import { sha256Text, writeTextExclusive } from './cost-run-safety.ts';

function main(argv: string[]): void {
  const rawArg = argv[0];
  if (rawArg === undefined || rawArg.startsWith('--')) {
    throw new Error('raw JSONL path is required');
  }
  const rawPath = resolve(rawArg);
  const outputPath = resolve(argv[1] ?? `${rawPath}.aggregate.txt`);
  const suiUsd = Number(argv[2] ?? '1.50');
  const raw = readFileSync(rawPath, 'utf8');
  const parsed = parseK2Evidence(raw);
  const aggregate = aggregateK2Session(parsed.rows);
  const canonical = renderK2Aggregate(parsed, aggregate, rawPath, suiUsd);
  const output = `${canonical}OUTPUT-SHA256: ${sha256Text(canonical)}\n`;
  writeTextExclusive(outputPath, output);
  process.stdout.write(output);
  process.stdout.write(`OUT: ${outputPath}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`aggregate-onchain-cost-k2: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
