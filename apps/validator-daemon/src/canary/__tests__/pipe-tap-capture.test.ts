import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PipeTapCollector, createPipeTapCapture, type RtpTapConsumer } from '../pipe-tap-capture.js';

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

describe('createPipeTapCapture — conforms to the verify-loop capture seam', () => {
  it('returns a CanaryForwardCaptureResult carrying the snapshot + scope + meta', async () => {
    const a = fakeConsumer();
    const b = fakeConsumer();
    const collector = new PipeTapCollector([
      { receiverMinerId: 'val-A', consumer: a },
      { receiverMinerId: 'val-B', consumer: b },
    ]);
    a.emit('rtp', Buffer.from([7, 7]));
    b.emit('rtp', Buffer.from([7, 7]));

    const capture = createPipeTapCapture(collector, {
      canaryKid: 9,
      expectedCtrs: [0, 1, 2],
      kRoom: new Uint8Array(32).fill(1),
      cellSecret: new Uint8Array(16).fill(2),
    });

    const res = await capture({ relayId: 'relay-X', roomId: 'room-Y' });
    expect(res.relayId).toBe('relay-X');
    expect(res.roomId).toBe('room-Y');
    expect(res.canaryKid).toBe(9);
    expect(res.expectedCtrs).toEqual([0, 1, 2]);
    expect([...res.perReceiver.keys()].sort()).toEqual(['val-A', 'val-B']);
    expect(res.perReceiver.get('val-A')!.map((x) => [...x])).toEqual([[7, 7]]);
  });
});

describe('PipeTapCollector hardening (M2b B-4/B-6)', () => {
  it('dispose() removes the rtp listener so post-dispose packets are NOT captured', () => {
    const em = new EventEmitter();
    const c = new PipeTapCollector([{ receiverMinerId: 'r1', consumer: em }]);
    em.emit('rtp', Buffer.from([1, 2, 3]));
    expect(c.snapshot().get('r1')!.length).toBe(1);
    c.dispose();
    expect(em.listenerCount('rtp')).toBe(0);
    em.emit('rtp', Buffer.from([4, 5, 6]));
    expect(c.snapshot().get('r1')!.length).toBe(1); // unchanged after dispose
  });

  it('ring drops the OLDEST packet when over cap (head/tail, not O(n) shift)', () => {
    const em = new EventEmitter();
    const c = new PipeTapCollector([{ receiverMinerId: 'r1', consumer: em }], 2);
    em.emit('rtp', Buffer.from([1])); em.emit('rtp', Buffer.from([2])); em.emit('rtp', Buffer.from([3]));
    const snap = c.snapshot().get('r1')!;
    expect(snap.length).toBe(2);
    expect(snap[0]![0]).toBe(2); // oldest (1) dropped, FIFO order preserved
    expect(snap[1]![0]).toBe(3);
  });

  it('a per-scope collector only sees its own receivers', () => {
    const emA = new EventEmitter(); const emB = new EventEmitter();
    const cA = new PipeTapCollector([{ receiverMinerId: 'rxA', consumer: emA }]);
    const cB = new PipeTapCollector([{ receiverMinerId: 'rxB', consumer: emB }]);
    emA.emit('rtp', Buffer.from([1]));
    expect(cA.snapshot().has('rxA')).toBe(true);
    expect(cB.snapshot().has('rxA')).toBe(false);
  });
});
