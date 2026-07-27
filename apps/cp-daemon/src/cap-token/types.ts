/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer (cp-daemon module) — shared types.
 *
 * Split out of the former monolithic `cap-token-issuer.ts` (god-file split). This
 * file carries the DI shapes + event payload shapes + issuer options consumed by
 * `./issuer.js`, `./bootstrap.js`, and every caller across the daemon.
 *
 * Spec sources:
 *   - CONTRACTS.md § 4.4 (interface)
 *   - SEQUENCES.md § 1 (issuance) + § 4 (revoke) + § 3 (refresh future)
 *   - DECISIONS.md § D-010-A (real event names) + § D-B4 (M=2/N=3 default)
 */
import type { Logger, QuorumSig } from '@dvconf/shared';
import type { InfraPeerPubkeyCache } from './infra-peer-recovery.js';

// ── Cache wiring (Stage 4 Item #3) ───────────────────────────────────────

/**
 * Loose-coupling shape of `CapTokenCache.emergencyInvalidate` (Stage 4 Item #3,
 * sibling lane-cache D-013). The issuer constructor accepts this optional
 * dependency to avoid importing across the file-ownership boundary into
 * `apps/signaling/src/cap-token-cache.ts`. When `undefined`, the canonical
 * chain-event-driven invalidation path satisfies REQ-ADM-005 ≤5s steady-state
 * eviction; cache fast-path is a sub-second optimization per D-012 Addendum.
 */
export interface CapTokenCacheLike {
  emergencyInvalidate(tokenId: string, reason: string): void;
}

// ── Submit DI ────────────────────────────────────────────────────────────

export interface SubmitResult {
  digest: string;
}

export interface SubmitFn {
  (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult>;
}

// ── Keystore abstraction ─────────────────────────────────────────────────

export interface CpKeystore {
  /** Sign an arbitrary canonical message with the local CP key. */
  sign(message: Uint8Array): Promise<{ signature: number[]; pubkey: number[]; addr: string }>;
  /** Local CP's Sui operator address. */
  getCpAddress(): string;
  /**
   * Collect at least `threshold` signatures over `canonicalMsg` from peer CP nodes
   * (M-of-N quorum, REQ-ADM-003, D-B4 default M=2/N=3). Throws if quorum cannot be
   * assembled within the implementation-defined timeout — caller treats the throw as
   * "issuance temporarily unavailable" and logs an error.
   *
   * Returns:
   *   - `qs`            : the QuorumSig struct (signers + signatures parallel arrays)
   *   - `pubkeys`       : ed25519 pubkeys parallel to qs.signers (D-001 pattern)
   *   - `aggregateSig`  : BCS-serialized QuorumSig blob — stored on-chain in the
   *                       minted/refreshed RoomCapability's `aggregate_sig` field
   *                       for off-chain audit replay. D-011 (S54): Move issue +
   *                       refresh entries both take this as a separate `vector<u8>`
   *                       param; revoke does NOT.
   */
  collectQuorumSignatures(
    canonicalMsg: Uint8Array,
    threshold: number,
  ): Promise<{ qs: QuorumSig; pubkeys: number[][]; aggregateSig: number[] }>;
}

// ── Event payload shapes (real Move struct names per D-010-A / CONTRACTS § 4.6) ──

export interface RoomAssignedEvent {
  roomId: string;
  relayIds: string[];
  signalingId: string;
  relayMode: number;
  verifiedScore: string;
  consensusReached: boolean;
  winningCp: string;
  validatorIds: string[];
}

export interface RoleChangedEvent {
  minerId: string;
  oldRole: number;
  newRole: number;
  newStake: string;
  /**
   * Phase 3.4: optional active-token ID for the affected (room, peer) pair. When
   * provided, the issuer schedules a refresh against this specific token after
   * the grace window. When absent, the issuer dedupes + logs only (Phase 3.1 path
   * preserved for back-compat with onRoleChanged test fixtures lacking this field).
   * Production-wired callers populate this from chain devInspect; tests inject
   * directly via the `rcWithToken` helper.
   */
  affectedTokenId?: string;
  /** Phase 3.4: room the affected token belongs to. Required when affectedTokenId is set. */
  roomId?: string;
  /** Phase 3.4: peer-pubkey for the affected token, 32-byte ed25519. Required when affectedTokenId is set. */
  peerPubkey?: number[];
}

export interface RoleAssignedEvent {
  minerId: string;
  role: number;
  voteCount: string;
  threshold: string;
  /** Phase 3.4: see RoleChangedEvent.affectedTokenId. */
  affectedTokenId?: string;
  roomId?: string;
  peerPubkey?: number[];
}

export interface RelaySlashedEvent {
  roomId: string;
  relayMinerId: string;
  slashAmount: string;
}

/**
 * Phase 3.4 REQ-ADM-015 — emergency rotation event. Trigger: external (e.g. F8
 * secret-rotation cluster or operator-initiated key revocation). Bypasses the
 * 60s grace timer used for routine role-change refresh. Dedupe key derived from
 * `peerPubkey` hex prefix so the same emergency cannot be re-driven by event
 * replay.
 */
export interface EmergencyRotationEvent {
  /** 32-byte ed25519 pubkey of the affected peer. */
  peerPubkey: number[];
  /** Human-readable rotation reason (e.g. 'leaked-key', 'turn-revoked'). Logged at WARN. */
  reason: string;
  /** Sui object ID of the token being rotated out. */
  oldTokenId: string;
  /** Room scope. */
  roomId: string;
  /** New role to mint with (typically same as current role for emergency rotations). */
  role: number;
}

// ── Options ────────────────────────────────────────────────────────────

export interface CapTokenIssuerOpts {
  submitFn: SubmitFn;
  packageId: string;
  networkRegistryId: string;
  cpRegistryObjectId: string;
  quorumStateObjectId: string;
  cpKeystore: CpKeystore;
  logger: Logger;
  /** M-of-N threshold (D-B4 default M=2). */
  quorumThreshold?: number;
  /** Phase 3.4 grace window before role-change refresh fires. Default 60_000 per REQ-ADM-014. */
  graceMs?: number;
  /**
   * Stage 4 Item #3 — optional cache for emergency-rotation fast-path eviction.
   * When defined, `onEmergencyRotation` calls `cache.emergencyInvalidate(oldTokenId, ...)`
   * BEFORE submitting the rotation TX (per D-012 Addendum). When `undefined`, the
   * canonical `CapabilityRevoked` chain-event path still satisfies REQ-ADM-005 ≤5s
   * eviction in steady state — the fast-path is a sub-second optimization.
   */
  cache?: CapTokenCacheLike;
  /**
   * F62 M2 W-P2 (D-W7) — live-epoch source for token expiry. When provided, fresh
   * tokens expire at `getCurrentEpoch() + DEFAULT_EXPIRES_OFFSET_EPOCHS`; read lazily
   * at submit time so a cached-epoch refresher (wired in startCapTokenIssuer) keeps
   * expiries current. When `undefined` (e.g. unit tests), `currentEpoch` resolves to
   * 0 → the legacy 100-epoch offset is preserved (back-compat).
   */
  getCurrentEpoch?: () => bigint;
  /**
   * Leg 7c (G3) — the infra-peer pubkey recovery cache, fed off the event-handler
   * `CapabilityIssued` observer. When provided, `submitIssue`'s INFRA-peer path (no
   * `sessionPubkeyB64`) recovers the REAL 32-byte key via `recoverInfraPeerClaim` BEFORE the
   * legacy `resolvePeerPubkey` miner-id placeholder (which is NOT 32 bytes → would abort the
   * Move mint `E_PUBKEY_WRONG_LENGTH` (916)). A recovery MISS → fail-closed SKIP + debug-log
   * (never a malformed mint). When `undefined` (single-CP / legacy callers), `submitIssue`
   * uses `resolvePeerPubkey` unchanged. The E2EE `sessionPubkeyB64` branch is NEVER routed
   * through recovery.
   */
  infraPeerCache?: InfraPeerPubkeyCache;
}
