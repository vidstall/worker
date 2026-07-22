/**
 * Relay endpoint cache + chain subscription — shared by the signaling and relay
 * daemons (REQ-RO-008 / D-RO-3).
 *
 * Extracted from `apps/signaling/src/relay-dual-router.ts` (G3.2a, GO_REUSE) so
 * BOTH daemons share ONE implementation:
 *   - the SIGNALING daemon resolves relay-ID → WS-URL when advertising the
 *     dual-relay assignment to a joining client (`DualRelayRouter`);
 *   - the RELAY daemon's standby resolves the PRIMARY relay's WS-URL
 *     (`relayIds[0]`) so it can open the inter-relay pipe (G3.2b).
 *
 * Responsibilities:
 *   - `InMemoryRelayEndpointCache` — relay-ID → WS-URL map + room → ordered
 *     relay-ID list, populated from `RelayRegistered` + `RoomAssigned` events.
 *   - `subscribeRelayEndpoints` — cursor-based chain poller that primes both
 *     modules once (historical replay) then polls each on the interval.
 *
 * `DualRelayRouter` + `DualRelayMessage` STAY in apps/signaling — they depend on
 * `ws` (the client WS send), which this shared package intentionally does not.
 *
 * No raw `console.*` in production paths (pino logger only).
 */

import type { SuiEvent } from '@mysten/sui/client';
import type { SuiGraphQLClient, GraphQLQueryResult } from '@mysten/sui/graphql';
import type { Logger } from '../logger.js';

const MODULE = 'relay-endpoint-cache';

interface RelayEndpointGraphQLEventNode {
  sender: { address: string } | null;
  sequenceNumber: number;
  timestamp: string | null;
  transactionModule: { package: { address: string }; name: string } | null;
  contents: { json: unknown; type: { repr: string } } | null;
}

interface RelayEndpointEventsQueryResult {
  events: {
    nodes: RelayEndpointGraphQLEventNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const RELAY_ENDPOINT_EVENTS_QUERY = `
  query PollRelayEndpointEvents($module: String!, $after: String) {
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

function relayEndpointNodeToSuiEvent(node: RelayEndpointGraphQLEventNode): SuiEvent {
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

// ── RelayEndpointCache (public interface for injection / testing) ─────────────

/**
 * Read-write interface for the relay-ID → WS-URL mapping.
 *
 * Two responsibilities:
 *   1. `getUrl(relayId)` — URL lookup used when building the relay-assigned message.
 *   2. `getAssignedRelays(roomId)` — ordered relay ID list for a room
 *      (assigned_relays[0]=primary, [1]=standby from chain / RoomAssigned event).
 *   3. `setUrl(relayId, url)` — populated from RelayRegistered events.
 */
export interface RelayEndpointCache {
  /** Returns the WS URL for a relay by its miner_id, or undefined if unknown. */
  getUrl(relayId: string): string | undefined;
  /** Upsert a relay's WS URL (called when RelayRegistered event arrives). */
  setUrl(relayId: string, url: string): void;
  /**
   * Returns the ordered assigned relay IDs for a room.
   * [0]=primary, [1]=standby. Empty array if room is unassigned.
   */
  getAssignedRelays(roomId: string): string[];
}

// ── InMemoryRelayEndpointCache ────────────────────────────────────────────────

/**
 * Production in-memory implementation.
 * Populated by `onRelayRegistered` (from chain events) and
 * `onRoomAssigned` (from RoomAssigned events).
 */
export class InMemoryRelayEndpointCache implements RelayEndpointCache {
  private readonly urlMap = new Map<string, string>();
  private readonly roomRelayMap = new Map<string, string[]>();

  getUrl(relayId: string): string | undefined {
    return this.urlMap.get(relayId);
  }

  setUrl(relayId: string, url: string): void {
    this.urlMap.set(relayId, url);
  }

  getAssignedRelays(roomId: string): string[] {
    return this.roomRelayMap.get(roomId) ?? [];
  }

  /** Called when a RoomAssigned event arrives with relay_ids[0..1]. */
  setRoomRelays(roomId: string, relayIds: string[]): void {
    this.roomRelayMap.set(roomId, relayIds);
  }

  /** Called when a RelayRegistered event arrives (endpoint_url is UTF-8 bytes). */
  onRelayRegistered(relayId: string, endpointUrlBytes: number[]): void {
    const url = Buffer.from(endpointUrlBytes).toString('utf8');
    this.setUrl(relayId, url);
  }
}

// ── Chain subscription (populate the cache from chain events, D-RO-3) ──────────

/**
 * Decode a Move `vector<u8>` field as delivered by the ACTIVE transport.
 * JSON-RPC's `parsedJson` renders it as a plain number array; GraphQL's
 * `contents.json` renders the same field as a base64 string instead (the two
 * transports disagree here even though everything else lines up) -- accept
 * either so this doesn't silently break again on a future transport switch.
 */
function decodeVectorU8(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value === 'string') {
    try {
      return Array.from(Buffer.from(value, 'base64'));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Map a raw `relay_registry::RelayRegistered` event into a cache URL upsert.
 * `endpoint_url` is a UTF-8 byte vector (matching shared RelayRegistered type).
 */
function applyRelayRegistered(
  cache: InMemoryRelayEndpointCache,
  data: Record<string, unknown>,
  logger: Logger,
): void {
  const relayId = String(data['miner_id'] ?? '');
  const endpointBytes = decodeVectorU8(data['endpoint_url']);
  if (relayId === '' || !endpointBytes) return;
  cache.onRelayRegistered(relayId, endpointBytes);
  logger.debug(
    { module: MODULE, context: { relayId } },
    'relay-endpoint-cache: cached relay endpoint from RelayRegistered',
  );
}

/**
 * Map a raw `room_manager::RoomAssigned` event into a cache room→relays upsert.
 * `relay_ids[0]` = primary, `[1]` = standby (length-driven, never hardcoded).
 */
function applyRoomAssigned(
  cache: InMemoryRelayEndpointCache,
  data: Record<string, unknown>,
  logger: Logger,
): void {
  const roomId = String(data['room_id'] ?? '');
  const relayIds = data['relay_ids'];
  if (roomId === '' || !Array.isArray(relayIds)) return;
  cache.setRoomRelays(roomId, (relayIds as unknown[]).map((id) => String(id)));
  logger.debug(
    { module: MODULE, context: { roomId, relayCount: (relayIds as unknown[]).length } },
    'relay-endpoint-cache: cached room→relays from RoomAssigned',
  );
}

/**
 * Subscribe a daemon to the chain events that populate the relay endpoint cache
 * (D-RO-3 — reuse the daemon's existing chain-poll infra rather than a
 * cross-daemon IPC). Cursor-based polling against `queryEvents`, mirroring the
 * F62 `CapTokenCache.subscribeToChainEvents` pattern:
 *   - `relay_registry::RelayRegistered`  → cache.onRelayRegistered (id → ws URL)
 *   - `room_manager::RoomAssigned`       → cache.setRoomRelays (room → [primary, standby])
 *
 * Primes both modules once at startup (historical replay so a relay registered
 * before the daemon booted is still resolvable), then polls each on the
 * interval. The returned async unsubscribe is idempotent + awaits the in-flight tick.
 *
 * Implements REQ-RO-008 (N2 cache population); reused by the G3.2a relay-side
 * consumer (`resolvePrimaryEndpoint`, apps/relay) to populate the cache it reads.
 */
export async function subscribeRelayEndpoints(
  client: SuiGraphQLClient,
  packageId: string,
  cache: InMemoryRelayEndpointCache,
  logger: Logger,
  opts?: {
    pollIntervalMs?: number;
    /**
     * Which chain modules to poll. Default polls BOTH (signaling needs the
     * room→relays map too). G3.2b: the relay-side consumer passes
     * `['relay_registry']` — it only reads relay-ID→URL and learns room→relays
     * from its own room poller, so the room_manager poll here is redundant.
     */
    modules?: Array<'relay_registry' | 'room_manager'>;
  },
): Promise<() => Promise<void>> {
  const intervalMs = opts?.pollIntervalMs ?? 5_000;
  const modules = opts?.modules ?? ['relay_registry', 'room_manager'];
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  // Per-module ascending cursor (in-memory; handlers are idempotent on re-delivery).
  // Now an opaque GraphQL relay-style string, not {txDigest, eventSeq} (see
  // events.ts's module docstring for why this migrated off JSON-RPC queryEvents).
  const cursors: Record<string, string | null> = {
    relay_registry: null,
    room_manager: null,
  };

  const dispatch = (ev: SuiEvent): void => {
    const parts = ev.type.split('::');
    const name = parts[parts.length - 1] ?? '';
    const data = ev.parsedJson as Record<string, unknown> | undefined;
    if (!data) return;
    if (name === 'RelayRegistered') applyRelayRegistered(cache, data, logger);
    else if (name === 'RoomAssigned') applyRoomAssigned(cache, data, logger);
  };

  const pollModule = async (mod: 'relay_registry' | 'room_manager'): Promise<void> => {
    let hasMore = true;
    while (hasMore && running) {
      const result: GraphQLQueryResult<RelayEndpointEventsQueryResult> = await client.query<
        RelayEndpointEventsQueryResult,
        { module: string; after: string | null }
      >({
        query: RELAY_ENDPOINT_EVENTS_QUERY,
        variables: { module: `${packageId}::${mod}`, after: cursors[mod] ?? null },
      });
      if (result.errors && result.errors.length > 0) {
        throw new Error(`GraphQL events query failed: ${result.errors.map((e: { message: string }) => e.message).join('; ')}`);
      }
      const page = result.data?.events;
      if (!page) {
        throw new Error('GraphQL events query returned no data');
      }
      for (const node of page.nodes) dispatch(relayEndpointNodeToSuiEvent(node));
      if (page.nodes.length > 0 && page.pageInfo.endCursor) cursors[mod] = page.pageInfo.endCursor;
      hasMore = page.pageInfo.hasNextPage;
    }
  };

  const tick = async (): Promise<void> => {
    try {
      for (const mod of modules) await pollModule(mod);
    } catch (err) {
      logger.warn(
        { module: MODULE, err: String(err) },
        'relay-endpoint poll error — will retry on next interval',
      );
    }
  };

  // Prime once (historical replay) before starting the interval loop.
  await tick();
  logger.info({ module: MODULE, context: { intervalMs } }, 'relay-endpoint cache subscription started');

  const loop = (): void => {
    if (!running) return;
    inFlight = tick().finally(() => {
      if (running) timer = setTimeout(loop, intervalMs);
    });
  };
  timer = setTimeout(loop, intervalMs);

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
    logger.info({ module: MODULE }, 'relay-endpoint cache subscription stopped');
  };
}
