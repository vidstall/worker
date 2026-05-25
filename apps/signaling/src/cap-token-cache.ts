/**
 * Capability-token LRU cache for fast WS join verification.
 *
 * Implements `cap-token-cache.ts` per CONTRACTS.md § 4.3 (F62 M1 Stage 3 Phase 3.3).
 * Consumed by `auth.ts` (lane-c) on WS join to look up cached RoomCapability state
 * without an extra RPC per join.
 *
 * REQ-ADM-005: cache must invalidate ≤5s after a `CapabilityRevoked` event.
 * REQ-ADM-009: cache flips to strict-reject mode when chain RPC is unreachable >30s.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Logger } from '@dvconf/shared';

/** Cached snapshot of a RoomCapability for fast WS handshake lookup. */
export interface CachedToken {
  /** RoomCapability UID (0x-prefixed hex). */
  tokenId: string;
  /** Room the token grants access to. */
  roomId: string;
  /** ed25519 public key of the peer (32 bytes per D-OQ-ADM-3). */
  peerPubkey: number[];
  /** u8 role enum (0=user 1=validator 2=relay 3=CP 4=signaling). */
  role: number;
  /** u64 Sui epoch at which the token expires. */
  expiresEpoch: bigint;
  /** Mirrors on-chain RoomCapability.revoked flag. */
  revoked: boolean;
  /** unix-ms timestamp at which this entry was inserted. Used for sliding TTL. */
  cachedAt: number;
}

/** Reason codes for invalidate() — used in structured logs only. */
export type InvalidateReason = 'revoked' | 'refreshed' | 'expired';

export interface CapTokenCacheOpts {
  /** Max LRU entries. Default 10_000 per D-OQ-ADM-5. */
  maxEntries?: number;
  /** TTL in ms (from cachedAt). Default 60_000 per D-OQ-ADM-5. */
  ttlMs?: number;
  /** Structured logger — required for strict-reject WARN logs. */
  logger: Logger;
  /** Override Date.now (used in tests). */
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 10_000;
const DEFAULT_TTL_MS = 60_000;

/** Event names emitted by `capability_events.move` (REAL names, NOT briefing aliases). */
export type CapabilityEventName =
  | 'CapabilityIssued'
  | 'CapabilityRevoked'
  | 'CapabilityRefreshed';

export class CapTokenCache {
  private readonly entries = new Map<string, CachedToken>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private strictReject = false;

  constructor(opts: CapTokenCacheOpts) {
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.logger = opts.logger;
    this.clock = opts.now ?? Date.now;
  }

  /**
   * Look up a token. Returns null if not cached, expired by TTL, revoked, or
   * the cache is in strict-reject mode. On hit, refreshes LRU position without
   * extending cachedAt (sliding TTL counts from original insert per CONTRACTS § 4.3).
   */
  get(tokenId: string): CachedToken | null {
    if (this.strictReject) return null;
    const entry = this.entries.get(tokenId);
    if (entry === undefined) return null;
    if (entry.revoked) return null;
    if (this.clock() - entry.cachedAt > this.ttlMs) {
      this.invalidate(tokenId, 'expired');
      return null;
    }
    // Update LRU order: delete + re-set, preserving cachedAt.
    this.entries.delete(tokenId);
    this.entries.set(tokenId, entry);
    return entry;
  }

  /** Lightweight presence check; does NOT update LRU order. */
  has(tokenId: string): boolean {
    return this.entries.has(tokenId);
  }

  /**
   * Insert/update from a chain event payload. Evicts LRU-oldest if over capacity.
   * Called by handleEvent() on CapabilityIssued / CapabilityRefreshed.
   */
  put(tokenId: string, token: CachedToken): void {
    this.entries.delete(tokenId);
    this.entries.set(tokenId, token);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  /** Explicit eviction with a reason string for structured logging. */
  invalidate(tokenId: string, reason: InvalidateReason): void {
    if (this.entries.delete(tokenId)) {
      this.logger.info(
        { module: 'cap-token-cache', tokenId, reason },
        'cache entry invalidated',
      );
    }
  }

  /** Current entry count — tests + observability. */
  size(): number {
    return this.entries.size;
  }

  /**
   * Transition into strict-reject mode (REQ-ADM-009). While active, all get()
   * calls return null. Idempotent — repeated activation does not duplicate logs.
   */
  setStrictRejectMode(reason: string): void {
    if (this.strictReject) return;
    this.strictReject = true;
    this.logger.warn(
      { module: 'cap-token-cache', reason },
      'strict-reject mode ENGAGED',
    );
  }

  /** Exit strict-reject mode — used when RPC reconnects. Idempotent. */
  clearStrictRejectMode(): void {
    if (!this.strictReject) return;
    this.strictReject = false;
    this.logger.warn(
      { module: 'cap-token-cache' },
      'strict-reject mode CLEARED',
    );
  }

  isStrictRejectMode(): boolean {
    return this.strictReject;
  }

  /**
   * Apply a parsed `capability_events` chain event. Public for direct unit
   * testing; production callers wire this via the event-poller forwarding loop.
   *
   * Note on CapabilityRefreshed: the Move entry (Phase 2.4-retro) mints a NEW
   * RoomCapability UID. The event carries the NEW token_id. The OLD token's
   * eviction depends on the issuer also emitting CapabilityRevoked for the old
   * id (cross-Wave coordination — see DISPATCH-PLAN.md Wave 1.B), or natural
   * 60s TTL expiry.
   */
  handleEvent(eventName: CapabilityEventName, payload: ChainCapabilityEvent): void {
    switch (eventName) {
      case 'CapabilityIssued': {
        const e = payload as ChainCapabilityIssued;
        this.put(e.tokenId, {
          tokenId: e.tokenId,
          roomId: e.roomId,
          peerPubkey: e.peerPubkey,
          role: e.role,
          expiresEpoch: e.expiresEpoch,
          revoked: false,
          cachedAt: this.clock(),
        });
        return;
      }
      case 'CapabilityRevoked': {
        const e = payload as ChainCapabilityRevoked;
        this.invalidate(e.tokenId, 'revoked');
        return;
      }
      case 'CapabilityRefreshed': {
        const e = payload as ChainCapabilityRefreshed;
        this.put(e.tokenId, {
          tokenId: e.tokenId,
          roomId: e.roomId,
          peerPubkey: e.peerPubkey,
          role: e.role ?? 0,
          expiresEpoch: e.newExpiresEpoch,
          revoked: false,
          cachedAt: this.clock(),
        });
        return;
      }
    }
  }

  /**
   * Subscribe to `capability_events` chain events. Returns an unsubscribe
   * handle. The production poller wiring is owned by Phase 3.4 (cp-daemon
   * event-poller forwards parsed events into `handleEvent`); this method
   * exists for API compatibility with CONTRACTS § 4.3 and is currently a
   * no-op returning an idempotent unsubscribe.
   */
  async subscribeToChainEvents(
    _suiClient: SuiClient,
    _packageId: string,
  ): Promise<() => void> {
    return () => {
      /* no-op */
    };
  }
}

// ── Chain event payload shapes (subset of capability_events.move structs) ───
// Field names match dvconf-daemons types/events.ts camelCase convention.

export interface ChainCapabilityIssued {
  tokenId: string;
  roomId: string;
  peerPubkey: number[];
  role: number;
  expiresEpoch: bigint;
}

export interface ChainCapabilityRevoked {
  tokenId: string;
  roomId: string;
  reason: number;
}

export interface ChainCapabilityRefreshed {
  tokenId: string;
  roomId: string;
  peerPubkey: number[];
  /** OPTIONAL — the Move event currently carries the new token under `token_id`
   * + same `peer_pubkey`. role is not currently in the on-chain event payload;
   * the cache infers role=0 when absent (refreshable tokens always reissue
   * with the role recorded in the matching CapabilityIssued event that
   * follows). */
  role?: number;
  newExpiresEpoch: bigint;
}

export type ChainCapabilityEvent =
  | ChainCapabilityIssued
  | ChainCapabilityRevoked
  | ChainCapabilityRefreshed;
