/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer (cp-daemon module).
 *
 * Issues + revokes RoomCapability tokens in response to chain events:
 *   - room_manager::RoomAssigned   → issue tokens to each peer in the room
 *   - miner::registration::RoleChanged → trigger refresh (Phase 3.4 grace timer; here stub-stage)
 *   - role_voting::RoleAssigned    → trigger refresh on vote consensus
 *   - economic_layer::RelaySlashed → bulk-revoke tokens for the slashed relay
 *
 * NOTE (F8 / REQ-CRR-005): the `turn_credential::SecretRotated` emergency event
 * is NOT handled here. It rotates the TURN shared SECRET (orthogonal to the
 * RoomCapability admission token — ADR-0010 D-009), so its daemon reaction lives
 * in the TURN issuer kill-switch (`event-handler.ts` → `turn-issuer.ts`
 * `emergencyEvictSecret`), not in this cap-token module.
 *
 * Spec sources:
 *   - CONTRACTS.md § 4.4 (interface)
 *   - SEQUENCES.md § 1 (issuance) + § 4 (revoke) + § 3 (refresh future)
 *   - DECISIONS.md § D-010-A (real event names) + § D-B4 (M=2/N=3 default)
 *
 * Implementation conventions (match existing cp-daemon modules — turn-issuer pattern):
 *   - SubmitFn DI for tests (production wires to executeWithRetry)
 *   - In-memory dedupe Set, key per handler per § 4.4
 *   - Structured JSON logging via pino: { trace_id, module: 'cap-token-issuer', context }
 *   - Errors absorbed (logger.error) — daemon must remain alive across retryable failures
 */
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, QuorumSig } from '@dvconf/shared';
import type { CpOperator } from './sui-chain-state-reader.js';

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

// ── Options + class ──────────────────────────────────────────────────────

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
}

/**
 * Default expiry window for fresh tokens — Sui epoch-units. Picked above
 * MIN_REMAINING_EPOCHS=5 (per D-007-A precedent) with comfortable headroom
 * so the late-join window in `verify_capability_token` is not crossed.
 */
const DEFAULT_EXPIRES_OFFSET_EPOCHS = 100n;

// ── F62 Stage 4 Item #6 — BCS canonical-message encoders ────────────────
//
// Move SOT: `dvconf-contracts/sources/security/room_capability.move`:
//   issue   §  473-482  : id_to_bytes(room_id) || peer_pubkey || role(u8)
//                          || bcs_u64_le(expires) || bcs_u64_le(nonce)
//   revoke  §  603-605  : id_to_bytes(cap_id)  || reason(u8)
//   refresh § 1009-1016 : id_to_bytes(old_id)  || new_role(u8)
//                          || bcs_u64_le(new_expires) || bcs_u64_le(refresh_nonce)
//
// Move's `vector::append` is raw concatenation with NO length prefix; Move's
// `bcs_u64_le` emits 8 little-endian bytes (room_capability.move:665-673).
// `object::id_to_bytes` produces the raw 32-byte ID. The encoders below match
// byte-for-byte; the `bcs-equivalence.test.ts` fixture pins the contract.
//
// D-014 defense narrative: a hand-rolled raw-concat encoder is the defensible
// choice because the Move chain is NOT BCS-struct-serializing (no length
// prefixes; no struct framing). Using `@mysten/sui/bcs` `bcs.struct({...})`
// would prepend ULEB128 length tags on the vector fields and produce different
// bytes — daemon would sign one payload, Move would verify against another,
// quorum check would silently reject. The raw concat path mirrors Move
// 1-to-1; the byte-equivalence test in `bcs-equivalence.test.ts` is the
// forcing function against future drift.

/** Decode a 0x-prefixed (or raw) hex string into 32 raw bytes (Move `object::id_to_bytes` shape). */
function hexToBytes(s: string): number[] {
  const cleaned = s.startsWith('0x') ? s.slice(2) : s;
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

/**
 * REQ-MCS-012 (W5 M2 P1.0) — resolve the admission `peer_pubkey` value.
 *
 * CONTRACTS §0 (D-M2-16) / the F62 deferred-wiring gap (`:629-638`): the issuer
 * historically put the Sui miner-ID hex at the `peer_pubkey` position as a
 * structural placeholder. For the E2EE path the value MUST instead be the
 * client's in-browser ed25519 SESSION pubkey (so the on-chain
 * `RoomCapability.peer_pubkey` IS the client's session key → it lives in the
 * `capability_events` transparency log and is the sealed-box recipient).
 *
 * Additive: when `sessionPubkeyB64` is present it is decoded (base64, must be
 * exactly 32 bytes = ed25519); when absent the legacy miner-ID hex decode is
 * preserved unchanged. 0 Move change — `room_capability.move:198-201` only
 * length-checks the 32-byte field, which BOTH shapes satisfy.
 *
 * Throws on a malformed session pubkey (wrong length / non-base64) rather than
 * silently falling back — an E2EE join with a bad provenance key must fail loud,
 * not be admitted under a stale placeholder.
 */
export function resolvePeerPubkey(peer: {
  id: string;
  /** base64 of the client's 32-byte ed25519 session pubkey (E2EE path); absent ⇒ legacy. */
  sessionPubkeyB64?: string;
}): number[] {
  if (peer.sessionPubkeyB64 === undefined) {
    // Legacy infrastructure-peer path (F62): miner-ID hex placeholder, unchanged.
    return hexToBytes(peer.id);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(peer.sessionPubkeyB64, 'base64');
  } catch (err) {
    throw new Error(`peer_pubkey: session pubkey is not valid base64: ${String(err)}`);
  }
  // Buffer.from(base64) is lenient (drops invalid chars), so a non-base64 input
  // usually surfaces here as a wrong-length decode rather than a throw above.
  if (decoded.length !== 32) {
    throw new Error(
      `peer_pubkey: session pubkey must decode to 32 bytes (ed25519), got ${decoded.length}`,
    );
  }
  return Array.from(decoded);
}

/** Encode a u64 as 8 little-endian bytes (mirrors Move's `bcs_u64_le` helper). */
function u64Le(v: bigint): number[] {
  const out: number[] = [];
  let x = v;
  for (let i = 0; i < 8; i++) {
    out.push(Number(x & 0xffn));
    x >>= 8n;
  }
  return out;
}

/**
 * Build the canonical ISSUE payload that CP-quorum signs off-chain. Matches Move
 * `room_capability::issue_capability_token` raw byte concat at lines 473-482.
 *
 * Layout (in order): id_to_bytes(room_id) || peer_pubkey || role(u8)
 *                    || bcs_u64_le(expires_epoch) || bcs_u64_le(nonce)
 */
export function buildIssueCanonicalMsg(opts: {
  roomId: string;
  peerPubkey: number[];
  role: number;
  expiresEpoch: bigint;
  nonce: number;
}): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...hexToBytes(opts.roomId));
  bytes.push(...opts.peerPubkey);
  bytes.push(opts.role & 0xff);
  bytes.push(...u64Le(opts.expiresEpoch));
  bytes.push(...u64Le(BigInt(opts.nonce)));
  return new Uint8Array(bytes);
}

// ── Multi-CP quorum Leg 2 (G1) — attest predicate ──────────────────────────
//
// DESIGN-connection-arch.md G1: the off-chain M-of-N collection is only meaningful
// if every CP that contributes a signature INDEPENDENTLY re-derived + policy-validated
// the canonical ISSUE message it signs. Without this gate a malicious issuer could
// collect M genuine signatures over byte-valid bytes that NO honest CP independently
// validated, `cp_quorum_sig::verify_quorum` would pass, and a wrong-token mint would
// succeed. This mirrors the SHAPE of canary `attestIfIndependentlyObserved`
// (validator-daemon claim-board.ts:140-156) — re-derive + predicate + self-sign-or-null
// — with a CAP-TOKEN predicate (re-derive via the FROZEN buildIssueCanonicalMsg +
// policy-validate) instead of canary's independently-observed predicate.
//
// ADDITIVE: `buildIssueCanonicalMsg` (above) is called VERBATIM and never edited.

/**
 * The board-cell CLAIM for a multi-CP cap-token ISSUE: the identifying ISSUE fields
 * + `canonicalMsgHex` (G4) so a CP fast-rejects a cell whose bytes it cannot reproduce
 * BEFORE signing. The `kind` discriminator (Leg 5 generic board) tags the cell on the
 * shared `/quorum/claims` carrier.
 */
export interface CapTokenIssueClaim {
  /** Cell kind discriminator (Leg 5 generic board). */
  kind: 'captoken-issue';
  /** 0x-prefixed (or raw) 32-byte room object id (Move id_to_bytes shape). */
  roomId: string;
  /** 32-byte ed25519 infra/session peer pubkey (G3 — resolved BEFORE the cell opens). */
  peerPubkey: number[];
  /** MinerRole enum (0=user, 1=validator, 2=relay, 3=CP, 4=signaling). */
  role: number;
  /** Sui epoch the minted token expires at. */
  expiresEpoch: bigint;
  /** Per-(room,peer) monotonic nonce (D-010-B starts at 1). */
  nonce: number;
  /**
   * G4 — lowercase hex (no 0x) of the canonical ISSUE bytes the POSTER claims. Each
   * CP re-derives the same bytes from the identifying fields and fast-rejects on any
   * mismatch BEFORE signing (a peer_pubkey-recovery disagreement degrades fail-closed,
   * never a wrong-token issuance).
   */
  canonicalMsgHex: string;
}

/**
 * One CP's self-attestation over a cap-token ISSUE claim — the unit a board accrues.
 * RAW 64-byte ed25519 signature (NO Sui intent-wrap — matches the single-CP branch
 * index.ts:138-152 + makeSingleCpKeystore, OQ-CRR-9; intent-wrap fails Move
 * `verify_quorum`, abort 906). Carries the operator `addr` column the assembler (Leg 4
 * G2) emits into `qs.signers`, parallel to `pubkey`/`signature`.
 */
export interface CapTokenIssueAttestation {
  /** RAW 64-byte ed25519 signature over buildIssueCanonicalMsg(claim). */
  signature: number[];
  /** Signer's 32-byte raw ed25519 pubkey. */
  pubkey: number[];
  /** Signer's Sui operator address (the F-01 dedup / `is_operator_registered` column). */
  addr: string;
}

/** Valid MinerRole enum values (room_capability.move). */
const VALID_MINER_ROLES = new Set<number>([0, 1, 2, 3, 4]);

/**
 * G1 attest predicate — re-derive the canonical ISSUE message from the cell CLAIM's
 * identifying fields via the FROZEN `buildIssueCanonicalMsg`, POLICY-VALIDATE
 * (room/role/expiry/nonce/pubkey bounds), and self-sign with RAW ed25519 ONLY on a
 * local byte-match (G4) + policy-pass. Returns `null` otherwise — FAIL-CLOSED, NO
 * signature on a byte-mismatch or policy-fail (a CP can never be coerced into signing
 * bytes it could not independently reproduce + validate).
 *
 * Mirrors the SHAPE of canary `attestIfIndependentlyObserved`; the predicate differs:
 * here it is "re-derive byte-match + policy-valid" (vs canary "independently observed").
 *
 * @param claim       the board cell claim (identifying fields + poster's canonicalMsgHex)
 * @param selfSigner  this CP's ed25519 keypair (RAW-sign, single-CP-branch shape)
 * @param opts.currentEpoch  optional live epoch for the expiry check; when omitted the
 *                           expiry bound is enforced only as `expiresEpoch > 0`.
 */
export async function rebuildCanonicalAndSignIfMatches(
  claim: CapTokenIssueClaim,
  selfSigner: Ed25519Keypair,
  opts?: { currentEpoch?: bigint },
): Promise<CapTokenIssueAttestation | null> {
  // ── POLICY-VALIDATE (fail-closed, in order) ──────────────────────────────
  // roomId must decode to exactly 32 bytes (Move id_to_bytes / E_PUBKEY_WRONG_LENGTH
  // sibling — a malformed room id can never address a real room).
  const roomBytes = hexToBytes(claim.roomId);
  if (roomBytes.length !== 32) return null;
  // peer_pubkey must be a 32-byte ed25519 key (room_capability.move:200,504 length-check).
  if (!Array.isArray(claim.peerPubkey) || claim.peerPubkey.length !== 32) return null;
  // role must be a known MinerRole.
  if (!VALID_MINER_ROLES.has(claim.role)) return null;
  // expiry must be in the future (reject already-expired tokens). When a live epoch is
  // supplied, expiresEpoch must strictly exceed it; otherwise enforce expiresEpoch > 0.
  if (opts?.currentEpoch !== undefined) {
    if (claim.expiresEpoch <= opts.currentEpoch) return null;
  } else if (claim.expiresEpoch <= 0n) {
    return null;
  }
  // nonce must be the D-010-B monotonic counter (>= 1) and a safe integer.
  if (!Number.isSafeInteger(claim.nonce) || claim.nonce < 1) return null;

  // ── RE-DERIVE via the FROZEN builder (called verbatim) ────────────────────
  const canonical = buildIssueCanonicalMsg({
    roomId: claim.roomId,
    peerPubkey: claim.peerPubkey,
    role: claim.role,
    expiresEpoch: claim.expiresEpoch,
    nonce: claim.nonce,
  });

  // ── G4 byte-match: the CP must reproduce the poster's claimed bytes EXACTLY ─
  if (bytesToHex(Array.from(canonical)) !== claim.canonicalMsgHex.toLowerCase()) {
    return null;
  }

  // ── Self-sign RAW ed25519 (single-CP branch shape; NO intent-wrap) ─────────
  const sig = await selfSigner.sign(canonical);
  return {
    signature: Array.from(sig.slice(0, 64)),
    pubkey: Array.from(selfSigner.getPublicKey().toRawBytes()),
    addr: selfSigner.toSuiAddress(),
  };
}

// ── Multi-CP quorum Leg 3 (G3) — infra-peer pubkey recovery ─────────────────
//
// DESIGN-connection-arch.md G3 + ROADMAP Leg 3: a REAL multi-CP cap-token issue must
// sign over the REAL 32-byte infra-peer ed25519 key, NOT the placeholder
// `resolvePeerPubkey`'s infra path returns (`hexToBytes(peer.id)` = the Sui miner-id hex,
// which is NOT 32 bytes for an arbitrary miner id → the Move mint aborts
// `E_PUBKEY_WRONG_LENGTH` = 916, room_capability.move:200/504).
//
// The recovery source is the FROZEN `CapabilityIssued.peer_pubkey` event field
// (capability_events.move:67-74): when a token was previously issued for this
// (room, peer) the event carries the real 32-byte key. The cp-daemon caches that
// field off its event stream (fed from the event-handler RoomAssigned arm /
// CapabilityIssued observer) and the recovery helper looks it up BEFORE the canonical
// message is built. The cell CLAIM carries the recovered 32 bytes + `canonicalMsgHex`
// (G4) so every CP signs byte-identical bytes.
//
// FAIL-CLOSED (the crux): no cached event OR a non-32-byte recovered value (e.g. the
// miner-id placeholder leaking into the field) yields `null` — no quorum, no cell — so a
// wrong-length key NEVER reaches the Move mint (no 916 abort).
//
// ADDITIVE: `resolvePeerPubkey` (242-265) is UNCHANGED; the Move devInspect getter stays
// explicitly DEFERRED (event-cache path only, per ROADMAP Leg 3); `buildIssueCanonicalMsg`
// is called VERBATIM for the G4 hex.

/**
 * Loose-coupling shape of the on-chain `CapabilityIssued` event payload the cp-daemon
 * observes (capability_events.move:67-74 / `@dvconf/shared` `CapabilityIssuedEvent`). Only
 * the fields the recovery cache needs are declared so the issuer module does not import
 * across the shared-interface boundary for a cache-feed shape.
 */
export interface CapabilityIssuedLike {
  /** On-chain token id (unused by the cache; declared for shape compatibility). */
  tokenId?: string;
  /** Room the token grants access to (cache key part 1). */
  roomId: string;
  /** The real 32-byte ed25519 infra/session peer pubkey (the value being recovered). */
  peerPubkey: number[];
  /** MinerRole byte (unused by the cache; declared for shape compatibility). */
  role?: number;
  /** Sui epoch the token expires at, as a string (unused by the cache). */
  expiresEpoch?: string;
}

/**
 * In-memory recovery cache: `(roomId, peerId)` → the real 32-byte infra-peer ed25519 key,
 * fed from `CapabilityIssued` chain events the cp-daemon observes (G3). Additive sibling to
 * the issuer's other in-memory maps (seenKeys/nonces) — populated off the event-handler
 * RoomAssigned-arm / CapabilityIssued observer, read by `recoverInfraPeerClaim` BEFORE a
 * multi-CP cell opens.
 *
 * Defensive: a non-32-byte `peer_pubkey` in an observed event is REJECTED at insert time
 * (a malformed event can never poison the cache into yielding a wrong-length key that would
 * abort the Move mint with 916).
 */
export class InfraPeerPubkeyCache {
  /** `${roomId}::${peerId}` → 32-byte ed25519 pubkey. */
  private readonly byRoomPeer = new Map<string, number[]>();

  /** Cache key — namespaced by (room, peer) so two rooms can hold the same peer id. */
  private static cellKey(roomId: string, peerId: string): string {
    return `${roomId}::${peerId}`;
  }

  /**
   * Observe a `CapabilityIssued` event and cache its 32-byte `peer_pubkey` against
   * `(event.roomId, peerId)`. A non-32-byte `peer_pubkey` is dropped (defensive — never
   * cache a value that would abort the Move mint).
   */
  observeCapabilityIssued(peerId: string, event: CapabilityIssuedLike): void {
    if (!Array.isArray(event.peerPubkey) || event.peerPubkey.length !== 32) {
      return; // reject malformed — never poison the cache
    }
    this.byRoomPeer.set(
      InfraPeerPubkeyCache.cellKey(event.roomId, peerId),
      Array.from(event.peerPubkey),
    );
  }

  /** Recover the cached 32-byte key for `(roomId, peerId)`, or `undefined` if unseen. */
  get(roomId: string, peerId: string): number[] | undefined {
    const v = this.byRoomPeer.get(InfraPeerPubkeyCache.cellKey(roomId, peerId));
    return v ? Array.from(v) : undefined;
  }
}

/**
 * G3 recovery — build a multi-CP ISSUE cell CLAIM from the REAL 32-byte infra-peer key
 * recovered out of the `InfraPeerPubkeyCache`, populating `peerPubkey` + `canonicalMsgHex`
 * (G4) via the FROZEN `buildIssueCanonicalMsg` BEFORE the canonical message is built.
 *
 * FAIL-CLOSED: returns `null` (no quorum / no cell) when the cache holds nothing for
 * `(roomId, peerId)` OR the recovered value is not exactly 32 bytes — so a wrong-length key
 * (e.g. the `resolvePeerPubkey` miner-id placeholder) can NEVER reach the Move mint and
 * abort `E_PUBKEY_WRONG_LENGTH` (916). `resolvePeerPubkey` is NOT called here (its infra
 * path is the very placeholder this recovery REPLACES for multi-CP).
 *
 * @param fields  the cell's identifying ISSUE fields + the `peerId` (Sui miner id) used as
 *                the recovery key.
 * @param cache   the `InfraPeerPubkeyCache` fed from observed `CapabilityIssued` events.
 */
export function recoverInfraPeerClaim(
  fields: {
    roomId: string;
    /** Sui miner id of the infra peer (the recovery key — NOT signed as the pubkey). */
    peerId: string;
    role: number;
    expiresEpoch: bigint;
    nonce: number;
  },
  cache: InfraPeerPubkeyCache,
): CapTokenIssueClaim | null {
  const recovered = cache.get(fields.roomId, fields.peerId);
  // FAIL-CLOSED: nothing cached, or the recovered value is not a 32-byte ed25519 key.
  if (!recovered || recovered.length !== 32) {
    return null;
  }
  const canonical = buildIssueCanonicalMsg({
    roomId: fields.roomId,
    peerPubkey: recovered,
    role: fields.role,
    expiresEpoch: fields.expiresEpoch,
    nonce: fields.nonce,
  });
  return {
    kind: 'captoken-issue',
    roomId: fields.roomId,
    peerPubkey: recovered,
    role: fields.role,
    expiresEpoch: fields.expiresEpoch,
    nonce: fields.nonce,
    canonicalMsgHex: bytesToHex(Array.from(canonical)),
  };
}

// ── Multi-CP quorum Leg 4 (G2) — quorum assembler ──────────────────────────
//
// DESIGN-connection-arch.md G2 + ROADMAP Leg 4: take the cell CLAIM + the accrued CP
// self-attestations (Leg-2 `rebuildCanonicalAndSignIfMatches` outputs) + the discovered
// active-CP operator set (Leg-1 `getActiveCpOperators`), and emit the EXACT single-CP
// shape `{ qs:{signers,signatures}, pubkeys, aggregateSig }` (index.ts:147-151) that the
// FROZEN consumer chain accepts UNCHANGED:
//   submitIssue → makeCapTokenSubmitter → buildIssueCapTokenTx → Move
//   room_capability::issue_capability_token → cp_quorum_sig::verify_quorum.
//
// `verify_quorum` (cp_quorum_sig.move:129-192) iterates the THREE index-aligned arrays in
// lock-step: `qs.signers[i]` (operator ADDRESS — F-01 VecSet dedup-by-address +
// is_operator_registered) · `qs.signatures[i]` (RAW 64-byte sig) · `pubkeys[i]` (32-byte
// ed25519 key — passed as a SEPARATE parallel arg, NOT a QuorumSig field). The assembler
// emits the columns INDEX-ALIGNED in signature/attestation order, matching the single-CP
// branch shape at index.ts:148.
//
// FAIL-CLOSED (OQ-1): a poster whose pubkey resolves to NO operator in the discovered
// active-CP snapshot (just-joined / stranger) is DROPPED — never a silent index-
// misalignment (it would fail `is_operator_registered` on-chain anyway). The operator
// ADDRESS is resolved from the DISCOVERED snapshot (pubkey→operator), NOT trusted from the
// poster's self-declared `addr`, so a malicious poster cannot inject a foreign address
// column. Registry stores NO CP pubkeys today (Phase-2.x) → the poster's self-declared
// `addr` is the pubkey→address binding, checked for membership against the discovered
// operator set; a binding to an unknown operator is a stranger DROP.
//
// OQ-BUILD-1 (resolved): the on-chain AUTHORITATIVE gate `verify_quorum` consumes ONLY
// `qs`(signers+signatures) + `pubkeys` + `msg` — it NEVER reads `aggregate_sig`.
// `issue_capability_token` (room_capability.move:455,527) stores `aggregate_sig` VERBATIM
// into `RoomCapability.aggregate_sig` for off-chain audit replay; it is never parsed or
// verified on-chain. `aggregate_sig` is therefore VESTIGIAL vs the per-index `pubkeys[]`
// ed25519_verify path. The single-CP branch hardcodes `[0x01, ...sig64]`; the multi-CP
// generalization is `[0x01, ...sig64(0), ...sig64(1), ...]` (the 0x01 version/marker +
// the concatenated RAW sigs in signer order) — a self-describing audit blob a future
// reader splits on the 64-byte boundary. Since it is never on-chain-parsed, this encoding
// is safe by construction; it preserves the single-CP shape (1 signer → byte-identical
// `[0x01, ...sig64]`) and carries every real signature for audit replay.
//
// ADDITIVE: no frozen surface edited; the single-CP branch (index.ts:138-152) and
// `makeCapTokenSubmitter` are UNCHANGED — this assembler simply produces the same shape
// for N>=2 signers that the single-CP branch produces for 1.

/**
 * G2 quorum assembler — fold the accrued CP attestations into the single-CP-shaped
 * `{ qs:{signers,signatures}, pubkeys, aggregateSig }` proof, INDEX-ALIGNED in
 * attestation order, dropping any poster not in the discovered active-CP snapshot
 * (OQ-1 fail-closed).
 *
 * @param _claim         the cell claim (declared for call-site symmetry + future
 *                       per-claim policy hooks; the attestations already carry the bytes
 *                       each CP signed, so no re-derivation happens here).
 * @param attestations   the accrued CP self-attestations (Leg-2 outputs: RAW sig + pubkey
 *                       + self-declared operator addr).
 * @param discoveredCps  the Leg-1 `getActiveCpOperators()` projection — the operator
 *                       ADDRESS set `verify_quorum` requires for `qs.signers`.
 */
export function assembleCapTokenQuorum(
  _claim: CapTokenIssueClaim,
  attestations: CapTokenIssueAttestation[],
  discoveredCps: CpOperator[],
): { qs: QuorumSig; pubkeys: number[][]; aggregateSig: number[] } {
  // Membership set of registered operator addresses (F-01 / is_operator_registered).
  const registeredOperators = new Set<string>(discoveredCps.map((cp) => cp.operator));

  const signers: string[] = [];
  const signatures: number[][] = [];
  const pubkeys: number[][] = [];
  // aggregateSig = [0x01 version/marker, ...concatenated RAW 64-byte sigs in signer order].
  const aggregateSig: number[] = [0x01];

  for (const att of attestations) {
    // OQ-1 FAIL-CLOSED: MEMBERSHIP-GATE the poster's SELF-DECLARED operator addr against
    // the discovered active-CP snapshot. Registry holds no CP pubkeys (Phase-2.x = design
    // -drift #5), so there is NO on-chain pubkey→address oracle — `att.addr` is the poster's
    // self-declared binding and we accept it ONLY if it is a registered operator. A stranger
    // (unknown operator) is DROPPED — never appended, so the three arrays STAY index-aligned.
    // KNOWN LIMITATION (design-deferred, carry to SHIP gate): membership does NOT prove
    // att.pubkey derives att.addr, so a poster could pair its OWN valid sig with a DIFFERENT
    // registered operator's address; on-chain verify_quorum cannot catch this either until
    // the registry stores CP pubkeys. Faithful to the approved design (OQ-1 / drift #5).
    if (!registeredOperators.has(att.addr)) {
      continue;
    }
    signers.push(att.addr);
    signatures.push(att.signature);
    pubkeys.push(att.pubkey);
    aggregateSig.push(...att.signature);
  }

  return {
    qs: { signers, signatures },
    pubkeys,
    aggregateSig,
  };
}

/**
 * Build the canonical REVOKE payload. Matches Move
 * `room_capability::revoke_capability_token_via_quorum` byte concat at lines 603-605.
 *
 * Layout: id_to_bytes(cap_id) || reason(u8)
 */
export function buildRevokeCanonicalMsg(opts: {
  capObjectId: string;
  reason: number;
}): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...hexToBytes(opts.capObjectId));
  bytes.push(opts.reason & 0xff);
  return new Uint8Array(bytes);
}

/**
 * Build the canonical REFRESH payload. Matches Move
 * `room_capability::refresh_capability_token` byte concat at lines 1009-1016.
 *
 * Layout: id_to_bytes(old_token_id) || new_role(u8) || bcs_u64_le(new_expires_epoch)
 *         || bcs_u64_le(refresh_nonce)
 */
export function buildRefreshCanonicalMsg(opts: {
  oldTokenId: string;
  newRole: number;
  newExpiresEpoch: bigint;
  refreshNonce: number;
}): Uint8Array {
  const bytes: number[] = [];
  bytes.push(...hexToBytes(opts.oldTokenId));
  bytes.push(opts.newRole & 0xff);
  bytes.push(...u64Le(opts.newExpiresEpoch));
  bytes.push(...u64Le(BigInt(opts.refreshNonce)));
  return new Uint8Array(bytes);
}

/** Hex-encode a byte vector for use in dedupe keys / nonce-Map keys (no 0x prefix). */
function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Map a relay/signaling/validator address to its Move role enum value used by
 * room_capability.move (matches MinerRole constants in dvconf-contracts).
 *   1 = validator, 2 = relay, 3 = CP, 4 = signaling, 0 = user/default
 */
function roleForPeerKind(kind: 'relay' | 'signaling' | 'validator'): number {
  switch (kind) {
    case 'relay':
      return 2;
    case 'signaling':
      return 4;
    case 'validator':
      return 1;
  }
}

export class CapTokenIssuer {
  private readonly submitFn: SubmitFn;
  private readonly packageId: string;
  private readonly networkRegistryId: string;
  private readonly cpRegistryObjectId: string;
  private readonly quorumStateObjectId: string;
  private readonly keystore: CpKeystore;
  private readonly logger: Logger;
  private readonly threshold: number;
  private readonly graceMs: number;
  /** Idempotency: per-handler dedupe key → seen-flag. Reset only on daemon restart. */
  private readonly seenKeys = new Set<string>();
  /**
   * Phase 3.4 REQ-ADM-013 — anti-replay nonce tracking. Key: `${roomId}::${peerHex}`,
   * value: highest nonce dispatched on a refresh TX for that (room, peer) pair. Initial
   * issuance starts at 1 (per D-010-B); the first refresh stores 1, subsequent refreshes
   * monotonically increment. External invocations submitting a refresh nonce ≤ current
   * are rejected with a nonce-replay WARN log.
   */
  private readonly nonces = new Map<string, number>();
  /**
   * Phase 3.4 REQ-ADM-014 — pending grace timers. Keyed by miner-id (role-change /
   * role-assigned) so that a B→A revert can cancel a prior A→B pending timer via
   * `clearTimeout`. Map entries are cleared when the timer fires OR is cancelled.
   */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  /** Stage 4 Item #3 — optional cache for fast-path emergency invalidation (D-012 Addendum). */
  private readonly cache?: CapTokenCacheLike;
  /** W-P2 (D-W7) — optional live-epoch source; read lazily in resolveExpiresEpoch(). */
  private readonly getCurrentEpoch?: () => bigint;

  constructor(opts: CapTokenIssuerOpts) {
    this.submitFn = opts.submitFn;
    this.packageId = opts.packageId;
    this.networkRegistryId = opts.networkRegistryId;
    this.cpRegistryObjectId = opts.cpRegistryObjectId;
    this.quorumStateObjectId = opts.quorumStateObjectId;
    this.keystore = opts.cpKeystore;
    this.logger = opts.logger;
    this.threshold = opts.quorumThreshold ?? 2;
    this.graceMs = opts.graceMs ?? 60_000;
    this.cache = opts.cache;
    this.getCurrentEpoch = opts.getCurrentEpoch;
  }

  /**
   * W-P2 (D-W7) — resolve a fresh token's expiry epoch. `currentEpoch + offset`,
   * read lazily so the cached-epoch refresher's latest value is used. Falls back
   * to `0 + offset` (the legacy 100n placeholder) when no epoch source is wired.
   */
  private resolveExpiresEpoch(): bigint {
    return (this.getCurrentEpoch?.() ?? 0n) + DEFAULT_EXPIRES_OFFSET_EPOCHS;
  }

  // ── Public handlers ────────────────────────────────────────────────────

  /**
   * REQ-ADM-001 — issue capability tokens to every peer assigned to the room.
   * Dedupe key: `${event.roomId}::pairing-finalize`.
   */
  async onRoomAssigned(event: RoomAssignedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoomAssigned received',
    );

    const dedupeKey = `${event.roomId}::pairing-finalize`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoomAssigned')) return;

    try {
      const peers: Array<{ id: string; role: number }> = [
        ...event.relayIds.map((id) => ({ id, role: roleForPeerKind('relay') })),
        { id: event.signalingId, role: roleForPeerKind('signaling') },
        ...event.validatorIds.map((id) => ({ id, role: roleForPeerKind('validator') })),
      ];

      for (const peer of peers) {
        await this.submitIssue(peer, event.roomId, dedupeKey, traceId);
      }
    } catch (err) {
      this.logger.error(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, err: (err as Error).message },
        },
        'onRoomAssigned failed — quorum collection or TX submit error',
      );
    }
  }

  /**
   * REQ-ADM-013 + REQ-ADM-014 — role-change refresh trigger.
   * Phase 3.4: dedupe + schedule 60s grace timer (cancellable on role-revert) →
   * after grace, invoke `refresh_capability_token` Move entry per CONTRACTS § 4.1
   * (uses aggregate_sig param per D-011). If a prior pending timer exists for the
   * SAME minerId, cancel it (the role change has been superseded — most commonly
   * a B→A revert before the original A→B grace elapsed).
   */
  async onRoleChanged(event: RoleChangedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoleChanged received',
    );

    const dedupeKey = `${event.minerId}::${event.newRole}::role-change`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoleChanged')) return;

    const cancelled = this.cancelPendingGrace(event.minerId, 'role-change', traceId);
    if (cancelled) {
      // Revert detected — both directions cancel each other; do NOT schedule
      // a new grace window. Role has settled back to the prior value before
      // any refresh was needed. REQ-ADM-014 cancel-on-revert semantics.
      return;
    }
    this.scheduleGraceRefresh(
      event.minerId,
      'role-change',
      {
        affectedTokenId: event.affectedTokenId,
        roomId: event.roomId,
        peerPubkey: event.peerPubkey,
        newRole: event.newRole,
      },
      traceId,
    );

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          miner_id: event.minerId,
          new_role: event.newRole,
          grace_ms: this.graceMs,
        },
      },
      'RoleChanged — grace timer scheduled (REQ-ADM-014)',
    );
  }

  /**
   * REQ-ADM-013 — vote consensus on role assignment. Phase 3.4: same grace pattern
   * as onRoleChanged, dedupe key reflects "role-assigned" disambiguator.
   */
  async onRoleAssigned(event: RoleAssignedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoleAssigned received',
    );

    const dedupeKey = `${event.minerId}::${event.role}::role-assigned`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoleAssigned')) return;

    const cancelled = this.cancelPendingGrace(event.minerId, 'role-assigned', traceId);
    if (cancelled) {
      return;
    }
    this.scheduleGraceRefresh(
      event.minerId,
      'role-assigned',
      {
        affectedTokenId: event.affectedTokenId,
        roomId: event.roomId,
        peerPubkey: event.peerPubkey,
        newRole: event.role,
      },
      traceId,
    );

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          miner_id: event.minerId,
          role: event.role,
          grace_ms: this.graceMs,
        },
      },
      'RoleAssigned — grace timer scheduled (REQ-ADM-014)',
    );
  }

  /**
   * REQ-ADM-015 — emergency rotation handler. Bypasses the 60s grace timer entirely;
   * the rotation reason is logged at WARN level with the event payload for audit.
   *
   * Idempotency: dedupe by `${peerHex}::emergency-rotate` so replays of the same
   * emergency event do not re-trigger the refresh + revoke-old pair.
   *
   * C4 Case B: invokes executeRefresh which submits the refresh TX AND a follow-up
   * revoke-old TX (reason=4 refresh-driven) per CONTRACTS § 4.1 + cap-token-cache.ts
   * fast-path eviction requirement (REQ-ADM-005 cross-tie).
   */
  async onEmergencyRotation(event: EmergencyRotationEvent, traceId: string): Promise<void> {
    const peerHex = bytesToHex(event.peerPubkey);
    const dedupeKey = `${peerHex}::emergency-rotate`;

    this.logger.warn(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          reason: event.reason,
          old_token_id: event.oldTokenId,
          room_id: event.roomId,
        },
      },
      'EmergencyRotation received — bypass grace + refresh immediately',
    );

    if (this.markSeenOrSkip(dedupeKey, traceId, 'onEmergencyRotation')) return;

    // Stage 4 Item #3 — D-012 Addendum fast-path: evict the OLD token from the
    // signaling daemon's cache BEFORE submitting the rotation TX so any
    // concurrent WS verify call short-circuits to null even if the chain
    // `CapabilityRevoked` event has not yet landed in the cache via
    // `handleEvent`. Loose-coupling: `cache` is the optional `CapTokenCacheLike`
    // shape from constructor opts — cross-daemon process boundary makes
    // `undefined` an acceptable runtime state (chain-event-driven invalidation
    // still satisfies REQ-ADM-005 ≤5s in steady state).
    if (this.cache) {
      this.cache.emergencyInvalidate(event.oldTokenId, `rotation-${event.reason}`);
      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: {
            dedupe_key: dedupeKey,
            old_token_id: event.oldTokenId,
            cache_reason: `rotation-${event.reason}`,
          },
        },
        'cache fast-path invalidated for emergency rotation',
      );
    }

    await this.executeRefresh(
      {
        oldTokenId: event.oldTokenId,
        roomId: event.roomId,
        peerPubkey: event.peerPubkey,
        newRole: event.role,
      },
      dedupeKey,
      traceId,
    );
  }

  /**
   * REQ-ADM-011 sister — bulk-revoke tokens scoped to a slashed relay's room.
   * Dedupe key: `${event.roomId}::${event.relayMinerId}::slash`.
   */
  async onRelaySlashed(event: RelaySlashedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RelaySlashed received',
    );

    const dedupeKey = `${event.roomId}::${event.relayMinerId}::slash`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRelaySlashed')) return;

    try {
      await this.submitRevoke(event.relayMinerId, dedupeKey, traceId);
    } catch (err) {
      this.logger.error(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, err: (err as Error).message },
        },
        'onRelaySlashed failed — quorum collection or TX submit error',
      );
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  /**
   * Returns true if the dedupe key was already seen (caller skips). Otherwise marks
   * the key and returns false. Idempotency surface for at-least-once event delivery.
   */
  private markSeenOrSkip(dedupeKey: string, traceId: string, handler: string): boolean {
    if (this.seenKeys.has(dedupeKey)) {
      this.logger.warn(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, handler, skipped_reason: 'duplicate-event' },
        },
        'Idempotency hit — skipping duplicate event',
      );
      return true;
    }
    this.seenKeys.add(dedupeKey);
    return false;
  }

  /**
   * Build canonical message, collect M-of-N signatures, submit issue TX.
   * On collectQuorumSignatures throw: re-throw to caller which logs + absorbs.
   */
  private async submitIssue(
    peer: { id: string; role: number; sessionPubkeyB64?: string },
    roomId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const nonce = 1; // first issuance per (room, peer) — monotonic counter per D-010-B starts at 1
    const expiresEpoch = this.resolveExpiresEpoch(); // W-P2 D-W7: live epoch + offset (was 100n placeholder)
    // REQ-MCS-012 (W5 M2 P1.0) — resolve the admission `peer_pubkey`.
    //
    // Legacy (infrastructure peer): `peer.id` is the Sui miner-ID hex string
    // (relay/signaling/validator from the RoomAssigned event); we hex-decode it
    // so the daemon's canonical_msg and Move's canonical_msg agree structurally
    // (Stage 4 Item #6 + D-014). This was the F62 deferred-wiring placeholder.
    //
    // E2EE path (CONTRACTS §0 / D-M2-16): when the client's in-browser ed25519
    // SESSION pubkey is supplied (`peer.sessionPubkeyB64`), it becomes the
    // `peer_pubkey` instead — so the on-chain RoomCapability.peer_pubkey IS the
    // client session key (transparency log + sealed-box recipient). 0 Move
    // change: room_capability.move:198-201 only length-checks the 32-byte field.
    const peerPubkey = resolvePeerPubkey(peer);
    const canonicalMsg = buildIssueCanonicalMsg({
      roomId,
      peerPubkey,
      role: peer.role,
      expiresEpoch,
      nonce,
    });

    const { qs, pubkeys, aggregateSig } = await this.keystore.collectQuorumSignatures(
      canonicalMsg,
      this.threshold,
    );

    const result = await this.submitFn({
      label: 'issue-capability-token',
      args: {
        target: `${this.packageId}::room_capability::issue_capability_token`,
        networkRegistryId: this.networkRegistryId,
        cpRegistryObjectId: this.cpRegistryObjectId,
        quorumStateObjectId: this.quorumStateObjectId,
        roomId,
        peerId: peer.id,
        peerPubkey,
        role: peer.role,
        expiresEpoch,
        nonce,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        // D-011: BCS-serialized QuorumSig blob stored on-chain as the minted
        // RoomCapability's `aggregate_sig` field (Move param 11 between
        // signer_pubkeys and ctx). Aligns TS daemon → Move chain SOT.
        aggregateSig,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'onRoomAssigned',
          tx_digest: result.digest,
          peer_id: peer.id,
          role: peer.role,
        },
      },
      'TX submitted',
    );
  }

  /** Collect quorum for revoke + submit revoke_capability_token_via_quorum TX. */
  private async submitRevoke(
    capObjectId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const reason = 1; // 1 = slash per capability_events.move encoding (D-002)
    const canonicalMsg = buildRevokeCanonicalMsg({ capObjectId, reason });

    const { qs, pubkeys } = await this.keystore.collectQuorumSignatures(
      canonicalMsg,
      this.threshold,
    );

    const result = await this.submitFn({
      label: 'revoke-capability-token-via-quorum',
      args: {
        target: `${this.packageId}::room_capability::revoke_capability_token_via_quorum`,
        networkRegistryId: this.networkRegistryId,
        cpRegistryObjectId: this.cpRegistryObjectId,
        quorumStateObjectId: this.quorumStateObjectId,
        capObjectId,
        reason,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'onRelaySlashed',
          tx_digest: result.digest,
          cap_object_id: capObjectId,
        },
      },
      'TX submitted',
    );
  }

  // ── Phase 3.4 — grace timer + refresh helpers ────────────────────────────

  /**
   * Cancel any pending grace timer for the given minerId. Called BEFORE
   * scheduling a new timer; if a prior timer exists (e.g. previous role-change
   * is being superseded by a revert), `clearTimeout` aborts it and a single
   * INFO log line records the cancellation for operator visibility.
   *
   * The cancel-on-revert mandate (REQ-ADM-014 + briefing) treats any
   * subsequent role-change/role-assigned event for the same minerId as the
   * canonical reverse-direction signal — the issuer does NOT inspect
   * old_role/new_role pairings, since the second event by definition
   * supersedes the first (whatever its direction). This is the safest
   * interpretation: if both events ultimately fire refreshes, the second
   * one's parameters win.
   */
  private cancelPendingGrace(minerId: string, kind: 'role-change' | 'role-assigned', traceId: string): boolean {
    let cancelled = false;
    const timerKey = `${minerId}::${kind}`;
    const existing = this.graceTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      this.graceTimers.delete(timerKey);
      cancelled = true;
      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { timer_key: timerKey, miner_id: minerId, kind },
        },
        'grace timer cancelled — role reverted before 60s window',
      );
    }
    // Also cancel a timer scheduled under the OPPOSITE kind for the same
    // minerId — a role-change can be superseded by a role-assigned and vice
    // versa, per REQ-ADM-014 cancel-on-revert semantics.
    const oppositeKey = `${minerId}::${kind === 'role-change' ? 'role-assigned' : 'role-change'}`;
    const opposite = this.graceTimers.get(oppositeKey);
    if (opposite) {
      clearTimeout(opposite);
      this.graceTimers.delete(oppositeKey);
      cancelled = true;
      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { timer_key: oppositeKey, miner_id: minerId, kind: 'opposite' },
        },
        'grace timer cancelled — role reverted before 60s window',
      );
    }
    return cancelled;
  }

  /**
   * Schedule a refresh that fires after `graceMs`. Only enqueues a real timer
   * when the caller supplied affectedTokenId + roomId + peerPubkey (test
   * fixtures without this context fall through to a log-only path so the
   * existing onRoleChanged-without-token fixture still exercises dedupe).
   */
  private scheduleGraceRefresh(
    minerId: string,
    kind: 'role-change' | 'role-assigned',
    ctx: {
      affectedTokenId?: string;
      roomId?: string;
      peerPubkey?: number[];
      newRole: number;
    },
    traceId: string,
  ): void {
    if (!ctx.affectedTokenId || !ctx.roomId || !ctx.peerPubkey) {
      return;
    }

    const timerKey = `${minerId}::${kind}`;
    const timer = setTimeout(() => {
      this.graceTimers.delete(timerKey);
      // executeRefresh is async; we intentionally do not await here (setTimeout
      // callback is sync). Errors are absorbed inside executeRefresh.
      void this.executeRefresh(
        {
          oldTokenId: ctx.affectedTokenId!,
          roomId: ctx.roomId!,
          peerPubkey: ctx.peerPubkey!,
          newRole: ctx.newRole,
        },
        timerKey,
        traceId,
      );
    }, this.graceMs);
    this.graceTimers.set(timerKey, timer);
  }

  /**
   * Phase 3.4 + C4 inject (Case B). Builds canonical refresh payload, increments
   * the per-(room,peer) nonce, collects M-of-N quorum, submits refresh TX, then
   * follows with a revoke_capability_token_via_quorum TX for the OLD token
   * (reason=4 refresh-driven) so cap-token-cache.ts evicts the stale entry on
   * the next CapabilityRevoked chain event.
   *
   * Case B chosen: Move `refresh_capability_token` (room_capability.move
   * S54 commit `e3780d3`) emits ONLY `CapabilityRefreshed` — it does NOT emit
   * `CapabilityRevoked` for the old token despite mutating `old_token.revoked =
   * true`. cap-token-cache fast-path eviction at lines 156-159 depends on the
   * revoke event. The follow-up TX ensures REQ-ADM-005 ≤5s eviction holds.
   *
   * Defense narrative: chain-as-SOT (Fork 3) — the cache reacts to canonical
   * chain events; we never derive eviction logic from the refresh event
   * payload (which lacks an old-token-id field), so the second TX is the
   * defensible path until Move-side emits both events atomically (post-thesis).
   */
  private async executeRefresh(
    ctx: { oldTokenId: string; roomId: string; peerPubkey: number[]; newRole: number },
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    try {
      const peerHex = bytesToHex(ctx.peerPubkey);
      const nonceKey = `${ctx.roomId}::${peerHex}`;
      const currentNonce = this.nonces.get(nonceKey) ?? 0;
      const nextNonce = currentNonce + 1;

      const newExpiresEpoch = this.resolveExpiresEpoch(); // W-P2 D-W7: live epoch + offset (was 100n placeholder)
      const canonicalMsg = buildRefreshCanonicalMsg({
        oldTokenId: ctx.oldTokenId,
        newRole: ctx.newRole,
        newExpiresEpoch,
        refreshNonce: nextNonce,
      });

      const { qs, pubkeys, aggregateSig } = await this.keystore.collectQuorumSignatures(
        canonicalMsg,
        this.threshold,
      );

      // Increment nonce BEFORE TX submit so a concurrent replay attempt sees
      // the bumped counter and gets rejected.
      this.nonces.set(nonceKey, nextNonce);

      const refreshResult = await this.submitFn({
        label: 'refresh-capability-token',
        args: {
          target: `${this.packageId}::room_capability::refresh_capability_token`,
          networkRegistryId: this.networkRegistryId,
          cpRegistryObjectId: this.cpRegistryObjectId,
          quorumStateObjectId: this.quorumStateObjectId,
          oldTokenId: ctx.oldTokenId,
          newRole: ctx.newRole,
          newExpiresEpoch,
          refreshNonce: nextNonce,
          cpQuorumProof: qs,
          signerPubkeys: pubkeys,
          // D-011: aggregate_sig param between signer_pubkeys and ctx
          aggregateSig,
          canonicalMsg: Array.from(canonicalMsg),
        },
      });

      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: {
            dedupe_key: dedupeKey,
            handler: 'executeRefresh',
            tx_digest: refreshResult.digest,
            old_token_id: ctx.oldTokenId,
            refresh_nonce: nextNonce,
          },
        },
        'TX submitted',
      );

      // C4 Case B: follow-up revoke-old TX so cap-token-cache evicts the old entry.
      await this.submitRevokeOld(ctx.oldTokenId, dedupeKey, traceId);
    } catch (err) {
      this.logger.error(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, err: (err as Error).message },
        },
        'executeRefresh failed — quorum collection or TX submit error',
      );
    }
  }

  /**
   * C4 Case B helper — submit `revoke_capability_token_via_quorum` for the OLD
   * token after a successful refresh. reason=4 distinguishes refresh-driven
   * revocations from slash (1) / admin (2) / turn-revoked (3) per the
   * extensible reason enum noted in D-002 + capability_events.move.
   */
  private async submitRevokeOld(
    oldTokenId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const reason = 4; // refresh-driven (extension of D-002 base enum 0/1/2)
    const canonicalMsg = buildRevokeCanonicalMsg({ capObjectId: oldTokenId, reason });

    const { qs, pubkeys } = await this.keystore.collectQuorumSignatures(
      canonicalMsg,
      this.threshold,
    );

    const result = await this.submitFn({
      label: 'revoke-capability-token-via-quorum',
      args: {
        target: `${this.packageId}::room_capability::revoke_capability_token_via_quorum`,
        networkRegistryId: this.networkRegistryId,
        cpRegistryObjectId: this.cpRegistryObjectId,
        quorumStateObjectId: this.quorumStateObjectId,
        capObjectId: oldTokenId,
        reason,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'submitRevokeOld',
          tx_digest: result.digest,
          cap_object_id: oldTokenId,
          reason,
          cross_wave: 'C4-cache-fast-path-eviction',
        },
      },
      'TX submitted',
    );
  }

  /**
   * REQ-ADM-013 test seam — synchronous nonce-replay guard. External callers
   * (e.g. a hypothetical future "force-refresh" admin RPC) supply an explicit
   * nonce; the issuer rejects any submission where nonce ≤ stored current.
   * Returns true if the nonce is acceptable (would be accepted by a real
   * refresh path) + bumps the stored counter; false if rejected.
   *
   * The leading underscore + ForTest suffix follows the existing dvconf-daemons
   * test-seam naming convention (e.g. event-handler._setStateForTest).
   */
  _attemptRefreshWithNonceForTest(
    roomId: string,
    peerHex: string,
    incomingNonce: number,
    traceId: string,
  ): boolean {
    const nonceKey = `${roomId}::${peerHex}`;
    const current = this.nonces.get(nonceKey) ?? 0;
    if (incomingNonce <= current) {
      this.logger.warn(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { reason: 'nonce-replay', incoming: incomingNonce, current, nonce_key: nonceKey },
        },
        'Nonce replay rejected — refresh skipped',
      );
      return false;
    }
    this.nonces.set(nonceKey, incomingNonce);
    return true;
  }
}
