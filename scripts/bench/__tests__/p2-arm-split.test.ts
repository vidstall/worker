import { describe, it, expect } from 'vitest';
import { splitP2Lines, P2_ROOM_RE } from '../p2-arm-split';

// Build a raw JSONL line whose ONLY analysis-relevant field is context.room_id.
// A distinct `k` marker makes byte-level order assertions unambiguous.
const row = (room: string, k: number): string =>
  JSON.stringify({
    schema_version: '1.0', ts: 1000 + k, trace_id: 'p2wan-test', scenario: 's-wan',
    source: 'client', instance: 'produce-0', metric: 'L_encode', value_ms: k,
    context: { room_id: room, flow_id: `f-${k}`, direction: 'send', peer_id: 'produce-0' },
  });

describe('P2_ROOM_RE room taxonomy', () => {
  it('matches main and makeup rooms, capturing block + arm', () => {
    expect(P2_ROOM_RE.exec('p2b0off-3')?.slice(1, 3)).toEqual(['0', 'off']);
    expect(P2_ROOM_RE.exec('p2b4on-1')?.slice(1, 3)).toEqual(['4', 'on']);
    expect(P2_ROOM_RE.exec('p2b3onm-0')?.slice(1, 3)).toEqual(['3', 'on']);
    expect(P2_ROOM_RE.exec('p2b5offm-1')?.slice(1, 3)).toEqual(['5', 'off']);
  });

  it('rejects historical wan-* rooms, canaries, and lookalikes', () => {
    expect(P2_ROOM_RE.test('wan-3')).toBe(false);
    expect(P2_ROOM_RE.test('canary-1')).toBe(false);
    expect(P2_ROOM_RE.test('p2b12off-0')).toBe(false); // two-digit block is NOT in the taxonomy
    expect(P2_ROOM_RE.test('p2b0offx-0')).toBe(false);
    expect(P2_ROOM_RE.test('xp2b0off-0')).toBe(false); // anchored at start
  });
});

describe('splitP2Lines routing', () => {
  const lines = [
    row('p2b0off-0', 0),
    row('wan-3', 1), // historical room -> unmatched
    row('p2b0on-1', 2),
    row('p2b0off-2', 3), // second off row — order check inside p2-arm-off
    row('p2b3onm-0', 4), // MAKEUP -> block 3, arm on
    row('canary-1', 5), // canary -> unmatched
    'this is not json {', // malformed -> unmatched, never dropped
    JSON.stringify({ ts: 6, context: {} }), // missing room_id -> unmatched
  ];
  const raw = `${lines.join('\n')}\n`;
  const { files, inputLines } = splitP2Lines(raw);

  it('counts every input line exactly once (partition, no dedup, no drops)', () => {
    expect(inputLines).toBe(8);
    const total = [...files.keys()]
      .filter((f) => f.startsWith('p2-arm-') || f === 'p2-unmatched.jsonl')
      .reduce((n, f) => n + files.get(f)!.length, 0);
    expect(total).toBe(8); // arm files + unmatched partition the input; block files are views of the arm rows
  });

  it('routes by room prefix into arm pools, makeups included', () => {
    expect(files.get('p2-arm-off.jsonl')).toEqual([lines[0], lines[3]]);
    expect(files.get('p2-arm-on.jsonl')).toEqual([lines[2], lines[4]]);
  });

  it('routes the same rows into per-block views: p2b3onm-0 -> block 3 arm on', () => {
    expect(files.get('p2-block-0-off.jsonl')).toEqual([lines[0], lines[3]]);
    expect(files.get('p2-block-0-on.jsonl')).toEqual([lines[2]]);
    expect(files.get('p2-block-3-on.jsonl')).toEqual([lines[4]]);
    expect(files.has('p2-block-3-off.jsonl')).toBe(false); // unobserved stratum -> no file
  });

  it('sends wan-*, canary, malformed, and roomless lines to p2-unmatched.jsonl in input order', () => {
    expect(files.get('p2-unmatched.jsonl')).toEqual([lines[1], lines[5], lines[6], lines[7]]);
  });

  it('preserves original bytes and input order within every output', () => {
    // p2-arm-off rows must be the ORIGINAL strings, in input order (0 before 3).
    const off = files.get('p2-arm-off.jsonl')!;
    expect(off[0]).toBe(lines[0]);
    expect(off[1]).toBe(lines[3]);
    expect(raw.indexOf(off[0]!)).toBeLessThan(raw.indexOf(off[1]!));
  });

  it('always emits the three canonical files, even when empty', () => {
    const empty = splitP2Lines('');
    expect([...empty.files.keys()].sort()).toEqual(['p2-arm-off.jsonl', 'p2-arm-on.jsonl', 'p2-unmatched.jsonl']);
    expect(empty.files.get('p2-arm-off.jsonl')).toEqual([]);
    expect(empty.inputLines).toBe(0);
  });

  it('is deterministic: same input -> same routing', () => {
    const again = splitP2Lines(raw);
    expect([...again.files.entries()]).toEqual([...files.entries()]);
  });
});
