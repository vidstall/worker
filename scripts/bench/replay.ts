/**
 * Bench latency replay aggregator — S23.2.B1.
 *
 * Reads `bench-output/*-<trace_id>.jsonl` (one file per daemon-source per
 * scenario run), groups events by (metric, source), and emits a per-group
 * summary with `n`, `p50`, `p95`, `p99`, `mean`, `min`, `max`. Groups with
 * `n < 5` surface as `INSUFFICIENT_SAMPLES` (percentiles null, mean/min/max
 * still populated) — see plan CI-3.
 *
 * Percentile method is **nearest-rank** (`rank = ceil(p * n)`) — same family as
 * Prometheus `histogram_quantile` for small `n`, no interpolation, conservative.
 *
 * CLI:
 *   pnpm bench:replay <trace-id> [--csv <path>] [--output-dir <dir>]
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.B1
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §5
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  LatencyEvent,
  LatencyMetric,
  LatencySource,
} from '../../packages/shared/src/index.js';

/** Below this sample count, percentiles are reported as null + tagged. */
export const INSUFFICIENT_SAMPLES_THRESHOLD = 5;

export interface AggregateRow {
  metric: LatencyMetric;
  source: LatencySource;
  n: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number;
  min: number;
  max: number;
  note: 'INSUFFICIENT_SAMPLES' | null;
}

/**
 * Nearest-rank percentile on a pre-sorted ascending array.
 * Caller MUST sort ascending first.
 */
export function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length);
  // Caller is responsible for non-empty input — empty sorted[] would land here
  // with rank=0, which is fine for the only call site (n >= 5 guard).
  return sorted[rank - 1]!;
}

export function aggregateEvents(events: LatencyEvent[]): AggregateRow[] {
  const buckets = new Map<
    string,
    { metric: LatencyMetric; source: LatencySource; values: number[] }
  >();
  for (const e of events) {
    const key = `${e.metric}|${e.source}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { metric: e.metric, source: e.source, values: [] };
      buckets.set(key, bucket);
    }
    bucket.values.push(e.value_ms);
  }

  const rows: AggregateRow[] = [];
  for (const { metric, source, values } of buckets.values()) {
    values.sort((a, b) => a - b);
    const n = values.length;
    const min = values[0]!;
    const max = values[n - 1]!;
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    if (n < INSUFFICIENT_SAMPLES_THRESHOLD) {
      rows.push({
        metric,
        source,
        n,
        p50: null,
        p95: null,
        p99: null,
        mean,
        min,
        max,
        note: 'INSUFFICIENT_SAMPLES',
      });
    } else {
      rows.push({
        metric,
        source,
        n,
        p50: percentile(values, 0.5),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        mean,
        min,
        max,
        note: null,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.metric !== b.metric) return a.metric.localeCompare(b.metric);
    return a.source.localeCompare(b.source);
  });
  return rows;
}

/**
 * Scan an output directory for files whose name ends with `-<traceId>.jsonl`,
 * parse each line as a {@link LatencyEvent}, return the union.
 *
 * Returns `[]` instead of throwing when the directory doesn't exist — the CLI
 * surfaces a friendlier error than a stack trace.
 */
export function loadTrace(outputDir: string, traceId: string): LatencyEvent[] {
  const suffix = `-${traceId}.jsonl`;
  let entries: string[];
  try {
    entries = readdirSync(outputDir).filter((f) => f.endsWith(suffix));
  } catch {
    return [];
  }
  const events: LatencyEvent[] = [];
  for (const name of entries) {
    const content = readFileSync(join(outputDir, name), 'utf8');
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        events.push(JSON.parse(line) as LatencyEvent);
      } catch {
        // skip malformed lines (could be partial writes during a crash)
      }
    }
  }
  return events;
}

const CSV_HEADER = 'metric,source,n,p50,p95,p99,mean,min,max,note';

function fmtNum(v: number | null): string {
  if (v === null) return '';
  return v.toFixed(2);
}

export function formatCsv(rows: AggregateRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        r.metric,
        r.source,
        r.n,
        fmtNum(r.p50),
        fmtNum(r.p95),
        fmtNum(r.p99),
        fmtNum(r.mean),
        fmtNum(r.min),
        fmtNum(r.max),
        r.note ?? '',
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

function printTable(rows: AggregateRow[]): void {
  console.table(
    rows.map((r) => ({
      metric: r.metric,
      source: r.source,
      n: r.n,
      p50: fmtNum(r.p50),
      p95: fmtNum(r.p95),
      p99: fmtNum(r.p99),
      mean: fmtNum(r.mean),
      min: fmtNum(r.min),
      max: fmtNum(r.max),
      note: r.note ?? '',
    })),
  );
}

export interface CliArgs {
  traceId: string;
  csvPath: string | null;
  outputDir: string;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args = argv.slice(2);
  let traceId: string | null = null;
  let csvPath: string | null = null;
  let outputDir = 'bench-output';
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--csv') {
      csvPath = args[++i] ?? null;
    } else if (a === '--output-dir') {
      outputDir = args[++i] ?? 'bench-output';
    } else if (!a.startsWith('-')) {
      traceId = a;
    }
  }
  if (traceId === null) {
    throw new Error(
      'Usage: tsx scripts/bench/replay.ts <trace-id> [--csv <path>] [--output-dir <dir>]',
    );
  }
  return { traceId, csvPath, outputDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const events = loadTrace(args.outputDir, args.traceId);
  if (events.length === 0) {
    console.error(
      `No events found for trace ${args.traceId} in ${args.outputDir}`,
    );
    process.exit(1);
  }
  const rows = aggregateEvents(events);
  printTable(rows);
  if (args.csvPath !== null) {
    writeFileSync(args.csvPath, formatCsv(rows));
    console.log(`Wrote CSV to ${args.csvPath}`);
  }
}

const isMain =
  process.argv[1]?.endsWith('replay.ts') === true ||
  process.argv[1]?.endsWith('replay.js') === true;

if (isMain) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
