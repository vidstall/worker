import { describe, it, expect, vi } from 'vitest';
import { parseLoadFeed, fetchAttestedLoad, type AttestedLoad } from '../coverage-load-reader.js';

const mockLogger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) as never;

describe('REQ-RMS-005 parseLoadFeed — turn the loopback /canary/load JSON into a per-relay map', () => {
  it('maps relays[] to a Map keyed by minerId', () => {
    const json = {
      service: 'validator-daemon',
      reporterMinerId: '0xrep',
      relays: [
        { relayMinerId: '0xA', attestedLoadPaths: 120, heartbeatFreshEpochs: 1 },
        { relayMinerId: '0xB', attestedLoadPaths: 40, heartbeatFreshEpochs: 5 },
      ],
      ts: 123,
    };
    const m = parseLoadFeed(json);
    expect(m.get('0xA')).toEqual<AttestedLoad>({ attestedLoadPaths: 120, heartbeatFreshEpochs: 1 });
    expect(m.get('0xB')?.attestedLoadPaths).toBe(40);
  });
  it('a malformed/empty payload yields an empty map (fail-open to deferral, never a throw)', () => {
    expect(parseLoadFeed(null).size).toBe(0);
    expect(parseLoadFeed({ relays: 'nope' } as unknown).size).toBe(0);
  });
});

describe('REQ-RMS-022 (D1) fetchAttestedLoad — bounded fetch + fail-open', () => {
  it('bounds the feed fetch with an AbortSignal timeout (no unbounded hang on a wedged loopback)', async () => {
    const calls: Array<{ url: unknown; init?: { signal?: unknown } }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: { signal?: unknown }) => {
        calls.push({ url, init });
        return { ok: true, json: async () => ({ relays: [] }) };
      }),
    );
    await fetchAttestedLoad('http://127.0.0.1:8102/canary/load', mockLogger());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    vi.unstubAllGlobals();
  });

  it('a fetch that throws (e.g. the timeout aborts) fail-opens to an empty map — admission defers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      }),
    );
    const m = await fetchAttestedLoad('http://x', mockLogger());
    expect(m.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
