/**
 * REQ-CFA-037 / REQ-CFA-038 (M4a chunk 1, D-CFA-30/31) — per-(relay,room) cell-loop tests.
 *
 * M2/M3's startCanaryCellLoop ran ONE flat assignCells over the UNION of relays + the UNION
 * of co-auditors across all of this daemon's rooms. For a multi-homed relay (same relay
 * miner_id serving two rooms) that flat union OVER-COUNTS the cross-receiver denominator
 * (W-M3-OVERCOUNT). M4a replaces the flat call with a per-(relay,room) loop driven by the
 * NEW pure buildRelayScopedValidatorPool, so:
 *   (REQ-CFA-037) a multi-homed relay emits ONE CellAssignment per (relay,room) — NO silent
 *                 re-union (a re-union must fail RED);
 *   (REQ-CFA-038) assignCells stays BYTE-IDENTICAL — its body is unchanged, only its
 *                 validators[] arg narrows. The cell for a GIVEN (relay, scoped-pool) is the
 *                 same CellAssignment the M3 flat call would have produced for that pool.
 *
 * The loop is now driven by an enumeration of (relay, room) scopes + a relay/room-aware
 * getValidators(scope) — the deps contract that closed the over-count at the loop root.
 *
 * All fixture-driven: no boot, no ports, no localnet, no mediasoup, no timers left running
 * (the loop is stopped synchronously after the immediate round-0 tick).
 */

import { describe, it, expect } from 'vitest';
import {
  startCanaryCellLoop,
  assignCells,
  type CanaryValidator,
  type RelayRoomScope,
} from '../cell.js';
import { buildRelayScopedValidatorPool, type ScopedRoom } from '../validator-pool.js';

const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };
const ASSIGN_SECRET = new Uint8Array(32).fill(7);

/** Stop the loop right after the synchronous round-0 tick (no interval left running). */
function runOneRound(deps: {
  getRelayRoomScopes: () => RelayRoomScope[];
  getValidators: (scope: RelayRoomScope) => CanaryValidator[];
}) {
  const handle = startCanaryCellLoop({
    deps,
    intervalMs: 1_000_000, // never fires within the test — round 0 runs immediately
    assignmentSecret: ASSIGN_SECRET,
  });
  const snap = handle.latest();
  handle.stop();
  return snap;
}

describe('per-(relay,room) cell loop (REQ-CFA-037 — NO silent re-union)', () => {
  it('a multi-homed relay emits ONE cell per (relay,room) — distinct scoped pools', () => {
    // relay-M serves BOTH room A=[v1,v2] and room B=[v5,v6]. The loop must emit TWO cells
    // for relay-M (one per room), each scoped to that room's co-auditors only.
    const rooms: { relayId: string; roomId: string; validatorIds: string[] }[] = [
      { relayId: 'relay-M', roomId: 'room-A', validatorIds: ['v1', 'v2'] },
      { relayId: 'relay-M', roomId: 'room-B', validatorIds: ['v5', 'v6'] },
    ];

    const snap = runOneRound({
      getRelayRoomScopes: () => rooms.map((r) => ({ relayId: r.relayId, roomId: r.roomId })),
      getValidators: (scope) => {
        const room = rooms.find((r) => r.roomId === scope.roomId)!;
        return buildRelayScopedValidatorPool({
          activeRooms: [{ validatorIds: room.validatorIds, primaryRelayId: room.relayId } as ScopedRoom],
          self: SELF,
          relayId: scope.relayId,
        });
      },
    });

    expect(snap).not.toBeNull();
    // TWO cells for the SAME relay miner_id — one per (relay,room).
    const relayMCells = snap!.cells.filter((c) => c.relayId === 'relay-M');
    expect(relayMCells).toHaveLength(2);

    // Each cell is scoped to ONLY its own room's co-auditors (NO re-union of v5/v6 into the
    // room-A cell). Collect the picked miner_ids of each cell.
    const pickedSets = relayMCells.map((c) => new Set(c.validators.map((v) => v.minerId)));
    // The room-A cell picks from {self, v1, v2}; the room-B cell picks from {self, v5, v6}.
    // A re-union (the over-count bug) would let v5/v6 appear in the same pool as v1/v2.
    const roomBOnly = new Set(['v5', 'v6']);
    const roomAOnly = new Set(['v1', 'v2']);
    const cellHasAny = (cell: Set<string>, ids: Set<string>) =>
      [...ids].some((id) => cell.has(id));
    // No single cell may contain BOTH a room-A-only and a room-B-only co-auditor.
    for (const cell of pickedSets) {
      expect(cellHasAny(cell, roomAOnly) && cellHasAny(cell, roomBOnly)).toBe(false);
    }
  });

  it('distinct relays in distinct rooms each get their own scoped cell', () => {
    const rooms = [
      { relayId: 'relay-A', roomId: 'room-A', validatorIds: ['v1', 'v2'] },
      { relayId: 'relay-B', roomId: 'room-B', validatorIds: ['v3', 'v4'] },
    ];
    const snap = runOneRound({
      getRelayRoomScopes: () => rooms.map((r) => ({ relayId: r.relayId, roomId: r.roomId })),
      getValidators: (scope) => {
        const room = rooms.find((r) => r.roomId === scope.roomId)!;
        return buildRelayScopedValidatorPool({
          activeRooms: [{ validatorIds: room.validatorIds, primaryRelayId: room.relayId } as ScopedRoom],
          self: SELF,
          relayId: scope.relayId,
        });
      },
    });
    expect(snap!.cells.map((c) => c.relayId).sort()).toEqual(['relay-A', 'relay-B']);
    // relay-A's cell never contains v3/v4 (room-B-only).
    const cellA = snap!.cells.find((c) => c.relayId === 'relay-A')!;
    const cellAIds = new Set(cellA.validators.map((v) => v.minerId));
    expect(cellAIds.has('v3')).toBe(false);
    expect(cellAIds.has('v4')).toBe(false);
  });
});

describe('assignCells byte-identity preserved (REQ-CFA-038)', () => {
  it('the per-(relay,room) cell equals the M3 assignCells output for the SAME scoped pool', () => {
    // For ONE (relay,room) scope, the loop's CellAssignment must be IDENTICAL to calling the
    // UNTOUCHED assignCells directly with that relay's scoped pool (salt/score/dedup unchanged).
    const validatorIds = ['v1', 'v2', 'v3'];
    const scopedPool = buildRelayScopedValidatorPool({
      activeRooms: [{ validatorIds, primaryRelayId: 'relay-A' } as ScopedRoom],
      self: SELF,
      relayId: 'relay-A',
    });

    // The reference: M3's untouched assignCells over the exact scoped pool, round 0.
    const reference = assignCells({
      relays: ['relay-A'],
      validators: scopedPool,
      round: 0,
      assignmentSecret: ASSIGN_SECRET,
    });

    const snap = runOneRound({
      getRelayRoomScopes: () => [{ relayId: 'relay-A', roomId: 'room-A' }],
      getValidators: () => scopedPool,
    });

    const loopCell = snap!.cells.find((c) => c.relayId === 'relay-A')!;
    // Byte-identical assignment: same relayId, same picked validators (order + fields), same covered.
    expect(loopCell).toStrictEqual(reference[0]);
  });
});
