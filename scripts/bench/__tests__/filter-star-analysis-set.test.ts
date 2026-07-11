/**
 * Unit test for the STAR Lane-A raw -> analysis-set filter — codex R11 SHOULD-IMPROVE #7.
 *
 * Locks three properties the deterministic filter must hold:
 *   (a) the keep predicate (ts >= runStart AND room_id^prefix) keeps/excludes the right rows,
 *   (b) a malformed (non-JSON) line is counted SEPARATELY and does NOT vanish into the
 *       ordinary predicate-exclusion tally, and
 *   (c) importing the module for its exported helpers has NO side effect — the CLI `main()`
 *       runs only under the ESM direct-execution guard, never on import.
 *
 * Provenance: docs/80-research/evaluation/raw/README.md (2876 raw -> 2760 filtered, SHAs).
 */

import { describe, it, expect } from 'vitest';
import { filterAnalysisSet } from '../filter-star-analysis-set.js';

const RUN_START = 1783232707672;
const ROOM_PREFIX = 'wan-';

/** A well-formed JSONL row for the filter (only ts + context.room_id are read). */
function row(ts: number, roomId: string): string {
  return JSON.stringify({ ts, context: { room_id: roomId } });
}

describe('filterAnalysisSet — keep predicate', () => {
  it('keeps a row only when ts >= runStart AND room_id starts with the prefix', () => {
    const raw = [
      row(RUN_START, 'wan-0'),        // keep: ts == runStart (>=), prefix ok
      row(RUN_START + 1000, 'wan-7'), // keep: ts > runStart, prefix ok
      row(RUN_START - 1, 'wan-9'),    // drop: ts before runStart
      row(RUN_START + 5, 'dbg-0'),    // drop: wrong room prefix
    ].join('\n');

    const { lines, kept, excluded, malformed } = filterAnalysisSet(raw, RUN_START, ROOM_PREFIX);

    expect(kept).toBe(2);
    expect(excluded).toBe(2);
    expect(malformed).toBe(0);
    // order-preserving + ORIGINAL bytes retained
    expect(lines).toEqual([row(RUN_START, 'wan-0'), row(RUN_START + 1000, 'wan-7')]);
  });

  it('excludes rows with a missing/non-string room_id or non-number ts (predicate, not malformed)', () => {
    const raw = [
      JSON.stringify({ ts: RUN_START + 1 }),                       // no context.room_id
      JSON.stringify({ ts: String(RUN_START + 1), context: { room_id: 'wan-1' } }), // ts not a number
      row(RUN_START + 1, 'wan-1'),                                 // keep
    ].join('\n');

    const { kept, excluded, malformed } = filterAnalysisSet(raw, RUN_START, ROOM_PREFIX);
    expect(kept).toBe(1);
    expect(excluded).toBe(2);
    expect(malformed).toBe(0);
  });

  it('ignores empty/blank lines (they are not rows, not exclusions)', () => {
    const raw = ['', row(RUN_START + 1, 'wan-1'), '', ''].join('\n');
    const { kept, excluded, malformed } = filterAnalysisSet(raw, RUN_START, ROOM_PREFIX);
    expect(kept).toBe(1);
    expect(excluded).toBe(0);
    expect(malformed).toBe(0);
  });
});

describe('filterAnalysisSet — malformed-line accounting', () => {
  it('counts a non-JSON line as malformed, NOT as a predicate exclusion', () => {
    const raw = [
      row(RUN_START + 1, 'wan-1'),  // keep
      'this-is-not-json',           // malformed
      row(RUN_START - 5, 'wan-2'),  // drop: predicate (ts too early)
    ].join('\n');

    const { kept, excluded, malformed } = filterAnalysisSet(raw, RUN_START, ROOM_PREFIX);

    expect(kept).toBe(1);
    expect(malformed).toBe(1);      // the corrupt line is reported distinctly
    expect(excluded).toBe(1);       // ONLY the genuine predicate drop — malformed does not leak in
  });

  it('does not double-count: kept + excluded + malformed == number of non-blank rows', () => {
    const raw = [
      row(RUN_START + 1, 'wan-1'),  // keep
      row(RUN_START + 2, 'wan-2'),  // keep
      '{bad json',                  // malformed
      'also not json',              // malformed
      row(RUN_START - 1, 'wan-3'),  // predicate drop
    ].join('\n');

    const { lines, kept, excluded, malformed } = filterAnalysisSet(raw, RUN_START, ROOM_PREFIX);
    expect(kept).toBe(2);
    expect(malformed).toBe(2);
    expect(excluded).toBe(1);
    expect(kept + excluded + malformed).toBe(5); // 5 non-blank rows accounted for exactly once
    expect(lines).toHaveLength(2);
  });

  it('reports malformed=0 for the all-clean happy path (byte-identical guarantee unaffected)', () => {
    const raw = [row(RUN_START, 'wan-0'), row(RUN_START + 9, 'wan-9')].join('\n');
    const { malformed, excluded } = filterAnalysisSet(raw, RUN_START, ROOM_PREFIX);
    expect(malformed).toBe(0);
    expect(excluded).toBe(0);
  });
});

describe('module import side-effects (ESM main guard)', () => {
  it('importing the module does not run the CLI main() — this test file loaded it with no output/throw', () => {
    // Reaching this assertion at all proves the top-level `if (isMain) main()` guard held:
    // main() would have called readFileSync(undefined) and thrown during import, failing the
    // whole suite before any test ran. A successful import is the evidence.
    expect(typeof filterAnalysisSet).toBe('function');
  });
});
