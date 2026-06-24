import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PipeTapCollector, type RtpTapConsumer } from '../pipe-tap-capture.js';

// A fake mediasoup consumer: emits 'rtp' Buffers, matching consumer.on('rtp', cb).
function fakeConsumer(): RtpTapConsumer & EventEmitter {
  return new EventEmitter() as RtpTapConsumer & EventEmitter;
}

describe('PipeTapCollector — captures forwarded RTP per receiver', () => {
  it('snapshots a deep copy of each receiver buffer; the live ring is untouched by the snapshot', () => {
    const a = fakeConsumer();
    const b = fakeConsumer();
    const collector = new PipeTapCollector([
      { receiverMinerId: 'val-A', consumer: a },
      { receiverMinerId: 'val-B', consumer: b },
    ]);

    a.emit('rtp', Buffer.from([1, 2, 3]));
    a.emit('rtp', Buffer.from([4, 5, 6]));
    b.emit('rtp', Buffer.from([9, 9]));

    const snap = collector.snapshot();
    expect(snap.get('val-A')!.map((x) => [...x])).toEqual([[1, 2, 3], [4, 5, 6]]);
    expect(snap.get('val-B')!.map((x) => [...x])).toEqual([[9, 9]]);

    // mutating the snapshot must NOT corrupt the collector's live buffers
    snap.get('val-A')![0]![0] = 0xff;
    expect([...collector.snapshot().get('val-A')![0]!]).toEqual([1, 2, 3]);
  });

  it('respects the per-receiver ring cap (oldest dropped)', () => {
    const a = fakeConsumer();
    const collector = new PipeTapCollector([{ receiverMinerId: 'val-A', consumer: a }], 2);
    a.emit('rtp', Buffer.from([1]));
    a.emit('rtp', Buffer.from([2]));
    a.emit('rtp', Buffer.from([3]));
    expect(collector.snapshot().get('val-A')!.map((x) => [...x])).toEqual([[2], [3]]);
  });
});
