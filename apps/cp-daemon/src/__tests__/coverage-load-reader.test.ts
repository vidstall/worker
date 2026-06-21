import { describe, it, expect, vi } from 'vitest';
import { parseLoadFeed, type AttestedLoad } from '../coverage-load-reader.js';

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
