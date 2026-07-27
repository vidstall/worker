// MOVE CONTRACT: byte layout of these canonical-message builders must exactly match cross-CP peers and the on-chain Move module — do not reformat serialization logic without a coordinated protocol version bump.

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
export function hexToBytes(s: string): number[] {
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
export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}
