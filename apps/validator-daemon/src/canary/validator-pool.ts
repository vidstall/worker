/**
 * REQ-CFA-023 / REQ-CFA-024 / REQ-CFA-025 (M3 chunk 1, D-CFA-24) — room-scoped
 * co-auditor discovery (validator-daemon, PURE).
 *
 * M1/M2 built the canary cell validator pool from the REGISTRY-WIDE discovery set
 * (`get_active_validators`) UNIONed with the self-entry. That over-counts: the cross-
 * receiver denominator the M3 loss classifier reasons over (loss-classifier.ts, signal 2)
 * is meaningless on an inflated set, and the M2 coverage feed over-reports who is auditing
 * a relay. M3 SCOPES the pool to the co-auditors of THIS daemon's OWN rooms — the
 * validators each `RoomAssigned` already carries in `validator_ids` (parsed and DISCARDED
 * at index.ts today, ZERO new chain cost — D-CFA-24).
 *
 * SCOPE HONESTY (D-CFA-15 / W-M2-1): this is a coverage-ACCURACY fix on the SELF-REPORT
 * half — it SHRINKS the pool the daemon assigns/reports over. It is NOT a slashing-
 * correctness change (slashing is the byte-equality verifier + the >=2-distinct Wallet-B
 * proof, untouched). The registry-wide discovery set is DEMOTED to a liveness/identity
 * refresh only — it NEVER widens the pool: a registry validator that covers none of this
 * daemon's rooms is EXCLUDED.
 *
 * INV-C: every id here is a `miner_id` / session-wallet (public); no on-chain A<->B link,
 * no secret on any surface. PURE: deterministic, allocation-only, no I/O — unit-testable
 * WITHOUT booting localnet / mediasoup / ports.
 *
 * LOGGING: this module holds no key material and emits no logs (pure data shaping).
 */

import type { CanaryValidator } from './cell.js';

/**
 * The minimal room shape room-scoping reads: the event-sourced co-auditor `validatorIds`
 * (from `RoomAssigned.validator_ids`) plus the relay slots (for relay-promotion staleness).
 * A structural subset of index.ts's `ActiveRoom` so the pure builder/reducers stay
 * decoupled from the daemon's full room state.
 */
export interface ScopedRoom {
  /**
   * The co-auditor validator miner_ids for this room, sourced from the in-event
   * `RoomAssigned.validator_ids`. Written ONLY by `applyRoomAssigned` (relay promotion
   * leaves it unchanged — both finalize paths emit `RoomAssigned`, promote_relay does not).
   */
  validatorIds: string[];
  /** Primary relay miner_id (RoomAssigned.relay_ids[0]). */
  primaryRelayId?: string;
  /** Standby relay miner_id (RoomAssigned.relay_ids[1]); undefined for single-relay rooms. */
  standbyRelayId?: string;
}

/** Inputs to {@link buildRoomScopedValidatorPool}. */
export interface RoomScopeInput {
  /**
   * This daemon's active rooms. The pool is the UNION of each room's `validatorIds`
   * across these rooms — the SAME `state.activeRooms` source `getRelays` reads.
   */
  activeRooms: Pick<ScopedRoom, 'validatorIds'>[];
  /** This daemon's own validator entry — ALWAYS included so the daemon never loses self-coverage. */
  self: CanaryValidator;
  /**
   * The registry-wide discovered miner_ids (liveness/identity refresh ONLY). DEMOTED:
   * it does NOT widen the pool — only ids that are co-auditors of one of `activeRooms`
   * survive. Carried so a future liveness/identity refresh can read it without re-widening.
   */
  discovered?: string[];
}

/**
 * Build the room-scoped canary validator pool: the UNION of each room's co-auditor
 * `validatorIds` across THIS daemon's `activeRooms`, plus the self-entry (always). A
 * registry validator NOT in any active room is EXCLUDED (the registry set never widens
 * the pool — D-CFA-24). Deduped by `minerId` (the stable distinctness key) so a co-auditor
 * listed in two rooms counts ONCE; the self-entry is always present with its REAL session
 * wallet (never overwritten by a room-derived placeholder).
 *
 * The room-derived co-auditors carry an EMPTY `sessionWallet` (the event only yields
 * miner_ids); `assignCells` dedups by `minerId` and never uses `sessionWallet` for
 * distinctness, so this is sound (the existing M2 union used the same empty-wallet shape).
 *
 * PURE: deterministic in its inputs; no I/O. Returns a fresh array each call.
 */
export function buildRoomScopedValidatorPool(input: RoomScopeInput): CanaryValidator[] {
  const union = new Map<string, CanaryValidator>();
  // Self is ALWAYS first and authoritative (keeps its real session wallet).
  union.set(input.self.minerId, input.self);

  for (const room of input.activeRooms) {
    for (const minerId of room.validatorIds) {
      // Never overwrite the self-entry's real session wallet with a room placeholder.
      if (!union.has(minerId)) union.set(minerId, { minerId, sessionWallet: '' });
    }
  }

  // NOTE: `input.discovered` is intentionally NOT unioned in — it is a liveness/identity
  // refresh source only (D-CFA-24). Widening the pool with it would re-open the M2 over-
  // count that room-scoping exists to close.

  return [...union.values()];
}

// ── Pure event reducers (the RoomAssigned/RelayPromoted seam index.ts delegates to) ──
//
// The inline RoomAssigned arm inside index.ts's `main()` is not unit-testable in isolation
// (localnet-deferred, like M2 P-M2-1). These pure reducers hold the room-scoping-relevant
// state transitions so the STALENESS invariant (promote_relay does not touch
// assigned_validators) is genuinely RED/GREEN-able. index.ts's arm mutates the same
// ScopedRoom-shaped fields; this is the extracted, test-covered logic.

/** A `RoomAssigned` event projected to the fields room-scoping consumes. */
export interface RoomAssignedView {
  roomId: string;
  primaryRelayId?: string;
  standbyRelayId?: string;
  /** The in-event co-auditor miner_ids (`RoomAssigned.validator_ids`). */
  validatorIds: string[];
}

/** A relay-promotion projection: the standby was promoted to primary (no validator change). */
export interface RelayPromotedView {
  roomId: string;
  /** The relay miner_id now serving as primary after the swap. */
  newPrimaryRelayId: string;
}

/**
 * Apply a `RoomAssigned` to the room map: write/refresh the room's relay slots AND its
 * co-auditor `validatorIds` from the in-event `validator_ids`. A re-assignment for the
 * same room REPLACES `validatorIds` (the latest assignment is authoritative). PURE w.r.t.
 * its inputs (mutates only the supplied map — the daemon's `state.activeRooms`).
 */
export function applyRoomAssigned(rooms: Map<string, ScopedRoom>, ev: RoomAssignedView): void {
  const room: ScopedRoom = rooms.get(ev.roomId) ?? { validatorIds: [] };
  room.primaryRelayId = ev.primaryRelayId;
  room.standbyRelayId = ev.standbyRelayId;
  room.validatorIds = [...ev.validatorIds];
  rooms.set(ev.roomId, room);
}

/**
 * Apply a relay promotion: move the primary relay slot ONLY. `validatorIds` is LEFT
 * UNCHANGED — `promote_relay`/`swap_relay` (room_manager.move:854) touch only
 * `assigned_relays` and emit NO `RoomAssigned`, so the event-sourced co-auditor set is
 * stable under a relay swap (W-M3-STALE). A promotion for an unknown room is a safe no-op
 * (we never invent a `validatorIds` set from a relay-only event).
 */
export function applyRelayPromoted(rooms: Map<string, ScopedRoom>, ev: RelayPromotedView): void {
  const room = rooms.get(ev.roomId);
  if (!room) return; // unknown room: no co-auditor set to mutate, and we never fabricate one
  room.primaryRelayId = ev.newPrimaryRelayId;
  // validatorIds DELIBERATELY untouched.
}
