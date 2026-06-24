import { describe, it, expect } from 'vitest';
import { selectCaptureMode } from '../live-seams.js';

describe('REQ-MLL-09 — CANARY_LIVE_CAPTURE flag routes the capture seam', () => {
  it('defaults to "injected" when unset (byte-identical path)', () => {
    expect(selectCaptureMode({})).toBe('injected');
    expect(selectCaptureMode({ CANARY_LIVE_CAPTURE: 'injected' })).toBe('injected');
  });
  it('routes to "pipe" only when explicitly set', () => {
    expect(selectCaptureMode({ CANARY_LIVE_CAPTURE: 'pipe' })).toBe('pipe');
  });
});
