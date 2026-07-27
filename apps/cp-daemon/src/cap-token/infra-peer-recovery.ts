/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer (cp-daemon module) — infra-peer
 * pubkey recovery (Multi-CP quorum Leg 2 attest predicate + Leg 3 G3 recovery).
 *
 * Split out of the former monolithic `cap-token-issuer.ts` (god-file split).
 */
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  buildIssueCanonicalMsg,
  bytesToHex,
  hexToBytes,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from './canonical-messages.js';

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
// ADDITIVE: `resolvePeerPubkey` (canonical-messages.ts) is UNCHANGED; the Move devInspect
// getter stays explicitly DEFERRED (event-cache path only, per ROADMAP Leg 3);
// `buildIssueCanonicalMsg` is called VERBATIM for the G4 hex.

/**
 * Single-CP gate (consolidated-demo root cause C, 2026-06-24). G3 infra-peer recovery is a
 * MULTI-CP mechanism: it recovers the real 32-byte key from a PRIOR `CapabilityIssued` event, so
 * the recovery cache only ever holds content once a token was already issued for the (room, peer).
 * A single-CP issuer (threshold <= 1) has no second CP and no seed path, so wiring the cache makes
 * `submitIssue` fail-closed-SKIP the FIRST infra mint forever — no `CapabilityIssued` is ever
 * emitted (chicken-and-egg). Single-CP must therefore fall back to the legacy `resolvePeerPubkey`
 * mint (the F62-proven path). This mirrors the issuer's own documented contract: `onCapabilityIssued`
 * is a no-op "when no recovery cache is configured (single-CP / legacy)".
 */
export function shouldWireInfraPeerRecovery(quorumThreshold: number): boolean {
  return quorumThreshold >= 2;
}

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
