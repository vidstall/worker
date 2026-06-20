/**
 * REQ-CFA-023 / REQ-CFA-024 / REQ-CFA-025 (M3 chunk 1, D-CFA-24) — room-scoped
 * co-auditor discovery tests.
 *
 * M1/M2 built the canary cell validator pool from the REGISTRY-WIDE discovery set
 * (`get_active_validators`) UNIONed with the self-entry. M3 SCOPES the pool to the
 * co-auditors of THIS daemon's OWN rooms — the validators each `RoomAssigned` already
 * carries in `validator_ids` (parsed and DISCARDED at index.ts today). The cross-receiver
 * denominator (loss-classifier signal 2) is meaningless on an inflated registry-wide set,
 * so room-scoping is a PREREQUISITE for the loss model AND a standalone W-M2-1 coverage-
 * ACCURACY fix on the SELF-REPORT half (D-CFA-15) — NOT a slashing-correctness change.
 *
 * The load-bearing invariants this test pins:
 *   (a) a registry validator NOT in any active room is EXCLUDED (the registry set is
 *       demoted to a liveness/identity refresh only — it never WIDENS the pool);
 *   (b) the self-entry is ALWAYS included (the daemon never loses its own coverage);
 *   (c) two rooms (A=[v1,v2], B=[v3,v4]) UNION correctly across the daemon's rooms;
 *   (d) a room dropping below the >=2 distinct floor honestly flips `covered:true->false`
 *       when the room-scoped pool is fed to the UNTOUCHED `assignCells` (pure).
 *
 * All fixture-driven — no boot, no ports, no localnet, no mediasoup.
 */

import { describe, it, expect } from 'vitest';
import {
  buildRoomScopedValidatorPool,
  buildRelayScopedValidatorPool,
  type RoomScopeInput,
  type RelayScopeInput,
  type ScopedRoom,
} from '../validator-pool.js';
import { assignCells, type CanaryValidator } from '../cell.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };

/** A minimal ActiveRoom-shaped fixture: only the fields room-scoping reads. */
const room = (validatorIds: string[], primaryRelayId?: string): { validatorIds: string[]; primaryRelayId?: string } => ({
  validatorIds,
  primaryRelayId,
});

/** A ScopedRoom fixture (relay slots + co-auditors) for the per-relay builder. */
const scopedRoom = (
  validatorIds: string[],
  primaryRelayId?: string,
  standbyRelayId?: string,
): ScopedRoom => ({ validatorIds, primaryRelayId, standbyRelayId });

const minerIds = (pool: CanaryValidator[]): string[] => pool.map((v) => v.minerId).sort();

describe('buildRoomScopedValidatorPool (REQ-CFA-024 / D-CFA-24)', () => {
  it('(a) EXCLUDES a registry validator not in any active room', () => {
    const input: RoomScopeInput = {
      activeRooms: [room(['v1', 'v2'])],
      self: SELF,
      // `reg-only` is in the registry-wide discovery cache but covers NONE of our rooms.
      discovered: ['v1', 'reg-only'],
    };
    const pool = buildRoomScopedValidatorPool(input);
    const ids = minerIds(pool);
    expect(ids).not.toContain('reg-only');
    // The room's co-auditors + self ARE present.
    expect(ids).toEqual(['self-miner', 'v1', 'v2']);
  });

  it('(b) ALWAYS includes the self-entry, even with zero rooms', () => {
    const pool = buildRoomScopedValidatorPool({ activeRooms: [], self: SELF, discovered: [] });
    expect(minerIds(pool)).toEqual(['self-miner']);
    // The self-entry keeps its real session wallet (used downstream, not a placeholder).
    const selfEntry = pool.find((v) => v.minerId === 'self-miner');
    expect(selfEntry?.sessionWallet).toBe('self-session');
  });

  it('(c) UNIONs two rooms A=[v1,v2] B=[v3,v4] across the daemon rooms', () => {
    const input: RoomScopeInput = {
      activeRooms: [room(['v1', 'v2'], 'relay-A'), room(['v3', 'v4'], 'relay-B')],
      self: SELF,
      discovered: [],
    };
    const ids = minerIds(buildRoomScopedValidatorPool(input));
    expect(ids).toEqual(['self-miner', 'v1', 'v2', 'v3', 'v4']);
  });

  it('de-duplicates a co-auditor that appears in BOTH rooms (no double-count)', () => {
    const input: RoomScopeInput = {
      activeRooms: [room(['v1', 'v2']), room(['v2', 'v3'])],
      self: SELF,
      discovered: [],
    };
    const ids = minerIds(buildRoomScopedValidatorPool(input));
    expect(ids).toEqual(['self-miner', 'v1', 'v2', 'v3']);
  });

  it('never double-counts the self-entry if a room also lists it', () => {
    const input: RoomScopeInput = {
      activeRooms: [room(['self-miner', 'v1'])],
      self: SELF,
      discovered: [],
    };
    const pool = buildRoomScopedValidatorPool(input);
    expect(pool.filter((v) => v.minerId === 'self-miner')).toHaveLength(1);
    // The self-entry carries the REAL session wallet, not a room-derived placeholder.
    expect(pool.find((v) => v.minerId === 'self-miner')?.sessionWallet).toBe('self-session');
  });
});

describe('room-scoped pool fed to assignCells — coverage honesty (REQ-CFA-025)', () => {
  // A non-empty assignment secret (assignCells now requires it; room-scoping is secret-
  // independent — these coverage assertions hold for ANY fixed secret).
  const assignmentSecret = new Uint8Array(32).fill(7);

  it('(d) a room dropping below the >=2 floor flips covered:true->false', () => {
    // Round 1: room A has 2 distinct co-auditors (+ self = 3) → covered for relay-A.
    const covered = buildRoomScopedValidatorPool({
      activeRooms: [room(['v1', 'v2'], 'relay-A')],
      self: SELF,
      discovered: [],
    });
    const cellsCovered = assignCells({ relays: ['relay-A'], validators: covered, round: 0, assignmentSecret });
    expect(cellsCovered[0]?.covered).toBe(true);

    // Round 2: the room shrinks so ONLY the self-entry remains (a registry validator that
    // is NOT a room co-auditor must NOT be allowed to backfill the pool to fake coverage).
    const belowFloor = buildRoomScopedValidatorPool({
      activeRooms: [room([], 'relay-A')],
      self: SELF,
      // The registry still reports v1/v2/reg-only as "live", but they cover no room of ours.
      discovered: ['v1', 'v2', 'reg-only'],
    });
    expect(minerIds(belowFloor)).toEqual(['self-miner']); // registry must NOT widen the pool
    const cellsBelow = assignCells({ relays: ['relay-A'], validators: belowFloor, round: 1, assignmentSecret });
    // Honest: a single-distinct pool cannot reach the >=2 floor → covered flips to false.
    expect(cellsBelow[0]?.covered).toBe(false);
  });
});

// ── M4a chunk 1: PER-RELAY room-scoping (REQ-CFA-036 / REQ-CFA-037, D-CFA-30/31) ──
//
// M3's buildRoomScopedValidatorPool UNIONs the co-auditors across ALL of this daemon's
// own rooms. When that union is fed to assignCells for relay-A's cell, a room-B-ONLY
// co-auditor can be picked into relay-A's cell -> the cross-receiver denominator the loss
// classifier reasons over OVER-COUNTS (W-M3-OVERCOUNT). The per-relay builder narrows the
// pool to ONLY the co-auditors of the room(s) THIS relay serves (primary OR standby),
// drawn from the already-event-sourced ScopedRoom.primaryRelayId/standbyRelayId — ZERO new
// chain read, INV-C-safe (miner_id only). It is a coverage-ACCURACY fix on the SELF-REPORT
// half (D-CFA-15), NOT a slashing change.

describe('buildRelayScopedValidatorPool (REQ-CFA-036 / D-CFA-30)', () => {
  it("(a) relay-A's pool EXCLUDES a room-B-only co-auditor (no cross-room union)", () => {
    // relay-A serves room A=[v1,v2]; relay-B serves room B=[v3,v4].
    const input: RelayScopeInput = {
      activeRooms: [scopedRoom(['v1', 'v2'], 'relay-A'), scopedRoom(['v3', 'v4'], 'relay-B')],
      self: SELF,
      relayId: 'relay-A',
    };
    const ids = minerIds(buildRelayScopedValidatorPool(input));
    // v3/v4 are room-B-only — they MUST NOT appear in relay-A's cell.
    expect(ids).not.toContain('v3');
    expect(ids).not.toContain('v4');
    // Only relay-A's own room co-auditors + self.
    expect(ids).toEqual(['self-miner', 'v1', 'v2']);
  });

  it('(b) a relay serving as STANDBY in a room sees that room co-auditors', () => {
    // relay-S is the STANDBY of room A (primary relay-P). Auditing the standby slot must
    // still scope to room A's co-auditors (RO-019a: the validator probes BOTH slots).
    const input: RelayScopeInput = {
      activeRooms: [scopedRoom(['v1', 'v2'], 'relay-P', 'relay-S')],
      self: SELF,
      relayId: 'relay-S',
    };
    expect(minerIds(buildRelayScopedValidatorPool(input))).toEqual(['self-miner', 'v1', 'v2']);
  });

  it('(c) ALWAYS includes the self-entry with its REAL session wallet', () => {
    const input: RelayScopeInput = {
      activeRooms: [scopedRoom(['v1'], 'relay-A')],
      self: SELF,
      relayId: 'relay-A',
    };
    const pool = buildRelayScopedValidatorPool(input);
    const selfEntry = pool.find((v) => v.minerId === 'self-miner');
    expect(selfEntry?.sessionWallet).toBe('self-session');
  });

  it('(d) a relay this daemon does not serve yields a self-only pool', () => {
    const input: RelayScopeInput = {
      activeRooms: [scopedRoom(['v1', 'v2'], 'relay-A')],
      self: SELF,
      relayId: 'relay-UNKNOWN',
    };
    expect(minerIds(buildRelayScopedValidatorPool(input))).toEqual(['self-miner']);
  });

  it('(e) zero new chain read: never reads the demoted registry discovery set', () => {
    // The per-relay builder takes NO `discovered` input at all — the registry-wide set
    // cannot widen a relay-scoped pool (it never could, D-CFA-24; here it is not even an arg).
    const input: RelayScopeInput = {
      activeRooms: [scopedRoom(['v1', 'v2'], 'relay-A')],
      self: SELF,
      relayId: 'relay-A',
    };
    // @ts-expect-error — RelayScopeInput has no `discovered` field by design.
    input.discovered = ['reg-only'];
    expect(minerIds(buildRelayScopedValidatorPool(input))).not.toContain('reg-only');
  });
});

describe('multi-homed relay disposition (REQ-CFA-037 / D-CFA-31 — NO silent re-union)', () => {
  // A relay miner_id homed in TWO of this daemon's rooms (room A=[v1,v2], room B=[v5,v6])
  // must yield ONE cell per (relay, room). The PURE builder is room-scoped per call: scoping
  // relay-M against room A's slice excludes room B's co-auditors, and vice-versa. A silent
  // re-union (returning v1,v2,v5,v6 in BOTH cells) re-opens W-M3-OVERCOUNT and MUST fail.

  it("per-(relay,room) scoping: relay-M's room-A pool excludes room-B co-auditors", () => {
    const roomA = scopedRoom(['v1', 'v2'], 'relay-M');
    const roomB = scopedRoom(['v5', 'v6'], 'relay-M');

    // Scope relay-M against ONLY room A's slice (the per-(relay,room) loop passes one room).
    const poolForRoomA = buildRelayScopedValidatorPool({
      activeRooms: [roomA],
      self: SELF,
      relayId: 'relay-M',
    });
    const idsA = minerIds(poolForRoomA);
    expect(idsA).toEqual(['self-miner', 'v1', 'v2']);
    // The re-union guard: room-B co-auditors MUST NOT bleed into relay-M's room-A cell.
    expect(idsA).not.toContain('v5');
    expect(idsA).not.toContain('v6');

    // Scope relay-M against ONLY room B's slice.
    const poolForRoomB = buildRelayScopedValidatorPool({
      activeRooms: [roomB],
      self: SELF,
      relayId: 'relay-M',
    });
    const idsB = minerIds(poolForRoomB);
    expect(idsB).toEqual(['self-miner', 'v5', 'v6']);
    expect(idsB).not.toContain('v1');
    expect(idsB).not.toContain('v2');
  });

  it('a multi-room-in-one-call scope WOULD re-union — pin that the per-room slice is the contract', () => {
    // If the builder is (incorrectly) handed BOTH of relay-M's rooms in a single call, it
    // unions them (v1,v2,v5,v6) — exactly the re-union W-M3-OVERCOUNT. This test PINS that
    // the over-count closure DEPENDS on the caller passing ONE room per (relay,room) cell;
    // the per-(relay,room) loop in startCanaryCellLoop is what guarantees that disposition.
    const reUnioned = buildRelayScopedValidatorPool({
      activeRooms: [scopedRoom(['v1', 'v2'], 'relay-M'), scopedRoom(['v5', 'v6'], 'relay-M')],
      self: SELF,
      relayId: 'relay-M',
    });
    // Documents the failure mode: a multi-room call DOES over-count. The loop MUST never do this.
    expect(minerIds(reUnioned)).toEqual(['self-miner', 'v1', 'v2', 'v5', 'v6']);
  });
});
