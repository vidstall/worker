/**
 * P17 M1 / F63 (DOH-001/003/004) — shared cross-daemon trace primitive.
 *
 * One source for the `x-trace-id` header name + honor-or-generate read +
 * outbound injection + pino child binding, so the 5 cross-daemon edges and the
 * 4 daemons cannot drift on header spelling or the log field name.
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import {
  genTraceId,
  TRACE_HEADER,
  readTraceId,
  withTraceHeader,
  traceChild,
} from '../trace.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('trace primitive', () => {
  it('genTraceId returns a unique UUID v4', () => {
    const a = genTraceId();
    const b = genTraceId();
    expect(a).toMatch(UUID_V4);
    expect(a).not.toBe(b);
  });

  it('TRACE_HEADER is the canonical x-trace-id', () => {
    expect(TRACE_HEADER).toBe('x-trace-id');
  });

  it('readTraceId honors an inbound id', () => {
    const id = genTraceId();
    expect(readTraceId({ 'x-trace-id': id })).toBe(id);
  });

  it('readTraceId generates a fresh id when the header is absent', () => {
    const got = readTraceId({});
    expect(got).toMatch(UUID_V4);
  });

  it('readTraceId takes the first value when the header arrives as an array', () => {
    const id = genTraceId();
    expect(readTraceId({ 'x-trace-id': [id, 'other'] })).toBe(id);
  });

  it('withTraceHeader injects x-trace-id and preserves existing headers', () => {
    const id = genTraceId();
    const out = withTraceHeader({ authorization: 'Bearer xyz' }, id);
    expect(out['x-trace-id']).toBe(id);
    expect(out.authorization).toBe('Bearer xyz');
  });

  it('traceChild binds trace_id on the emitted log line', () => {
    const lines: Array<Record<string, unknown>> = [];
    const stream = { write: (s: string) => lines.push(JSON.parse(s)) };
    const base = pino({ level: 'info' }, stream);
    const id = genTraceId();

    traceChild(base, id).info('hello');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['trace_id']).toBe(id);
  });
});
