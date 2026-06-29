/**
 * Unit tests for the EXTRACTED index.ts onReverseAnnounce orchestration closure
 * (makeOnReverseAnnounce). A6-gate remediation, REQ-RMS-037 / REQ-RMS-034.
 *
 * These tests RUN the real production handler (the same factory index.ts wires
 * into InterRelayContext.onReverseAnnounce) against a MOCK PrimaryPipeCoordinator
 * (ensureReverseLeg + reverseMint as vi.fn) + spy getRoom / registerReverseMinted.
 * They pin:
 *   - the new reverse-before-forward ordering: ensureReverseLeg runs BEFORE
 *     reverseMint (the teeth for the A6 functional finding -- without it the
 *     standby-produces-first announce queues forever, since the only drains had
 *     ZERO production callers);
 *   - the 2 guards (missing room / absent rtpParameters);
 *   - registerReverseMinted fires ONLY on a truthy mint;
 *   - origin defaults to DEFAULT_PEER_RELAY_ID when peerRelayId is undefined.
 *
 * NOT covered here (by design): the real-mediasoup mint+connect+reply inside
 * ensureReverseLeg/reverseMint -- that is A5 (rms-reverse-leg.integration.test.ts).
 *
 * Requirements: REQ-RMS-037 (reverse-leg drain ordering), REQ-RMS-034.
 */

import { describe, it, expect, vi } from 'vitest';
import { makeOnReverseAnnounce } from '../reverse-announce-handler.js';
import { DEFAULT_PEER_RELAY_ID } from '@dvconf/inter-relay-client';
import type { types as msTypes } from 'mediasoup';
import type { RoomState } from '../room-handler.js';

const fakeRouter = { id: 'router-1' } as unknown as msTypes.Router;
const fakeRoom = { roomId: 'roomA', router: fakeRouter } as unknown as RoomState;
const fakeMinted = { id: 'minted-1' } as unknown as msTypes.Producer;
const rtpParams = { codecs: [], headerExtensions: [] } as unknown as msTypes.RtpParameters;

interface Announced {
  producerId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
}

// Build a fresh set of strongly-typed mocks per test. NB: no Partial-spread
// override merge here -- that would widen each property to (Mock | fn) and break
// `.mock` access. Tests that need a different behavior mutate via
// mockReturnValue/mockResolvedValue, which keeps the Mock type.
function makeDeps() {
  return {
    ensureReverseLeg: vi.fn(
      async (_roomId: string, _router: msTypes.Router, _peerRelayId: string): Promise<void> => {},
    ),
    reverseMint: vi.fn(
      async (
        _roomId: string,
        _router: msTypes.Router,
        _announced: Announced,
        _peerRelayId: string,
      ): Promise<msTypes.Producer | null> => fakeMinted,
    ),
    getRoom: vi.fn((_roomId: string): RoomState | undefined => fakeRoom),
    registerReverseMinted: vi.fn(
      (
        _roomId: string,
        _minted: msTypes.Producer,
        _originRelayId: string,
        _producerPeerId?: string,
      ): void => {},
    ),
  };
}

describe('makeOnReverseAnnounce (A6-gate remediation, REQ-RMS-037)', () => {
  it('A6FIX-1: standby-produces-first -> ensureReverseLeg runs BEFORE reverseMint, then registerReverseMinted fans the mint', async () => {
    const deps = makeDeps();
    const onReverseAnnounce = makeOnReverseAnnounce(deps);

    await onReverseAnnounce('roomA', 'prod-1', 'video', rtpParams, 'relay-B', 'peer-X');

    // both establish + mint ran, with the announced room.router + origin
    expect(deps.ensureReverseLeg).toHaveBeenCalledTimes(1);
    expect(deps.ensureReverseLeg).toHaveBeenCalledWith('roomA', fakeRouter, 'relay-B');
    expect(deps.reverseMint).toHaveBeenCalledTimes(1);
    expect(deps.reverseMint).toHaveBeenCalledWith(
      'roomA',
      fakeRouter,
      { producerId: 'prod-1', kind: 'video', rtpParameters: rtpParams },
      'relay-B',
    );

    // TEETH for finding #1: ensureReverseLeg MUST be invoked before reverseMint so
    // the leg is connected + drained before THIS announce mints.
    expect(deps.ensureReverseLeg.mock.invocationCallOrder[0]).toBeLessThan(
      deps.reverseMint.mock.invocationCallOrder[0],
    );

    // the truthy mint is fanned with the original publisher's producerPeerId
    expect(deps.registerReverseMinted).toHaveBeenCalledTimes(1);
    expect(deps.registerReverseMinted).toHaveBeenCalledWith('roomA', fakeMinted, 'relay-B', 'peer-X');
  });

  it('A6FIX-2 guard: getRoom returns undefined -> no ensureReverseLeg/reverseMint/registerReverseMinted call', async () => {
    const deps = makeDeps();
    deps.getRoom.mockReturnValue(undefined);
    const onReverseAnnounce = makeOnReverseAnnounce(deps);

    await onReverseAnnounce('roomA', 'prod-1', 'video', rtpParams, 'relay-B', 'peer-X');

    expect(deps.ensureReverseLeg).not.toHaveBeenCalled();
    expect(deps.reverseMint).not.toHaveBeenCalled();
    expect(deps.registerReverseMinted).not.toHaveBeenCalled();
  });

  it('A6FIX-3 guard: rtpParameters === undefined -> no ensureReverseLeg/reverseMint/registerReverseMinted call', async () => {
    const deps = makeDeps();
    const onReverseAnnounce = makeOnReverseAnnounce(deps);

    await onReverseAnnounce('roomA', 'prod-1', 'video', undefined, 'relay-B', 'peer-X');

    expect(deps.ensureReverseLeg).not.toHaveBeenCalled();
    expect(deps.reverseMint).not.toHaveBeenCalled();
    expect(deps.registerReverseMinted).not.toHaveBeenCalled();
  });

  it('A6FIX-4: reverseMint returns null (queued / dedup) -> registerReverseMinted NOT called (but the leg was still ensured)', async () => {
    const deps = makeDeps();
    deps.reverseMint.mockResolvedValue(null);
    const onReverseAnnounce = makeOnReverseAnnounce(deps);

    await onReverseAnnounce('roomA', 'prod-1', 'video', rtpParams, 'relay-B', 'peer-X');

    expect(deps.ensureReverseLeg).toHaveBeenCalledTimes(1);
    expect(deps.reverseMint).toHaveBeenCalledTimes(1);
    expect(deps.registerReverseMinted).not.toHaveBeenCalled();
  });

  it('A6FIX-5: origin defaults to DEFAULT_PEER_RELAY_ID when peerRelayId is undefined', async () => {
    const deps = makeDeps();
    const onReverseAnnounce = makeOnReverseAnnounce(deps);

    await onReverseAnnounce('roomA', 'prod-1', 'audio', rtpParams, undefined, 'peer-Y');

    expect(deps.ensureReverseLeg).toHaveBeenCalledWith('roomA', fakeRouter, DEFAULT_PEER_RELAY_ID);
    expect(deps.reverseMint).toHaveBeenCalledWith(
      'roomA',
      fakeRouter,
      { producerId: 'prod-1', kind: 'audio', rtpParameters: rtpParams },
      DEFAULT_PEER_RELAY_ID,
    );
    expect(deps.registerReverseMinted).toHaveBeenCalledWith(
      'roomA',
      fakeMinted,
      DEFAULT_PEER_RELAY_ID,
      'peer-Y',
    );
  });
});
