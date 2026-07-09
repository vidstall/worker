import { describe, it, expect } from 'vitest';
import { buildSessionUrl, parseArgs } from '../wan-split-driver';

// Base opts shared by the URL-building assertions. Only e2ee/role vary per case.
const base = {
  relayPin: null as 'standby' | null,
  distinguishable: false,
  startEpochMs: 1,
  windowMs: 25000,
  teardownMs: 2000,
  sessions: 1,
  pageBase: 'http://localhost:5173/bench/wan-measure-page.html',
  relay: 'ws://localhost:4000',
  bench: 'http://localhost:8081',
  realCamera: false,
  peerPrefix: 'produce',
  roomOverride: null as string | null,
};

describe('wan-split-driver e2ee passthrough', () => {
  it('--e2ee on puts e2ee=on on the PRODUCE leg URL', () => {
    const u = new URL(buildSessionUrl({ ...base, role: 'produce', e2ee: 'on' }, 0));
    expect(u.searchParams.get('e2ee')).toBe('on');
  });

  it('--e2ee on puts e2ee=on on the CONSUME leg URL', () => {
    const u = new URL(buildSessionUrl({ ...base, role: 'consume', e2ee: 'on' }, 0));
    expect(u.searchParams.get('e2ee')).toBe('on');
  });

  it('default (no flag) yields e2ee=off — preserves today\'s plaintext behavior on both legs', () => {
    // wan-measure.ts treats e2ee = (q.get('e2ee') === 'on'), so anything != 'on' is OFF.
    const produce = new URL(buildSessionUrl({ ...base, role: 'produce', e2ee: 'off' }, 0));
    const consume = new URL(buildSessionUrl({ ...base, role: 'consume', e2ee: 'off' }, 0));
    expect(produce.searchParams.get('e2ee')).not.toBe('on');
    expect(consume.searchParams.get('e2ee')).not.toBe('on');
  });
});

describe('wan-split-driver --e2ee flag parsing', () => {
  it('defaults to off when --e2ee is absent (preserves existing callers)', () => {
    const o = parseArgs([
      '--role', 'produce',
      '--start-epoch', '1',
    ]);
    expect(o.e2ee).toBe('off');
  });

  it('parses --e2ee on', () => {
    const o = parseArgs([
      '--role', 'produce',
      '--start-epoch', '1',
      '--e2ee', 'on',
    ]);
    expect(o.e2ee).toBe('on');
  });
});
