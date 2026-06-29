/**
 * B5 -- InterRelayProducerRegistry room-wide teardown (clearRoom).
 *
 * Closes DESIGN-1: `clear(roomId)` only dropped the DEFAULT bucket; per-peer
 * reverse buckets populated by part-3 hub-fan leaked across a room teardown.
 * `clearRoom(roomId)` drops EVERY bucket for the room (REQ-RMS-036).
 *
 * TDD sequence: write tests -> RED (clearRoom missing) -> implement -> GREEN.
 */

import { describe, it, expect } from 'vitest';
import {
  InterRelayProducerRegistry,
  DEFAULT_PEER_RELAY_ID,
} from '@dvconf/inter-relay-client';

// ── Case A: clearRoom drops ALL per-peer buckets (the leak-fix teeth) ─────────
// RED first: clearRoom does not exist yet -> TypeScript compile/type error -> RED.

describe('B5 -- InterRelayProducerRegistry.clearRoom room-wide teardown (REQ-RMS-036)', () => {
  it('A: clearRoom drops ALL (room, peer) buckets -- DEFAULT + cascade peers -- leaving sibling room intact', () => {
    const reg = new InterRelayProducerRegistry();

    // roomA -- three buckets: DEFAULT + relay-B + relay-C
    reg.record({ type: 'pipe-producer', roomId: 'roomA', producerId: 'p-def', kind: 'video' });
    reg.record({ type: 'pipe-producer', roomId: 'roomA', producerId: 'p-b',   kind: 'audio', peerRelayId: 'relay-B' });
    reg.record({ type: 'pipe-producer', roomId: 'roomA', producerId: 'p-c',   kind: 'video', peerRelayId: 'relay-C' });

    // roomB -- one bucket (relay-B) that must survive roomA teardown
    reg.record({ type: 'pipe-producer', roomId: 'roomB', producerId: 'p-b2',  kind: 'video', peerRelayId: 'relay-B' });

    // Pre-condition: all three roomA producers visible
    expect(reg.listForRoom('roomA')).toHaveLength(3);
    // roomB bucket exists
    expect(reg.listForRoom('roomB')).toHaveLength(1);

    // The method under test -- clearRoom drops EVERY roomA bucket.
    reg.clearRoom('roomA');

    // Post-condition: roomA fully drained
    expect(reg.listForRoom('roomA')).toEqual([]);
    // Explicit per-peer accessor also returns null (not just an empty list)
    expect(reg.resolve('roomA', 'relay-B')).toBeNull();
    expect(reg.resolve('roomA', 'relay-C')).toBeNull();
    expect(reg.resolve('roomA')).toBeNull(); // DEFAULT bucket gone too

    // roomB isolation: sibling bucket MUST survive
    expect(reg.listForRoom('roomB')).toHaveLength(1);
    expect(reg.resolve('roomB', 'relay-B')?.producerId).toBe('p-b2');
  });

  // ── Case B: characterization -- old clear(roomId) leaks non-DEFAULT buckets ──
  // Stays GREEN even before the fix (documents the leak that clearRoom closes).

  it('B: characterization -- clear(roomId) is DEFAULT-only and LEAVES relay-B bucket intact (the DESIGN-1 leak)', () => {
    const reg = new InterRelayProducerRegistry();

    reg.record({ type: 'pipe-producer', roomId: 'room-leak', producerId: 'pDef',  kind: 'video' });
    reg.record({ type: 'pipe-producer', roomId: 'room-leak', producerId: 'pPeer', kind: 'audio', peerRelayId: 'relay-B' });

    // Drop only the DEFAULT bucket (the old call-site behaviour).
    reg.clear('room-leak');

    // The relay-B record STILL survives -- this IS the leak.
    expect(reg.listForRoom('room-leak')).toHaveLength(1);
    expect(reg.resolve('room-leak', DEFAULT_PEER_RELAY_ID)).toBeNull(); // DEFAULT gone
    expect(reg.resolve('room-leak', 'relay-B')?.producerId).toBe('pPeer'); // LEAK proven

    // clearRoom now closes the leak: relay-B is also dropped.
    reg.clearRoom('room-leak');
    expect(reg.listForRoom('room-leak')).toEqual([]);
  });

  // ── Case C: two producers in SAME (room, peer) bucket -- both cleared; sibling room survives ──

  it('C: clearRoom removes BOTH producers in the same (room,peer) bucket and does not affect a different room\'s same-peer bucket', () => {
    const reg = new InterRelayProducerRegistry();

    // Two producers in (room-C, relay-B)
    reg.record({ type: 'pipe-producer', roomId: 'room-C', producerId: 'pC1', kind: 'video', peerRelayId: 'relay-B' });
    reg.record({ type: 'pipe-producer', roomId: 'room-C', producerId: 'pC2', kind: 'audio', peerRelayId: 'relay-B' });

    // room-D's relay-B bucket must survive room-C teardown
    reg.record({ type: 'pipe-producer', roomId: 'room-D', producerId: 'pD1', kind: 'video', peerRelayId: 'relay-B' });

    // Verify pre-conditions
    expect(reg.listForRoom('room-C')).toHaveLength(2);
    expect(reg.resolve('room-D', 'relay-B')?.producerId).toBe('pD1');

    // Teardown room-C only
    reg.clearRoom('room-C');

    // Both room-C producers are gone
    expect(reg.listForRoom('room-C')).toEqual([]);
    expect(reg.resolveAll('room-C', 'relay-B')).toEqual([]);

    // room-D's relay-B bucket is untouched (sibling-room survival)
    expect(reg.resolve('room-D', 'relay-B')?.producerId).toBe('pD1');
    expect(reg.listForRoom('room-D')).toHaveLength(1);
  });

  // ── Case D: a strict PREFIX roomId must NOT over-delete (equality-guard teeth) ──

  it('D: clearRoom("room") does NOT over-delete a PREFIX-adjacent roomId "roomAB" (exact room-segment equality, not prefix)', () => {
    const reg = new InterRelayProducerRegistry();

    // ONLY a bucket for "roomAB" exists.
    reg.record({ type: 'pipe-producer', roomId: 'roomAB', producerId: 'pAB', kind: 'video', peerRelayId: 'relay-B' });
    expect(reg.listForRoom('roomAB')).toHaveLength(1);

    // "room" is a strict string-prefix of "roomAB". A prefix-based teardown would
    // wrongly drop roomAB's bucket; the lastIndexOf('::') segment-EQUALITY guard must not.
    reg.clearRoom('room');

    // roomAB is UNCHANGED -- the prefix did not over-delete.
    expect(reg.listForRoom('roomAB')).toHaveLength(1);
    expect(reg.resolve('roomAB', 'relay-B')?.producerId).toBe('pAB');
  });

  // ── Case E: an unknown roomId teardown is a safe no-op ──

  it('E: clearRoom("nonexistent") on a populated registry does not throw and leaves roomCount unchanged', () => {
    const reg = new InterRelayProducerRegistry();

    reg.record({ type: 'pipe-producer', roomId: 'room-X', producerId: 'pX', kind: 'video' });
    reg.record({ type: 'pipe-producer', roomId: 'room-Y', producerId: 'pY', kind: 'audio', peerRelayId: 'relay-B' });
    const before = reg.roomCount;
    expect(before).toBe(2);

    // No bucket matches -- must be a safe no-op (no throw, no collateral delete).
    expect(() => reg.clearRoom('nonexistent')).not.toThrow();
    expect(reg.roomCount).toBe(before);
  });
});
