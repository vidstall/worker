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

import type { SuiEvent } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Logger } from '@dvconf/shared';

interface CapTokenGraphQLEventNode {
  sender: { address: string } | null;
  sequenceNumber: number;
  timestamp: string | null;
  transactionModule: { package: { address: string }; name: string } | null;
  contents: { json: unknown; type: { repr: string } } | null;
}

interface CapTokenEventsQueryResult {
  events: {
    nodes: CapTokenGraphQLEventNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const CAP_TOKEN_EVENTS_QUERY = `
  query PollCapabilityEvents($module: String!, $after: String) {
    events(filter: { module: $module }, after: $after, first: 50) {
      nodes {
        sender { address }
        sequenceNumber
        timestamp
        transactionModule { package { address } name }
        contents { json type { repr } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

function graphqlNodeToSuiEvent(node: CapTokenGraphQLEventNode): SuiEvent {
  return {
    id: { txDigest: '', eventSeq: String(node.sequenceNumber) },
    packageId: node.transactionModule?.package.address ?? '',
    transactionModule: node.transactionModule?.name ?? '',
    sender: node.sender?.address ?? '',
    type: node.contents?.type.repr ?? '',
    parsedJson: node.contents?.json ?? {},
    bcs: '',
    timestampMs: node.timestamp ? String(Date.parse(node.timestamp)) : '0',
  } as unknown as SuiEvent;
}

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
  /**
   * Highest monotonic per-token anti-replay nonce seen so far (REQ-ADM-013).
   * Seeded from the chain event payload (CapabilityIssued.nonce, defaults to 1
   * matching the initial daemon mint when the event payload omits the field).
   * Updated via `validateAndAdvanceNonce` on each incoming WS message; the cache
   * is the SOT for "latest accepted nonce per token" within the signaling daemon.
   * Strictly monotonic: incoming must be > current to advance.
   */
  nonce: number;
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

  /**
   * Validate an incoming anti-replay nonce against the cache entry and advance
   * the high-water mark on accept (REQ-ADM-013). Strictly monotonic: incoming
   * must be > current to be accepted. Missing entries cannot be validated and
   * return false (caller is responsible for any cache-miss fallback policy).
   *
   * Does NOT change LRU order — auth flow already calls `get()` first for the
   * room/peer/expiry checks, which gives the LRU touch. Splitting concerns
   * keeps this method's contract narrow and side-effect-explicit.
   *
   * @returns true if incoming > current and the entry's nonce was advanced;
   *          false on stale (incoming <= current) or missing entry.
   */
  validateAndAdvanceNonce(tokenId: string, incomingNonce: number): boolean {
    const entry = this.entries.get(tokenId);
    if (entry === undefined) {
      this.logger.info(
        {
          module: 'cap-token-cache',
          tokenId,
          incoming: incomingNonce,
          reason: 'nonce-missing-entry',
        },
        'nonce validation skipped — token not in cache',
      );
      return false;
    }
    if (incomingNonce <= entry.nonce) {
      this.logger.info(
        {
          module: 'cap-token-cache',
          tokenId,
          incoming: incomingNonce,
          current: entry.nonce,
          reason: 'nonce-stale',
        },
        'nonce validation rejected — incoming <= current',
      );
      return false;
    }
    entry.nonce = incomingNonce;
    return true;
  }

  /**
   * Emergency fast-path eviction (REQ-ADM-015). Bypasses ALL TTL / revoked /
   * strict-reject checks — synchronous Map.delete. Used by out-of-band admin
   * action or threat-response handlers (cross-Wave: may be wired by lane-3.4-
   * issuer's emergency rotation flow in a future stage).
   *
   * Distinct from `invalidate(tokenId, reason)`:
   *   - `invalidate()`  → normal lifecycle (`'revoked' | 'refreshed' | 'expired'`), logs INFO.
   *   - `emergencyInvalidate()` → out-of-band threat response with arbitrary
   *     reason string, logs WARN at severity:'emergency'.
   *
   * Idempotent: re-calling on an already-evicted token logs an INFO audit trace
   * (does not throw, does not warn-spam).
   */
  emergencyInvalidate(tokenId: string, reason: string): void {
    if (this.entries.delete(tokenId)) {
      this.logger.warn(
        {
          module: 'cap-token-cache',
          context: { tokenId, reason },
          severity: 'emergency',
        },
        'emergency invalidate executed',
      );
      return;
    }
    this.logger.info(
      {
        module: 'cap-token-cache',
        context: { tokenId, reason },
        reason: 'already-evicted',
      },
      'emergency invalidate — token not in cache (already evicted)',
    );
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
          // REQ-ADM-013: CapabilityIssued seeds with 1 matching initial daemon
          // mint. If the on-chain event currently omits the field, the default
          // is the canonical first-mint value per D-013 fallback contract.
          nonce: e.nonce ?? 1,
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
          // REQ-ADM-013 + D-010-B: refresh emits the new monotonic refresh_nonce
          // (= old.nonce + 1 on chain). Passthrough when present; fallback to 1
          // so a refreshed-but-payload-missing event still produces a valid entry.
          nonce: e.nonce ?? 1,
        });
        return;
      }
    }
  }

  /**
   * D-016 Path B (chosen 2026-05-25) — emit one WARN on daemon cold start
   * describing the transient nonce-gap window. The cache reloads token entries
   * from chain events as they arrive (CapabilityIssued payload carries the
   * peer's high-water nonce); until the first refresh from each peer lands,
   * a stale-nonce attempt against an evicted cache entry will simply miss
   * (return null) and fall through to chain devInspect via auth.ts. Operators
   * are notified once at startup so the WARN line is observable in pino logs
   * but does NOT spam the steady-state path.
   *
   * Trade-off (D-013 § B): the gap window is bounded by
   *   max-time-between-refreshes-for-any-peer ≤ token TTL (60s default).
   * Acceptable at thesis scale (daemon restarts are infrequent + every refresh
   * re-aligns the cache).
   */
  announceColdStart(trigger: string): void {
    this.logger.warn(
      {
        module: 'cap-token-cache',
        reason: 'cold-start-transient-gap',
        context: { trigger },
      },
      'cache reloaded from chain; nonce high-water marks restored progressively as refresh events arrive (D-016 Path B)',
    );
  }

  /**
   * Subscribe to `capability_events` chain events using cursor-based
   * polling against `SuiGraphQLClient`'s `events(filter:)` query -- NOT the
   * legacy JSON-RPC `SuiClient.queryEvents`, which devnet's public fullnode
   * now returns "Method not found" for (see
   * https://docs.sui.io/develop/accessing-data/json-rpc-migration).
   * Parsed payloads are forwarded into `handleEvent`. Idempotent: the
   * returned `unsubscribe` is safe to call multiple times. Reconnect: poll
   * loop swallows transient errors and retries on the next interval.
   *
   * Mirrors the `EventPoller` pattern in `packages/shared/src/chain/events.ts`
   * but stays self-contained because cap-token-cache lives in `apps/signaling`
   * (which has its own `@mysten/sui` dependency and does not import an
   * EventPoller cursor file). Cursor is in-memory only (now an opaque
   * GraphQL relay-style string, not `{txDigest, eventSeq}`); on daemon
   * restart, the poller starts from the beginning of the package's event
   * history and `handleEvent` is idempotent against re-delivery (put is a
   * Map.set; revoke is delete; refresh is put-then-put).
   */
  async subscribeToChainEvents(
    graphqlClient: SuiGraphQLClient,
    packageId: string,
    opts?: { pollIntervalMs?: number },
  ): Promise<() => Promise<void>> {
    const intervalMs = opts?.pollIntervalMs ?? 2_000;
    let running = true;
    let cursor: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    const tick = async (): Promise<void> => {
      try {
        let hasMore = true;
        while (hasMore && running) {
          const result = await graphqlClient.query<CapTokenEventsQueryResult>({
            query: CAP_TOKEN_EVENTS_QUERY,
            variables: { module: `${packageId}::capability_events`, after: cursor },
          });
          if (result.errors && result.errors.length > 0) {
            throw new Error(`GraphQL events query failed: ${result.errors.map((e) => e.message).join('; ')}`);
          }
          const page = result.data?.events;
          if (!page) {
            throw new Error('GraphQL events query returned no data');
          }
          for (const node of page.nodes) {
            this.dispatchSuiEvent(graphqlNodeToSuiEvent(node));
          }
          if (page.nodes.length > 0 && page.pageInfo.endCursor) {
            cursor = page.pageInfo.endCursor;
          }
          hasMore = page.pageInfo.hasNextPage;
        }
      } catch (err) {
        this.logger.warn(
          { module: 'cap-token-cache', err: String(err) },
          'capability_events poll error — will retry on next interval',
        );
      }
    };

    const loop = (): void => {
      if (!running) return;
      inFlight = tick().finally(() => {
        if (running) {
          timer = setTimeout(loop, intervalMs);
        }
      });
    };
    loop();

    return async () => {
      if (!running) return;
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          /* swallow — loop already logged */
        }
      }
    };
  }

  /**
   * Map a raw `SuiEvent` from `queryEvents` into a `handleEvent` call.
   * Field-name translation matches `capability_events.move` snake_case:
   *   token_id → tokenId, room_id → roomId, peer_pubkey → peerPubkey,
   *   expires_epoch → expiresEpoch, new_expires_epoch → newExpiresEpoch.
   * Unknown event names are ignored (forward-compat with additive events).
   */
  private dispatchSuiEvent(ev: SuiEvent): void {
    const parts = ev.type.split('::');
    const name = parts[parts.length - 1] ?? '';
    const data = ev.parsedJson as Record<string, unknown> | undefined;
    if (!data) return;
    if (name === 'CapabilityIssued') {
      this.handleEvent('CapabilityIssued', {
        tokenId: String(data['token_id']),
        roomId: String(data['room_id']),
        peerPubkey: data['peer_pubkey'] as number[],
        role: Number(data['role']),
        expiresEpoch: BigInt(String(data['expires_epoch'] ?? '0')),
        ...(data['nonce'] !== undefined ? { nonce: Number(data['nonce']) } : {}),
      });
      return;
    }
    if (name === 'CapabilityRevoked') {
      this.handleEvent('CapabilityRevoked', {
        tokenId: String(data['token_id']),
        roomId: String(data['room_id']),
        reason: Number(data['reason']),
      });
      return;
    }
    if (name === 'CapabilityRefreshed') {
      this.handleEvent('CapabilityRefreshed', {
        tokenId: String(data['token_id']),
        roomId: String(data['room_id']),
        peerPubkey: data['peer_pubkey'] as number[],
        ...(data['role'] !== undefined ? { role: Number(data['role']) } : {}),
        newExpiresEpoch: BigInt(String(data['new_expires_epoch'] ?? '0')),
        ...(data['nonce'] !== undefined ? { nonce: Number(data['nonce']) } : {}),
      });
      return;
    }
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
  /**
   * REQ-ADM-013 + D-013: optional pass-through of on-chain anti-replay nonce.
   * When absent (e.g., the Move event currently omits the field), the cache
   * seeds `1` matching the initial daemon mint. Move-side propagation is a
   * follow-up coordination item with lane-a (refresh-entry) — see DECISIONS.md.
   */
  nonce?: number;
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
  /**
   * REQ-ADM-013 + D-010-B: the on-chain refresh entry mints with
   * `nonce = old.nonce + 1`. When the event payload carries the new value,
   * the cache replaces; when absent, defaults to 1 (same fallback as
   * CapabilityIssued).
   */
  nonce?: number;
}

export type ChainCapabilityEvent =
  | ChainCapabilityIssued
  | ChainCapabilityRevoked
  | ChainCapabilityRefreshed;
