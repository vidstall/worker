import { describe, it, expect } from 'vitest';
import {
  buildSessionUrl,
  classifyE2eeAttachment,
  parseArgs,
  remainingSessionBudget,
} from '../wan-split-driver';

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
  roomPrefix: 'wan-', // the parseArgs default — matches historical behavior
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

  it('rejects values other than the declared on/off arms', () => {
    expect(() => parseArgs([
      '--role', 'produce',
      '--start-epoch', '1',
      '--e2ee', 'yes',
    ])).toThrow('--e2ee must be either on or off');
  });

  it('rejects missing, misspelled, and duplicate arm flags', () => {
    const required = ['--role', 'produce', '--start-epoch', '1'];
    expect(() => parseArgs([...required, '--e2ee', '--sessions', '30']))
      .toThrow('--e2ee requires a value');
    expect(() => parseArgs([...required, '--e22e', 'on']))
      .toThrow('unknown option: --e22e');
    expect(() => parseArgs([...required, '--e2ee', 'on', '--e2ee', 'off']))
      .toThrow('duplicate option: --e2ee');
  });

  it('requires strict positive session/window integers and valid teardown', () => {
    const required = ['--role', 'produce', '--start-epoch', '1'];
    expect(() => parseArgs([...required, '--sessions', '0']))
      .toThrow('--sessions must be >= 1');
    expect(() => parseArgs([...required, '--sessions', '30junk']))
      .toThrow('strict integer');
    expect(() => parseArgs([...required, '--window-ms', '0']))
      .toThrow('--window-ms must be >= 1');
    expect(() => parseArgs([...required, '--teardown-ms', '-1']))
      .toThrow('--teardown-ms must be >= 0');
    expect(() => parseArgs([...required, '--window-ms', '100', '--teardown-ms', '100']))
      .toThrow('must be < --window-ms');
    expect(() => parseArgs([...required, '--window-ms', '1500', '--teardown-ms', '600']))
      .toThrow('leave at least 1000ms');
  });
});

describe('wan-split-driver absolute session deadline', () => {
  it('returns only the budget remaining before the shared closeAt', () => {
    expect(remainingSessionBudget(25_000, 24_250)).toBe(750);
  });

  it('fails when context creation/navigation has consumed the shared window', () => {
    expect(() => remainingSessionBudget(25_000, 25_000)).toThrow('already elapsed');
    expect(() => remainingSessionBudget(25_000, 25_100)).toThrow('already elapsed');
  });
});

describe('wan-split-driver E2EE attachment evidence', () => {
  it('accepts the producer encrypt marker only for the produce leg', () => {
    const line = '[wan-measure] E2EE encrypt attached (api=script-transform) room=wan-0';
    expect(classifyE2eeAttachment('produce', line)).toBe('attached');
    expect(classifyE2eeAttachment('consume', line)).toBeNull();
  });

  it('accepts the consumer decrypt marker only for the consume leg', () => {
    const line = '[wan-measure] E2EE decrypt attached (api=script-transform) room=wan-0';
    expect(classifyE2eeAttachment('consume', line)).toBe('attached');
    expect(classifyE2eeAttachment('produce', line)).toBeNull();
  });

  it('classifies explicit missing-transform warnings as failure evidence', () => {
    expect(classifyE2eeAttachment(
      'produce',
      '[wan-measure] e2ee=on but producer.rtpSender absent - leg NOT encrypted',
    )).toBe('missing');
    expect(classifyE2eeAttachment(
      'consume',
      '[wan-measure] e2ee=on but consumer.rtpReceiver absent - leg NOT decrypted',
    )).toBe('missing');
  });

  it('classifies a fail-closed bench attachment error as failure evidence', () => {
    expect(classifyE2eeAttachment(
      'produce',
      '[wan-measure] E2EE encrypt attachment FAILED room=wan-0: transform unsupported',
    )).toBe('missing');
    expect(classifyE2eeAttachment(
      'consume',
      '[wan-measure] E2EE decrypt attachment FAILED room=wan-0: no worker',
    )).toBe('missing');
  });

  it('classifies the page-level fatal emitted by a thrown bench gate', () => {
    expect(classifyE2eeAttachment(
      'produce',
      '[wan-measure] fatal: Error: E2EE encrypt transform unsupported',
    )).toBe('missing');
  });
});
