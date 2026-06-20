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
  type RoomScopeInput,
} from '../validator-pool.js';
import { assignCells, type CanaryValidator } from '../cell.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };

/** A minimal ActiveRoom-shaped fixture: only the fields room-scoping reads. */
const room = (validatorIds: string[], primaryRelayId?: string): { validatorIds: string[]; primaryRelayId?: string } => ({
  validatorIds,
  primaryRelayId,
});

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
