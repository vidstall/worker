// p2-arm-split.ts — deterministic, order-preserving arm/block split of the P2
// pooled raw JSONL (plan: docs/superpowers/plans/
// 2026-07-16-p2-vm-only-cloud-wan-e2ee-window.md, "Run identity and arm
// isolation" — Gate-1 pattern, same family as filter-star-analysis-set.ts).
//
// Routing predicate (the ONLY logic): a line whose parsed context.room_id
// matches /^p2b(\d)(off|on)m?-/ goes to BOTH
//   <out-dir>/p2-arm-<arm>.jsonl            (arm pool, makeups included)
//   <out-dir>/p2-block-<block>-<arm>.jsonl  (arm x block stratum)
// Every other line (canary rooms, historical `wan-*`, malformed JSON, missing
// room_id) goes to <out-dir>/p2-unmatched.jsonl. No mutation, no reordering,
// no dedup — original line bytes, single pass, input order preserved in every
// output. The pooled input stays the raw of record; this only derives views.
//
// Prints a JSON report to stdout: SHA-256 (uppercase hex) + line count of the
// input and of EVERY output file written.
//
// Usage: tsx scripts/bench/p2-arm-split.ts <pooled.jsonl> <out-dir>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Arm/block room-name predicate — single digit block 0-9, optional makeup `m`. */
export const P2_ROOM_RE = /^p2b(\d)(off|on)m?-/;

export interface SplitOutputs {
  /** Relative output filename -> ORIGINAL input lines, input order preserved. */
  files: Map<string, string[]>;
  inputLines: number;
}

/**
 * Pure router. Always emits the three canonical files (p2-arm-off / p2-arm-on /
 * p2-unmatched, possibly empty so a zero-count is explicit in the report);
 * p2-block-<b>-<arm>.jsonl files are emitted only for observed strata.
 */
export function splitP2Lines(raw: string): SplitOutputs {
  const lines = raw.split('\n').filter((l) => l.length > 0);
  const files = new Map<string, string[]>([
    ['p2-arm-off.jsonl', []],
    ['p2-arm-on.jsonl', []],
    ['p2-unmatched.jsonl', []],
  ]);
  const push = (file: string, line: string): void => {
    let bucket = files.get(file);
    if (bucket === undefined) { bucket = []; files.set(file, bucket); }
    bucket.push(line);
  };

  for (const line of lines) {
    let roomId: unknown;
    try {
      const rec = JSON.parse(line) as { context?: { room_id?: unknown } };
      roomId = rec.context?.room_id;
    } catch {
      roomId = undefined; // malformed line -> unmatched (never dropped, never counted as an arm row)
    }
    const m = typeof roomId === 'string' ? P2_ROOM_RE.exec(roomId) : null;
    if (m === null) {
      push('p2-unmatched.jsonl', line);
      continue;
    }
    const block = m[1]!;
    const arm = m[2]!;
    push(`p2-arm-${arm}.jsonl`, line); // ORIGINAL bytes, both views
    push(`p2-block-${block}-${arm}.jsonl`, line);
  }
  return { files, inputLines: lines.length };
}

const sha256Upper = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex').toUpperCase();

function main(): void {
  const input = process.argv[2];
  const outDir = process.argv[3];
  if (input === undefined || outDir === undefined) {
    throw new Error('usage: tsx scripts/bench/p2-arm-split.ts <pooled.jsonl> <out-dir>');
  }

  const rawBuf = readFileSync(input);
  const { files, inputLines } = splitP2Lines(rawBuf.toString('utf8'));

  mkdirSync(outDir, { recursive: true });
  const outputs: Array<{ file: string; lines: number; sha256: string }> = [];
  // Deterministic report order: sort by filename (Map insertion order depends on
  // which stratum appeared first in the input).
  for (const name of [...files.keys()].sort()) {
    const lines = files.get(name)!;
    const body = lines.length > 0 ? `${lines.join('\n')}\n` : '';
    const path = join(outDir, name);
    writeFileSync(path, body);
    outputs.push({ file: name, lines: lines.length, sha256: sha256Upper(Buffer.from(body, 'utf8')) });
  }

  console.log(JSON.stringify({
    input: { path: input, lines: inputLines, sha256: sha256Upper(rawBuf) },
    outDir,
    outputs,
  }, null, 2));
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url)
  || (process.argv[1] !== undefined && (process.argv[1].endsWith('p2-arm-split.ts') || process.argv[1].endsWith('p2-arm-split.js')));
if (isMain) main();
