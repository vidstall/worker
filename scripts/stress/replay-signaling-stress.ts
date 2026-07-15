/**
 * Replay one signaling-stress JSONL file regardless of its filename.
 *
 * Historical stress files predate the canonical `-<trace-id>.jsonl` suffix,
 * while `scripts/bench/replay.ts` discovers inputs by that suffix. This narrow
 * adapter keeps the same aggregate/CSV implementation and avoids copying or
 * renaming append-only raw evidence.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { aggregateEvents, formatCsv } from '../bench/replay.js';
import type { LatencyEvent } from '../../packages/shared/src/bench/types.js';

const [inputPath, csvFlag, csvPath] = process.argv.slice(2);
if (inputPath === undefined || csvFlag !== '--csv' || csvPath === undefined) {
  throw new Error(
    'Usage: tsx scripts/stress/replay-signaling-stress.ts <input.jsonl> --csv <output.csv>',
  );
}

let malformed = 0;
const events: LatencyEvent[] = [];
for (const line of readFileSync(inputPath, 'utf8').split('\n')) {
  if (line.length === 0) continue;
  try {
    events.push(JSON.parse(line) as LatencyEvent);
  } catch {
    malformed++;
  }
}
if (events.length === 0) throw new Error(`No valid events in ${inputPath}`);

const rows = aggregateEvents(events);
writeFileSync(csvPath, formatCsv(rows), { encoding: 'utf8', flag: 'wx' });
console.table(rows);
console.log(`Replayed ${events.length} events (${malformed} malformed); wrote ${csvPath}`);
