/**
 * B6b (concern 4) -- PrimaryPipeCoordinator / StandbyWarmPipeCoordinator room-wide
 * teardown (clearRoom).
 *
 * Closes the coordinator twin of the B5 registry leak (DESIGN-1): index.ts
 * releaseRoom calls `clear(roomId)`, which drops ONLY the DEFAULT bucket
 * (meshKey(roomId, __default__)). Every per-(room, peerRelayId) cascade leg the
 * part-3 hub-fan populates -- states / producedIds / reverseConsumedIds /
 * reversePending (standby) and states / reverseMintPending / reverseMintedIds
 * (primary) -- LEAKS across a room teardown, corrupting a reused roomId.
 *
 * `clearRoom(roomId)` drops EVERY (room, peer) leg across ALL peerRelayId buckets
 * (REQ-RMS-036), mirroring InterRelayProducerRegistry.clearRoom (B5): same
 * lastIndexOf('::') exact-segment room-scoping (NOT a prefix), and -- crucially --
 * it must collect candidate keys from the PENDING maps too, not just `states`, so
 * a queued-but-never-connected leg (an announce that arrived before the leg ever
 * connected) is also dropped.
 *
 * TDD: write tests -> RED (clearRoom missing -> runtime "not a function") ->
 * implement -> GREEN.
 */

import { describe, it, expect, vi } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import {
  PrimaryPipeCoordinator,
  StandbyWarmPipeCoordinator,
  InterRelayProducerRegistry,
  DEFAULT_PEER_RELAY_ID,
  type PipePortAllocatorLike,
} from '@dvconf/inter-relay-client';

// ── shared mock helpers ──────────────────────────────────────────────────

function makeStubAllocator(port = 0): PipePortAllocatorLike & {
  allocate: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const held = new Set<string>();
  return {
    allocate: vi.fn((key: string) => { held.add(key); return port; }),
    release: vi.fn((key: string) => { held.delete(key); }),
    size: () => held.size,
  };
}

const REMAPPED_RTP = {
  codecs: [],
  headerExtensions: [],
  encodings: [{ ssrc: 99001 }],
  rtcp: {},
} as unknown as msTypes.RtpParameters;

const fakeRouter = {} as unknown as msTypes.Router;

/** A leg PipeTransport whose close() is spy-observable (proves teardown ran). */
function primaryLeg(): msTypes.PipeTransport & { close: ReturnType<typeof vi.fn>; produce: ReturnType<typeof vi.fn> } {
  return {
    close: vi.fn(),
    produce: vi.fn().mockResolvedValue({ id: 'minted', kind: 'video', on: vi.fn() }),
  } as unknown as msTypes.PipeTransport & { close: ReturnType<typeof vi.fn>; produce: ReturnType<typeof vi.fn> };
}

function primaryDeps() {
  return { announcer: vi.fn(), portAllocator: makeStubAllocator(0), paramSender: vi.fn() };
}

// ── PrimaryPipeCoordinator.clearRoom ──────────────────────────────────────

describe('B6b -- PrimaryPipeCoordinator.clearRoom room-wide teardown (REQ-RMS-036)', () => {
  it('A: clearRoom closes + drops EVERY (room,peer) leg -- DEFAULT + cascade -- leaving a sibling room intact', () => {
    const coord = new PrimaryPipeCoordinator(primaryDeps());
    const tDef = primaryLeg();
    const tB = primaryLeg();
    const tC = primaryLeg();
    const tSibling = primaryLeg();
    coord.bindLegTransportForTest('roomA', DEFAULT_PEER_RELAY_ID, tDef);
    coord.bindLegTransportForTest('roomA', 'relay-B', tB);
    coord.bindLegTransportForTest('roomA', 'relay-C', tC);
    coord.bindLegTransportForTest('roomB', 'relay-B', tSibling); // sibling room, same peer

    coord.clearRoom('roomA');

    expect(tDef.close).toHaveBeenCalledOnce();
    expect(tB.close).toHaveBeenCalledOnce();
    expect(tC.close).toHaveBeenCalledOnce();
    expect(tSibling.close).not.toHaveBeenCalled(); // roomB MUST survive roomA teardown
  });

  it('B: characterization -- clear(roomId) is DEFAULT-only and LEAVES the cascade leg alive (the leak); clearRoom closes it', () => {
    const coord = new PrimaryPipeCoordinator(primaryDeps());
    const tDef = primaryLeg();
    const tB = primaryLeg();
    coord.bindLegTransportForTest('room-leak', DEFAULT_PEER_RELAY_ID, tDef);
    coord.bindLegTransportForTest('room-leak', 'relay-B', tB);

    coord.clear('room-leak'); // the old releaseRoom call-site behaviour
    expect(tDef.close).toHaveBeenCalledOnce(); // DEFAULT torn down
    expect(tB.close).not.toHaveBeenCalled(); // relay-B LEAK proven (the bug)

    coord.clearRoom('room-leak'); // the fix
    expect(tB.close).toHaveBeenCalledOnce();
  });

  it('C: clearRoom drops a QUEUED-but-never-connected reverse mint (reverseMintPending leg with NO states entry)', async () => {
    const coord = new PrimaryPipeCoordinator(primaryDeps());
    // Queue a reverse mint on a cascade leg with NO bound transport -> it sits in
    // reverseMintPending and creates NO states entry. A clearRoom that iterated only
    // states.keys() would MISS it -> it would wrongly mint on a later drain.
    const queued = await coord.reverseMint(
      'roomA', fakeRouter,
      { producerId: 'up-X', kind: 'video', rtpParameters: REMAPPED_RTP },
      'relay-Q',
    );
    expect(queued).toBeNull();

    coord.clearRoom('roomA'); // must collect from reverseMintPending, not just states

    // Bind a transport + drain: nothing mints because the queue was cleared room-wide.
    const t = primaryLeg();
    coord.bindLegTransportForTest('roomA', 'relay-Q', t);
    const drained = await coord.drainReverseMints('roomA', 'relay-Q');
    expect(drained).toEqual([]);
    expect(t.produce).not.toHaveBeenCalled();
  });

  it('D: clearRoom("room") does NOT over-delete a PREFIX-adjacent roomId "roomAB" (exact segment equality)', () => {
    const coord = new PrimaryPipeCoordinator(primaryDeps());
    const tAB = primaryLeg();
    coord.bindLegTransportForTest('roomAB', 'relay-B', tAB); // ONLY roomAB exists
    coord.clearRoom('room'); // "room" is a strict string-prefix of "roomAB"
    expect(tAB.close).not.toHaveBeenCalled(); // the lastIndexOf('::') equality guard holds
  });

  it('E: clearRoom on an unknown room is a safe no-op (no throw)', () => {
    const coord = new PrimaryPipeCoordinator(primaryDeps());
    expect(() => coord.clearRoom('nonexistent')).not.toThrow();
  });
});

// ── StandbyWarmPipeCoordinator.clearRoom ──────────────────────────────────

describe('B6b -- StandbyWarmPipeCoordinator.clearRoom room-wide teardown (REQ-RMS-036)', () => {
  const standby = () => new StandbyWarmPipeCoordinator(new InterRelayProducerRegistry());
  const leg = () => ({} as unknown as msTypes.PipeTransport);

  it('A: clearRoom drops EVERY (room,peer) leg state -- DEFAULT + cascade -- leaving a sibling room intact', () => {
    const coord = standby();
    const tDef = leg();
    const tB = leg();
    const tC = leg();
    const tSibling = leg();
    coord.bindPipeTransportForTest('roomA', DEFAULT_PEER_RELAY_ID, tDef);
    coord.bindPipeTransportForTest('roomA', 'relay-B', tB);
    coord.bindPipeTransportForTest('roomA', 'relay-C', tC);
    coord.bindPipeTransportForTest('roomB', 'relay-B', tSibling);

    coord.clearRoom('roomA');

    expect(coord.currentPipeTransport('roomA', DEFAULT_PEER_RELAY_ID)).toBeNull();
    expect(coord.currentPipeTransport('roomA', 'relay-B')).toBeNull();
    expect(coord.currentPipeTransport('roomA', 'relay-C')).toBeNull();
    expect(coord.currentPipeTransport('roomB', 'relay-B')).toBe(tSibling); // sibling survives
  });

  it('B: characterization -- clear(roomId) is DEFAULT-only and LEAVES the cascade leg (the leak); clearRoom drops it', () => {
    const coord = standby();
    const tDef = leg();
    const tB = leg();
    coord.bindPipeTransportForTest('room-leak', DEFAULT_PEER_RELAY_ID, tDef);
    coord.bindPipeTransportForTest('room-leak', 'relay-B', tB);

    coord.clear('room-leak'); // old call-site behaviour
    expect(coord.currentPipeTransport('room-leak', DEFAULT_PEER_RELAY_ID)).toBeNull(); // DEFAULT gone
    expect(coord.currentPipeTransport('room-leak', 'relay-B')).toBe(tB); // relay-B LEAK proven

    coord.clearRoom('room-leak'); // the fix
    expect(coord.currentPipeTransport('room-leak', 'relay-B')).toBeNull();
  });

  it('C: clearRoom drops a QUEUED local producer (reversePending leg with NO bound transport)', async () => {
    const coord = standby();
    const upAnnounce = vi.fn();
    coord.setReverseAnnouncer(upAnnounce);
    // No bound transport on (roomA, relay-Q) -> onLocalClientProducer QUEUES into
    // reversePending and creates NO states entry.
    await coord.onLocalClientProducer('roomA', fakeRouter, { id: 'local-1', kind: 'video' }, 'clientA', 'relay-Q');
    expect(upAnnounce).not.toHaveBeenCalled(); // queued, not announced

    coord.clearRoom('roomA'); // must collect from reversePending, not just states

    // Bind + drain: nothing announces because the queue was cleared room-wide.
    coord.bindPipeTransportForTest('roomA', 'relay-Q', {
      consume: vi.fn().mockResolvedValue({ id: 'piped', kind: 'video', rtpParameters: REMAPPED_RTP }),
    } as unknown as msTypes.PipeTransport);
    await coord.drainReverse('roomA', 'relay-Q');
    expect(upAnnounce).not.toHaveBeenCalled();
  });

  it('D: clearRoom("room") does NOT over-delete a PREFIX-adjacent roomId "roomAB" (exact segment equality)', () => {
    const coord = standby();
    const tAB = leg();
    coord.bindPipeTransportForTest('roomAB', 'relay-B', tAB);
    coord.clearRoom('room');
    expect(coord.currentPipeTransport('roomAB', 'relay-B')).toBe(tAB); // not over-deleted
  });

  it('E: clearRoom on an unknown room is a safe no-op (no throw)', () => {
    const coord = standby();
    expect(() => coord.clearRoom('nonexistent')).not.toThrow();
  });
});
