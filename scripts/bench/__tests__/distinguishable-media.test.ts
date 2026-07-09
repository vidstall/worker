import { describe, it, expect } from 'vitest';
import { makeIdFrame, readIdFrame, toneHzFor } from '../distinguishable-media';

describe('distinguishable-media', () => {
  it('round-trips a stream id through the frame ID block', () => {
    const width = 320, height = 240;
    const frame = makeIdFrame(width, height, /*streamId*/ 7);
    expect(readIdFrame(frame, width, height)).toBe(7);
  });

  it('gives each stream a distinct tone', () => {
    expect(toneHzFor(0)).not.toBe(toneHzFor(1));
    expect(toneHzFor(3)).toBe(300 + 3 * 40); // base 300, step 40
  });
});
