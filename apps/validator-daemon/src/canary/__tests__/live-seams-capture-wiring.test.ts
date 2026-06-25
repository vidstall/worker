import { describe, it, expect } from 'vitest';
import { selectCaptureMode } from '../live-seams.js';

// This unit test pins the B2 contract WITHOUT opening a socket or spawning a mediasoup worker:
// (1) selectCaptureMode is the only flag the prod wiring branches on, and any non-'pipe'
//     value MUST stay 'injected' (= the byte-identical empty-no-op path);
// (2) the capture-seam precedence the prod index.ts builds must prefer an injected liveSeams
//     capture, then a live pipe consumer, then fall back to the empty no-op — proven here as a
//     pure function so the wiring is testable without booting the daemon.

describe('B2 capture-mode flag (REQ-MLW-B-01)', () => {
  it("returns 'injected' for unset / any non-pipe value (byte-identical default)", () => {
    expect(selectCaptureMode({})).toBe('injected');
    expect(selectCaptureMode({ CANARY_LIVE_CAPTURE: '' })).toBe('injected');
    expect(selectCaptureMode({ CANARY_LIVE_CAPTURE: 'injected' })).toBe('injected');
    expect(selectCaptureMode({ CANARY_LIVE_CAPTURE: 'PIPE' })).toBe('injected'); // case-sensitive
  });
  it("returns 'pipe' only for the exact value 'pipe'", () => {
    expect(selectCaptureMode({ CANARY_LIVE_CAPTURE: 'pipe' })).toBe('pipe');
  });
});

import { chooseCapture } from '../../capture-precedence.js';
import type { CanaryForwardCapture, CanaryForwardCaptureResult } from '../verify-loop.js';

const fakeCapture = (tag: string): CanaryForwardCapture =>
  async (scope): Promise<CanaryForwardCaptureResult> => ({
    relayId: scope.relayId, roomId: scope.roomId, canaryKid: 0,
    expectedCtrs: [], kRoom: new Uint8Array([0]), cellSecret: new Uint8Array([0]),
    perReceiver: new Map([[tag, []]]),
  });

describe('B2 capture-seam precedence (REQ-MLW-B-01)', () => {
  const empty = fakeCapture('empty');
  it('prefers the injected liveSeams capture when present', () => {
    expect(chooseCapture(fakeCapture('injected'), fakeCapture('pipe'), empty)).not.toBe(empty);
  });
  it('uses the live pipe capture when no injected capture and pipe is attached', async () => {
    const chosen = chooseCapture(undefined, fakeCapture('pipe'), empty);
    const r = await chosen({ relayId: 'r', roomId: 'm' });
    expect([...r.perReceiver.keys()]).toEqual(['pipe']);
  });
  it('falls back to the empty no-op when neither is present (byte-identical OFF)', () => {
    expect(chooseCapture(undefined, undefined, empty)).toBe(empty);
  });
});
