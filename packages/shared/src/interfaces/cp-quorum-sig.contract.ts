/**
 * Cap-token primitive contract interface — Phase 1 frozen surface (S53 2026-05-25).
 *
 * Source of truth: `dvconf-contracts/sources/security/cp_quorum_sig.spec.move`
 * (L2 interface snapshot, FROZEN S53).
 *
 * Also covers Phase 1.2 base event types:
 *   `dvconf-contracts/sources/security/capability_events.move`
 *   `dvconf-contracts/sources/security/capability_errors.move`
 *
 * ## Lock convention
 * Changing this file requires a PAIRED update to ALL of the following:
 *   - `cp_quorum_sig.spec.move` (L2 interface snapshot)
 *   - `capability_events.move` (if base event field order changes — BCS-breaking)
 *   - `capability_errors.move` (if error code numeric values change)
 *   - All downstream consumers: F62 Phase 2.x room_capability, F47 cooldown, F5 TURN, F8 rotation
 *
 * ## Type conventions (matches dvconf-daemons types/events.ts style)
 * - Sui object IDs and addresses → `string` (0x-prefixed hex)
 * - u64 values → `string`  (Sui JSON serialisation of large integers)
 * - u8 values  → `number`
 * - vector<u8> → `number[]` (Uint8Array is NOT used — matches existing events.ts)
 * - vector<address> → `string[]`
 *
 * ## Naming convention
 * Snake_case Move field names converted to camelCase per dvconf-daemons TS style
 * (see types/events.ts for reference). Accessor function stubs mirror Move public
 * fun names (not camelCase, because they are Move entry point identifiers).
 *
 * Last sync: 2026-05-25 (S53, Phase 1 SHIP gate)
 */

// ── § Phase 1.1 — QuorumSig structs (BCS frozen S53) ──────────────────────────

/**
 * Mirrors `QuorumSig { signers: vector<address>, signatures: vector<vector<u8>> }`.
 *
 * BCS field order: signers → signatures (declaration order per D-002 BCS convention).
 * `signers[i]` is the Sui operator address of the CP whose signature lives at
 * `signatures[i]`. Pubkeys are passed separately to `verify_quorum` — NOT stored
 * here (D-001 design decision, pubkeys-as-parameter pattern).
 */
export interface QuorumSig {
  /** Operator addresses of each CP signer (0x-prefixed hex). signers[i] ↔ signatures[i]. */
  signers: string[];
  /** Raw ed25519 signatures as byte arrays. */
  signatures: number[][];
}

/**
 * Mirrors `QuorumConfigState { id: UID, min_quorum: u64 }`.
 *
 * Shared mutable M-of-N threshold. Created via `create_config`, updated via
 * `update_threshold` (AdminCap-gated). Phase 2.x consumers read `minQuorum` to
 * know the current threshold before assembling a QuorumSig.
 */
export interface QuorumConfigState {
  /** Sui UID object ID (0x-prefixed hex). */
  id: string;
  /** Minimum number of valid CP signatures required (default 2 per D-B4). u64 as string. */
  minQuorum: string;
}

// ── § Phase 1.1 — Error code constants (namespace 880-889, frozen S53) ────────

/**
 * Error codes for the `cp_quorum_sig` module.
 * Numeric values are frozen S53 — see D-001 + D-002 for rationale.
 * Reserved future range: 886-889 (activate in Stage 2 strict-abort wrappers).
 */
export const QUORUM_SIG_ERRORS = {
  /** Signer count < min_quorum threshold. Currently soft-fail (emits QuorumInsufficient). Reserved for Stage 2 strict-abort. */
  E_INSUFFICIENT_QUORUM: 880,
  /** An ed25519 signature failed verification. Reserved for Stage 2 strict-abort. */
  E_INVALID_SIG: 881,
  /** NetworkRegistry paused flag is set; all state-mutating ops are blocked. */
  E_PAUSED: 882,
  /** QuorumConfigState min_quorum is 0 or otherwise invalid. */
  E_QUORUM_CONFIG_INVALID: 883,
  /** `pubkeys.length !== qs.signers.length` — shape mismatch in verify_quorum call. */
  E_PUBKEY_COUNT_MISMATCH: 884,
  /** A signer address is not found in the active ControlPlaneRegistry. Reserved for Stage 2. */
  E_SIGNER_NOT_REGISTERED: 885,
  // 886-889: reserved-future (Stage 2+ strict-abort extensions — do not use)
} as const;

export type QuorumSigErrorCode = (typeof QUORUM_SIG_ERRORS)[keyof typeof QUORUM_SIG_ERRORS];

// ── § Phase 1.1 — Event types (frozen S53) ────────────────────────────────────

/**
 * Emitted by `verify_quorum` when M-of-N threshold is satisfied.
 * Mirrors `QuorumVerified { signers: vector<address>, msg_hash: vector<u8> }`.
 */
export interface QuorumVerifiedEvent {
  kind: 'QuorumVerified';
  /** CP operator addresses that provided valid signatures. */
  signers: string[];
  /** keccak256 / SHA3-256 hash of the verified message payload. */
  msgHash: number[];
}

/**
 * Emitted by `verify_quorum` when the signer count is below the threshold.
 * Verify remains a soft-fail predicate (returns false) — does NOT abort.
 * Mirrors `QuorumInsufficient { signers_count: u64, required: u64 }`.
 */
export interface QuorumInsufficientEvent {
  kind: 'QuorumInsufficient';
  /** Number of valid signatures provided (< required). u64 as string. */
  signersCount: string;
  /** Minimum signatures required (from QuorumConfigState.min_quorum). u64 as string. */
  required: string;
}

/**
 * Emitted by `update_threshold` when the M-of-N minimum is changed.
 * Mirrors `QuorumConfigUpdated { old_threshold: u64, new_threshold: u64, updater: address }`.
 */
export interface QuorumConfigUpdatedEvent {
  kind: 'QuorumConfigUpdated';
  /** Previous min_quorum value. u64 as string. */
  oldThreshold: string;
  /** New min_quorum value. u64 as string. */
  newThreshold: string;
  /** Address that performed the update (AdminCap holder). */
  updater: string;
}

/** Discriminated union of all Phase 1.1 events from `cp_quorum_sig` module. */
export type QuorumSigEvent =
  | QuorumVerifiedEvent
  | QuorumInsufficientEvent
  | QuorumConfigUpdatedEvent;

// ── § Phase 1.1 — Function signature stubs (frozen S53) ───────────────────────
// These are TypeScript-side declarations only — no implementation.
// Phase 3.1 cp-token-issuer daemon imports these to build type-safe TX calls.
// Parameter types mirror the Move public fun signatures byte-for-byte.
// Move type → TS mapping: &AdminCap → string (objectId), &NetworkRegistry → string,
// &ControlPlaneRegistry → string, &QuorumConfigState → string, &mut → string.

/**
 * `public fun create_config(_: &AdminCap, ctx: &mut TxContext)`
 * Creates the shared QuorumConfigState object. AdminCap-gated.
 * @param adminCap - objectId of the AdminCap owned object
 */
export declare function createConfig(adminCap: string): Promise<void>;

/**
 * `public fun new_quorum_sig(signers: vector<address>, signatures: vector<vector<u8>>): QuorumSig`
 * Constructs a QuorumSig value off-chain before passing it to verify_quorum.
 * @param signers - CP operator address strings (0x-prefixed hex)
 * @param signatures - Parallel ed25519 signatures as byte arrays
 */
export declare function newQuorumSig(signers: string[], signatures: number[][]): QuorumSig;

/**
 * `public fun verify_quorum(net_reg, cp_reg, state, qs, pubkeys, msg): bool`
 * Soft-fail predicate. Emits QuorumVerified or QuorumInsufficient.
 * Returns true iff >= min_quorum valid ed25519 signatures are provided by
 * registered CP operators. Aborts only on paused-flag or shape mismatch.
 * @param netReg - objectId of NetworkRegistry (shared object)
 * @param cpReg - objectId of ControlPlaneRegistry (shared object)
 * @param state - objectId of QuorumConfigState (shared object)
 * @param qs - QuorumSig value to be verified
 * @param pubkeys - ed25519 public keys parallel to qs.signers (off-chain look-up per D-001)
 * @param msg - raw message bytes that were signed
 */
export declare function verifyQuorum(
  netReg: string,
  cpReg: string,
  state: string,
  qs: QuorumSig,
  pubkeys: number[][],
  msg: number[],
): Promise<boolean>;

/**
 * `public fun update_threshold(_: &AdminCap, net_reg, state, new_threshold, updater)`
 * Updates the M-of-N minimum. Emits QuorumConfigUpdated. AdminCap-gated.
 * @param adminCap - objectId of the AdminCap
 * @param netReg - objectId of NetworkRegistry
 * @param state - objectId of QuorumConfigState (mutable)
 * @param newThreshold - new minimum signature count (u64 as bigint)
 * @param updater - address of the entity requesting the update
 */
export declare function updateThreshold(
  adminCap: string,
  netReg: string,
  state: string,
  newThreshold: bigint,
  updater: string,
): Promise<void>;

/**
 * `public fun min_quorum(state: &QuorumConfigState): u64`
 * Pure accessor — safe to call via devInspect (no gas).
 */
export declare function minQuorum(state: string): Promise<bigint>;

/**
 * `public fun signers(qs: &QuorumSig): &vector<address>`
 * Pure accessor — returns the signers slice of a QuorumSig value.
 */
export declare function signers(qs: QuorumSig): string[];

/**
 * `public fun signatures(qs: &QuorumSig): &vector<vector<u8>>`
 * Pure accessor — returns the raw signatures slice.
 */
export declare function signatures(qs: QuorumSig): number[][];

// ── § Phase 1.2 — Capability event types (BCS field order frozen S53) ─────────
//
// Field order in each interface follows the Move struct declaration order
// (BCS serialisation order). DO NOT reorder — see D-002 BCS field ordering.
//
// Phase 2.x wrappers (RoomCapabilityIssued, etc.) extend these types by
// adding wrapper fields; they do NOT modify these base interfaces.

/**
 * Mirrors `CapabilityIssued { token_id, room_id, peer_pubkey, role, issuer_quorum, expires_epoch }`.
 * Emitted when a new capability token is issued to a peer. Phase 2.1+ consumers subscribe
 * to this event from the `capability_events` module.
 */
export interface CapabilityIssuedEvent {
  /** On-chain token ID (Sui UID object ID, 0x-prefixed hex). */
  tokenId: string;
  /** Room the token grants access to. */
  roomId: string;
  /** ed25519 public key of the peer being granted access (32 bytes for ed25519, per D-OQ-ADM-3). */
  peerPubkey: number[];
  /** Role byte: relay=2, signaling=4, CP=3, validator=1 (matches MinerRole constants). */
  role: number;
  /** CP operator addresses that co-signed the issuance (M-of-N quorum). */
  issuerQuorum: string[];
  /** Sui epoch at which the token expires. u64 as string. */
  expiresEpoch: string;
}

/**
 * Mirrors `CapabilityRevoked { token_id, room_id, revoker_quorum, reason }`.
 * Emitted when a capability token is revoked. Signaling daemon listens to invalidate cache.
 *
 * `reason` encoding (informational only, not enforced on-chain per D-002):
 *   0 = normal   (voluntary / room closed)
 *   1 = slash    (triggered by relay/validator slash event)
 *   2 = admin    (AdminCap emergency override)
 *   Future: 3=turn-revoked, 4=secret-rotated (F5/F8 extension scope, additive safe)
 */
export interface CapabilityRevokedEvent {
  tokenId: string;
  roomId: string;
  /** CP operator addresses that co-signed the revocation. */
  revokerQuorum: string[];
  /** Revocation reason byte (see encoding above). */
  reason: number;
}

/**
 * Mirrors `CapabilityRefreshed { token_id, room_id, peer_pubkey, old_expires_epoch, new_expires_epoch, refresher_quorum }`.
 * Emitted when a token's expiry is extended (role-change grace window or 60s sliding TTL refresh).
 * F47 cooldown updates daemon listens for role-change grace window.
 */
export interface CapabilityRefreshedEvent {
  tokenId: string;
  roomId: string;
  peerPubkey: number[];
  /** Previous expiry epoch. u64 as string. */
  oldExpiresEpoch: string;
  /** New extended expiry epoch. u64 as string. */
  newExpiresEpoch: string;
  /** CP operator addresses that co-signed the refresh. */
  refresherQuorum: string[];
}

// ── § Phase 1.2 — Error code constants (namespace 900-908, frozen S53) ────────

/**
 * Error codes for the capability-token subsystem base layer (`capability_errors` module).
 * Numeric values frozen S53. Phase 2.x room-specific codes use 909-915 range.
 * Accessed via `capability_errors::e_*()` accessors on-chain; this mirror is for off-chain use.
 */
export const CAPABILITY_ERRORS = {
  /** Token ID not found in on-chain registry. */
  E_TOKEN_NOT_FOUND: 900,
  /** Token's expires_epoch is in the past; re-issue required. */
  E_TOKEN_EXPIRED: 901,
  /** Token has been explicitly revoked (revoked == true). */
  E_TOKEN_REVOKED: 902,
  /** Token's room_id does not match the room the peer is joining. */
  E_TOKEN_ROOM_MISMATCH: 903,
  /** Token's peer_pubkey does not match the connecting peer's ed25519 key. */
  E_TOKEN_PEER_MISMATCH: 904,
  /** Aggregate signature attached to the token failed ed25519 verification. */
  E_TOKEN_SIG_INVALID: 905,
  /** CP-quorum signer count < configured minimum (M-of-N not met for this token). */
  E_TOKEN_QUORUM_INSUFFICIENT: 906,
  /** Revocation attempted but token is already revoked (idempotency guard per D-002). */
  E_TOKEN_ALREADY_REVOKED: 907,
  /** Anti-replay: nonce already consumed; re-presenting a used proof. */
  E_REPLAY_NONCE_USED: 908,
  // 909-915: reserved for Phase 2.x room_capability.move (room-specific codes)
} as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERRORS)[keyof typeof CAPABILITY_ERRORS];

/** Discriminated union of all Phase 1.2 base capability events. */
export type CapabilityEvent =
  | CapabilityIssuedEvent
  | CapabilityRevokedEvent
  | CapabilityRefreshedEvent;

/** All cap-token primitive events (Phase 1.1 + Phase 1.2 combined). */
export type CapTokenPrimitiveEvent = QuorumSigEvent | CapabilityEvent;
