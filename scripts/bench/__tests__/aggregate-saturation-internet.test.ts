import { describe, it, expect } from 'vitest';
import { aggregate } from '../aggregate-saturation-internet';
import { validateCurated } from '../saturation-internet.schema';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('./fixtures/rms-internet-sample.jsonl', import.meta.url), 'utf8');

describe('aggregate-saturation-internet', () => {
  it('produces a schema-valid curated artifact from raw jsonl', () => {
    const curated = aggregate(raw, { runId: 'demo', benchCommit: 'abc123' });
    expect(validateCurated(curated)).toEqual([]);           // no violations
    expect(curated.rungs.length).toBe(3);                   // 5/10/15
    expect(curated.rungs[0].mbpsPerViewer).toBeCloseTo(curated.rungs[0].egressMbpsReal / curated.rungs[0].n);
    expect(curated.dropRelay.relaysAfter).toBeGreaterThanOrEqual(2);
    expect(curated.twoCeiling.cWorkerSrtp).toBeLessThanOrEqual(540);
    expect(curated.honesty.length).toBeGreaterThan(0);
  });

  it('validateCurated rejects an empty honesty block', () => {
    const curated = aggregate(raw, { runId: 'demo', benchCommit: 'abc123' });
    expect(validateCurated({ ...curated, honesty: [] })).toContain('honesty[] must be non-empty');
  });
});
