/**
 * Capability-token WS-join auth (Phase 3.2 — Lane C).
 *
 * Verifies inbound `JoinMessage` against a cached `RoomCapability` snapshot
 * supplied by the lane-d `cap-token-cache` consumer. Enforces 1-WS-per-peer
 * (D-010-D second-attempt-loses). All rejects emit pino WARN with `trace_id`
 * per workspace structured-logging standard.
 *
 * Canonical join payload (signed by client, verified here):
 *   BCS({ roomId: string, peerPubkey: vector<u8>, nonce: u64 })
 *
 * Source of truth invariants:
 * - `token` in JoinMessage = token_id STRING, NOT serialised BCS blob (D-010-C).
 * - ed25519 verify uses peer_pubkey from the CACHED token, NOT from JoinMessage
 *   (T2 threat: trust the chain's record of who owns the token, not the
 *   connecting peer's self-declaration).
 * - second-attempt-loses (D-010-D): first WS for a peer_pubkey wins; later
 *   attempts get `duplicate-connection` + WS close 4409. The incumbent is
 *   NOT closed.
 *
 * REQ-ADM-004 — capability verify on WS join.
 * REQ-ADM-008 — 1-WS-per-peer-pubkey, second-attempt-loses.
 */

import type { WebSocket } from 'ws';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import type { Logger } from '@dvconf/shared';

// ── Public contract types ────────────────────────────────────────────────

/** Inbound WS join message with capability-token auth fields (REQ-ADM-004). */
export interface JoinAuthMessage {
  type: 'join';
  roomId: string;
  /** Sui object ID string of the RoomCapability (NOT a BCS blob per D-010-C). */
  token: string;
  /** Base64-encoded raw ed25519 signature over the canonical join payload. */
  signature: string;
  /** Monotonic per-peer counter; Phase 3.4 enforces strict-greater. */
  nonce: number;
}

/**
 * Read-only snapshot of a RoomCapability as exposed by lane-d's `CapTokenCache`.
 * We define the consumer interface here so this module compiles before lane-d
 * ships; lane-d's concrete `CapTokenCache` will implement this surface.
 */
export interface CachedTokenSnapshot {
  tokenId: string;
  roomId: string;
  /** 32-byte ed25519 pubkey. */
  peerPubkey: number[];
  role: number;
  /** Sui epoch at which the token expires (u64 as bigint). */
  expiresEpoch: bigint;
  revoked: boolean;
}

/** Minimal consumer surface of lane-d's CapTokenCache (READ-ONLY). */
export interface AuthCacheConsumer {
  get(tokenId: string): CachedTokenSnapshot | null;
  has(tokenId: string): boolean;
  isStrictRejectMode(): boolean;
}

export interface AuthHookOpts {
  cache: AuthCacheConsumer;
  /** Returns the current Sui epoch. Used for expiry checks. */
  currentEpoch: () => bigint;
  logger: Logger;
}

/** Reject reasons surfaced to the caller for close-code mapping + audit logs. */
export type VerifyReason =
  | 'no-token'
  | 'invalid-signature'
  | 'expired'
  | 'revoked'
  | 'wrong-room'
  | 'wrong-peer'
  | 'auth-degraded'
  | 'duplicate-connection';

export interface VerifyResult {
  accepted: boolean;
  reason?: VerifyReason;
  /** WS close code: 4401 (auth fail) / 4403 (revoked) / 4409 (conflict). */
  closeCode?: 4401 | 4403 | 4409;
}

// ── Internal helpers ─────────────────────────────────────────────────────

const JoinPayloadBcs = bcs.struct('JoinPayload', {
  roomId: bcs.string(),
  peerPubkey: bcs.vector(bcs.u8()),
  nonce: bcs.u64(),
});

function buildCanonicalPayload(roomId: string, peerPubkey: number[], nonce: number): Uint8Array {
  return JoinPayloadBcs.serialize({ roomId, peerPubkey, nonce: BigInt(nonce) }).toBytes();
}

function peerKeyHex(peerPubkey: number[]): string {
  return peerPubkey
    .slice(0, 4)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function closeCodeFor(reason: VerifyReason): 4401 | 4403 | 4409 {
  if (reason === 'revoked') return 4403;
  if (reason === 'duplicate-connection') return 4409;
  return 4401;
}

// ── AuthHook ────────────────────────────────────────────────────────────

export class AuthHook {
  private readonly cache: AuthCacheConsumer;
  private readonly currentEpoch: () => bigint;
  private readonly logger: Logger;
  /** peer_pubkey (hex string) → incumbent WebSocket. First-wins per D-010-D. */
  private readonly activeByPeer = new Map<string, WebSocket>();

  constructor(opts: AuthHookOpts) {
    this.cache = opts.cache;
    this.currentEpoch = opts.currentEpoch;
    this.logger = opts.logger;
  }

  /**
   * Verify a JoinMessage against the cap-token cache.
   *
   * Caller MUST NOT register the WS connection until this returns
   * `{ accepted: true }`. Every reject emits a structured WARN log
   * with `trace_id` + `peer_pubkey_prefix` (privacy: never log full pubkey).
   */
  async verifyJoin(msg: JoinAuthMessage, _ws: WebSocket, traceId: string): Promise<VerifyResult> {
    // 1. Strict-reject mode short-circuit (REQ-ADM-012 via cache).
    if (this.cache.isStrictRejectMode()) {
      return this.reject('auth-degraded', traceId, this.fingerprintFromMsg(msg));
    }

    // 2. Empty/missing token_id.
    if (!msg.token || msg.token.length === 0) {
      return this.reject('no-token', traceId, this.fingerprintFromMsg(msg));
    }

    // 3. Cache lookup.
    const cached = this.cache.get(msg.token);
    if (cached === null) {
      return this.reject('no-token', traceId, this.fingerprintFromMsg(msg));
    }

    // 4. Revoked.
    if (cached.revoked) {
      return this.reject('revoked', traceId, peerKeyHex(cached.peerPubkey));
    }

    // 5. Expired.
    if (cached.expiresEpoch <= this.currentEpoch()) {
      return this.reject('expired', traceId, peerKeyHex(cached.peerPubkey));
    }

    // 6. Room mismatch.
    if (cached.roomId !== msg.roomId) {
      return this.reject('wrong-room', traceId, peerKeyHex(cached.peerPubkey));
    }

    // 7. ed25519 signature verification using CACHED peer_pubkey (T2 threat).
    //    A mismatch here covers BOTH "bad signature" and "wrong peer signed" —
    //    semantically a reject for invalid-signature against the cached identity.
    const sigOk = await this.verifySignature(
      cached.peerPubkey,
      msg.roomId,
      msg.nonce,
      msg.signature,
    );
    if (!sigOk) {
      return this.reject('invalid-signature', traceId, peerKeyHex(cached.peerPubkey));
    }

    return { accepted: true };
  }

  /**
   * Register an active WS connection for a peer. Enforces 1-WS-per-peer:
   * the FIRST registration wins; subsequent attempts with the same
   * peer_pubkey are rejected with `duplicate-connection` (close 4409).
   * The incumbent WS is NOT touched — T2 incumbent-trust per D-010-D.
   */
  registerActiveConnection(peerPubkey: number[], ws: WebSocket): VerifyResult {
    const key = peerKeyHex(peerPubkey);
    if (this.activeByPeer.has(key)) {
      this.logger.warn(
        {
          module: 'auth',
          context: { reason: 'duplicate-connection', peer_pubkey_prefix: key },
        },
        'WS join rejected: duplicate connection for peer (D-010-D second-attempt-loses)',
      );
      return { accepted: false, reason: 'duplicate-connection', closeCode: 4409 };
    }
    this.activeByPeer.set(key, ws);
    return { accepted: true };
  }

  /**
   * Force-close the active WS for a peer. Used by revoke-flow / emergency
   * rotation (Phase 3.4) to drop in-flight peers when their token is
   * invalidated.
   */
  closeOnConflict(peerPubkey: number[]): void {
    const key = peerKeyHex(peerPubkey);
    const ws = this.activeByPeer.get(key);
    if (ws !== undefined) {
      ws.close(4403, 'capability revoked');
      this.activeByPeer.delete(key);
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private async verifySignature(
    peerPubkey: number[],
    roomId: string,
    nonce: number,
    signatureB64: string,
  ): Promise<boolean> {
    try {
      const payload = buildCanonicalPayload(roomId, peerPubkey, nonce);
      const sigBytes = Buffer.from(signatureB64, 'base64');
      if (sigBytes.length !== 64) return false;
      const pk = new Ed25519PublicKey(new Uint8Array(peerPubkey));
      return await pk.verify(payload, new Uint8Array(sigBytes));
    } catch {
      return false;
    }
  }

  private fingerprintFromMsg(_msg: JoinAuthMessage): string {
    // For pre-cache rejects (no-token / auth-degraded) no peer_pubkey is known.
    // Emit a short fixed marker — keeps audit-log shape stable (≤16 chars,
    // matching the cache-hit case where peer_pubkey_prefix = first 8 hex chars)
    // and avoids leaking the un-validated token string.
    return 'unknown';
  }

  private reject(reason: VerifyReason, traceId: string, peerPrefix: string): VerifyResult {
    this.logger.warn(
      {
        trace_id: traceId,
        module: 'auth',
        context: { reason, peer_pubkey_prefix: peerPrefix },
      },
      'WS join rejected',
    );
    return { accepted: false, reason, closeCode: closeCodeFor(reason) };
  }
}
