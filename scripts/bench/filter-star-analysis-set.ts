/**
 * filter-star-analysis-set.ts — deterministic raw -> analysis-set transform for the STAR Lane-A run.
 *
 * The captured STAR Lane-A JSONL (`*.raw.jsonl`) contains, in addition to the 30 intended
 * `s-wan` sessions, earlier smoke rows and a `dbg-0` diagnostic session that shared the same
 * trace file. Those are excluded before assembly by a single documented predicate:
 *
 *     keep record  <=>  ts >= RUN_START  AND  context.room_id matches /^<ROOM_PREFIX>/
 *
 * This script is the executable form of that predicate. It is order-preserving and byte-exact:
 * run over `s-wan-client-wan-20260705T060736.raw.jsonl` (2876 records, SHA-256 B62D4BC3..) it
 * reproduces `s-wan-client-wan-20260705T060736.jsonl` (2760 records, SHA-256 38890BE3..) exactly.
 * See docs/80-research/evaluation/raw/README.md for both hashes and the exclusion breakdown.
 *
 * Usage:
 *   pnpm exec tsx scripts/bench/filter-star-analysis-set.ts <input.raw.jsonl> [output.jsonl]
 *     [--run-start <epoch-ms>] [--room-prefix <prefix>]
 * Defaults: --run-start 1783232707672  --room-prefix wan-
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DEFAULT_RUN_START = 1783232707672;
const DEFAULT_ROOM_PREFIX = 'wan-';

function parseArgs(argv: string[]): {
  input: string; output?: string; runStart: number; roomPrefix: string;
} {
  const positional: string[] = [];
  let runStart = DEFAULT_RUN_START;
  let roomPrefix = DEFAULT_ROOM_PREFIX;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--run-start') { runStart = Number(argv[++i]); }
    else if (a === '--room-prefix') { roomPrefix = String(argv[++i]); }
    else { positional.push(a); }
  }
  const input = positional[0];
  if (input === undefined) {
    throw new Error('usage: filter-star-analysis-set.ts <input.raw.jsonl> [output.jsonl] [--run-start ms] [--room-prefix p]');
  }
  return { input, output: positional[1], runStart, roomPrefix };
}

export function filterAnalysisSet(raw: string, runStart: number, roomPrefix: string): {
  lines: string[]; kept: number; excluded: number;
} {
  const rows = raw.split('\n').filter((l) => l.length > 0);
  const lines: string[] = [];
  for (const line of rows) {
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; } // malformed -> excluded
    const rec = o as { ts?: unknown; context?: { room_id?: unknown } };
    const ts = rec.ts;
    const roomId = rec.context?.room_id;
    const keep =
      typeof ts === 'number' && ts >= runStart &&
      typeof roomId === 'string' && roomId.startsWith(roomPrefix);
    if (keep) lines.push(line); // keep the ORIGINAL bytes, order-preserving
  }
  return { lines, kept: lines.length, excluded: rows.length - lines.length };
}

function main(): void {
  const { input, output, runStart, roomPrefix } = parseArgs(process.argv.slice(2));
  const raw = readFileSync(input, 'utf8');
  const { lines, kept, excluded } = filterAnalysisSet(raw, runStart, roomPrefix);
  const body = lines.join('\n') + '\n'; // trailing newline, matching the captured file
  const sha = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex').toUpperCase();
  if (output !== undefined) writeFileSync(output, body);
  process.stderr.write(
    `filter-star-analysis-set: kept=${kept} excluded=${excluded} ` +
    `(predicate: ts>=${runStart} AND room_id^${roomPrefix}) output-sha256=${sha}\n`,
  );
  if (output === undefined) process.stdout.write(body);
}

// Run only when invoked directly (not when imported for tests).
main();
