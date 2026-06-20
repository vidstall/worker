/**
 * REQ-CFA-025 (M3 chunk 1, D-CFA-24) — room-scoping STALENESS fixture.
 *
 * `assigned_validators` is written on room ASSIGNMENT via TWO finalize paths
 * (room_manager.move:451 PVR-consensus + :591 proposal-pick), BOTH of which emit
 * `RoomAssigned`. `promote_relay` (room_manager.move:854) / `swap_relay` touch ONLY
 * `assigned_relays` and emit NO `RoomAssigned` — so a relay promotion MUST leave the
 * event-sourced `validatorIds` set UNCHANGED. This fixture pins that invariant on the
 * PURE reducer that index.ts's `RoomAssigned` arm delegates to, so the wiring is
 * genuinely RED/GREEN-able (the inline `main()` arm itself is localnet-deferred,
 * like M2 P-M2-1).
 *
 * On record (W-M3-STALE): the event-only set trusts the `RoomAssigned` cursor catching
 * BOTH finalize paths; the optional `get_active_rooms` devInspect reconciliation is a
 * defense-in-depth (miner_id/ID only, INV-C-safe), NOT built here.
 *
 * Fixture-driven — no boot, no ports.
 */

import { describe, it, expect } from 'vitest';
import {
  applyRoomAssigned,
  applyRelayPromoted,
  type ScopedRoom,
} from '../validator-pool.js';

describe('room-scoping staleness (REQ-CFA-025 / W-M3-STALE)', () => {
  it('RoomAssigned populates validatorIds from the in-event validator_ids', () => {
    const rooms = new Map<string, ScopedRoom>();
    applyRoomAssigned(rooms, {
      roomId: 'room-1',
      primaryRelayId: 'relay-A',
      standbyRelayId: 'relay-B',
      validatorIds: ['v1', 'v2'],
    });
    expect(rooms.get('room-1')?.validatorIds).toEqual(['v1', 'v2']);
    expect(rooms.get('room-1')?.primaryRelayId).toBe('relay-A');
  });

  it('RoomAssigned -> RelayPromoted leaves validatorIds UNCHANGED (promote touches only relays)', () => {
    const rooms = new Map<string, ScopedRoom>();
    applyRoomAssigned(rooms, {
      roomId: 'room-1',
      primaryRelayId: 'relay-A',
      standbyRelayId: 'relay-B',
      validatorIds: ['v1', 'v2'],
    });

    // A relay promotion swaps the standby into primary; it MUST NOT touch validatorIds.
    applyRelayPromoted(rooms, { roomId: 'room-1', newPrimaryRelayId: 'relay-B' });

    const room = rooms.get('room-1');
    expect(room?.validatorIds).toEqual(['v1', 'v2']); // co-auditor set is stable under swap
    expect(room?.primaryRelayId).toBe('relay-B'); // the relay slot DID move
  });

  it('RelayPromoted on an unknown room is a safe no-op (no validatorIds invented)', () => {
    const rooms = new Map<string, ScopedRoom>();
    applyRelayPromoted(rooms, { roomId: 'ghost', newPrimaryRelayId: 'relay-X' });
    expect(rooms.has('ghost')).toBe(false);
  });

  it('a second RoomAssigned for the same room REPLACES validatorIds (re-assignment is authoritative)', () => {
    const rooms = new Map<string, ScopedRoom>();
    applyRoomAssigned(rooms, {
      roomId: 'room-1',
      primaryRelayId: 'relay-A',
      validatorIds: ['v1', 'v2'],
    });
    applyRoomAssigned(rooms, {
      roomId: 'room-1',
      primaryRelayId: 'relay-A',
      validatorIds: ['v3', 'v4'],
    });
    expect(rooms.get('room-1')?.validatorIds).toEqual(['v3', 'v4']);
  });
});
