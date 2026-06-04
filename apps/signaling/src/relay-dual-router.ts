/**
 * Dual-relay URL advertisement for the signaling daemon — M1 Phase 3.2 (REQ-RO-008).
 *
 * After the F62 AuthHook `verifyJoin` passes, the signaling daemon calls
 * `DualRelayRouter.sendRelayAssigned(ws, roomId, traceId)` to push both the
 * primary and standby relay WebSocket URLs to the joining client.
 *
 * Wiring constraints (CONTRACTS C2 / H5):
 *   - Called ONLY after `authHook.verifyJoin` returns `{ accepted: true }`.
 *   - `rooms.ts` is NOT touched — it stays chain-free and WS-routing only.
 *   - Wire at the daemon `index.ts` join handler (daemon boundary).
 *   - relay-ID → WS-URL resolved via `RelayEndpointCache` (D-RO-3).
 *
 * Relay endpoint cache (D-RO-3):
 *   The cache is populated by the `RelayRegistered` event arm in cp-daemon's
 *   `event-handler.ts:119`. For the signaling daemon, a parallel `InMemoryRelayEndpointCache`
 *   is maintained here and populated from `RelayRegistered` events via the
 *   signaling daemon's own chain poller (or the chain read at join time per D-RO-3).
 *
 *   Option A (chosen per D-RO-3): read `relay_registry::get_active_relays()` at
 *   daemon startup + cache; refresh periodically. The cache is keyed by relay ID
 *   (miner_id), value is the WS endpoint URL decoded from `endpoint_url: number[]`.
 *
 * Message shape (CONTRACTS C2):
 *   { type: 'relay-assigned', room_id: string, primary_url: string, standby_url?: string }
 *
 * Graceful degrade: if the room has only 1 assigned relay, sends `primary_url` only
 * (no `standby_url`). Client interprets absent `standby_url` as single-relay mode.
 *
 * No raw `console.*` in production paths (pino logger only).
 *
 * Implements REQ-RO-008.
 */

import type { WebSocket } from 'ws';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Logger } from '@dvconf/shared';

const MODULE = 'relay-dual-router';

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

// ── DualRelayMessage ──────────────────────────────────────────────────────────

/** Wire shape sent to client after admission gate passes (CONTRACTS C2). */
export interface DualRelayMessage {
  type: 'relay-assigned';
  room_id: string;
  primary_url: string;
  standby_url?: string;
}

// ── DualRelayRouter ───────────────────────────────────────────────────────────

/**
 * Resolves relay-ID → WS-URL for a room and sends the `relay-assigned` message
 * to the joining client. MUST be called only after the AuthHook admission gate
 * passes (H5 / T4 non-negotiable).
 *
 * Does NOT perform any authentication — that stays in `AuthHook.verifyJoin`.
 */
export class DualRelayRouter {
  constructor(
    private readonly cache: RelayEndpointCache,
    private readonly logger: Logger,
  ) {}

  /**
   * Build and send the `relay-assigned` message to `ws` for the given room.
   *
   * If the room has 0 assigned relays: logs warn, does NOT send (no data to give).
   * If the room has 1 assigned relay: sends `primary_url` only (graceful degrade).
   * If the room has 2+ assigned relays: sends both `primary_url` + `standby_url`.
   *
   * relay IDs with no URL in the cache are skipped (warn logged).
   */
  sendRelayAssigned(ws: WebSocket, roomId: string, traceId: string): void {
    const assignedIds = this.cache.getAssignedRelays(roomId);

    if (assignedIds.length === 0) {
      this.logger.warn(
        {
          trace_id: traceId,
          module: MODULE,
          context: { roomId },
        },
        'relay-dual-router: no assigned relays for room — relay-assigned not sent',
      );
      return;
    }

    // Resolve URLs in order — skip any relayId that has no URL in the cache
    const resolvedUrls: string[] = [];
    for (const relayId of assignedIds) {
      const url = this.cache.getUrl(relayId);
      if (url === undefined) {
        this.logger.warn(
          {
            trace_id: traceId,
            module: MODULE,
            context: { roomId, relayId },
          },
          'relay-dual-router: relay URL not in cache — skipping relay slot',
        );
        continue;
      }
      resolvedUrls.push(url);
    }

    if (resolvedUrls.length === 0) {
      this.logger.warn(
        {
          trace_id: traceId,
          module: MODULE,
          context: { roomId },
        },
        'relay-dual-router: no resolvable relay URLs — relay-assigned not sent',
      );
      return;
    }

    const primaryUrl = resolvedUrls[0]!;
    const msg: DualRelayMessage = {
      type: 'relay-assigned',
      room_id: roomId,
      primary_url: primaryUrl,
    };

    if (resolvedUrls.length >= 2) {
      msg.standby_url = resolvedUrls[1]!;
    }

    ws.send(JSON.stringify(msg));

    this.logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        context: {
          roomId,
          primaryUrl,
          standbyUrl: msg.standby_url ?? null,
          relayCount: resolvedUrls.length,
        },
      },
      'relay-dual-router: relay-assigned sent to client',
    );
  }
}

// ── Chain subscription (N2: populate the cache from chain events, D-RO-3) ─────

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
  const endpointBytes = data['endpoint_url'];
  if (relayId === '' || !Array.isArray(endpointBytes)) return;
  cache.onRelayRegistered(relayId, endpointBytes as number[]);
  logger.debug(
    { module: MODULE, context: { relayId } },
    'relay-dual-router: cached relay endpoint from RelayRegistered',
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
    'relay-dual-router: cached room→relays from RoomAssigned',
  );
}

/**
 * Subscribe the signaling daemon to the chain events that populate the relay
 * endpoint cache (D-RO-3 — reuse the daemon's existing chain-poll infra rather
 * than a cross-daemon IPC). Cursor-based polling against `queryEvents`, mirroring
 * the F62 `CapTokenCache.subscribeToChainEvents` pattern:
 *   - `relay_registry::RelayRegistered`  → cache.onRelayRegistered (id → ws URL)
 *   - `room_manager::RoomAssigned`       → cache.setRoomRelays (room → [primary, standby])
 *
 * Primes both modules once at startup (historical replay so a relay registered
 * before the signaling daemon booted is still resolvable), then polls each on the
 * interval. The returned async unsubscribe is idempotent + awaits the in-flight tick.
 *
 * Implements REQ-RO-008 (N2 cache population).
 */
export async function subscribeRelayEndpoints(
  client: SuiClient,
  packageId: string,
  cache: InMemoryRelayEndpointCache,
  logger: Logger,
  opts?: { pollIntervalMs?: number },
): Promise<() => Promise<void>> {
  const intervalMs = opts?.pollIntervalMs ?? 5_000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  // Per-module ascending cursor (in-memory; handlers are idempotent on re-delivery).
  const cursors: Record<string, { txDigest: string; eventSeq: string } | null> = {
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
      const page = await client.queryEvents({
        query: { MoveEventModule: { package: packageId, module: mod } },
        cursor: cursors[mod] ?? undefined,
        limit: 50,
        order: 'ascending',
      });
      for (const ev of page.data) dispatch(ev);
      if (page.data.length > 0 && page.nextCursor) cursors[mod] = page.nextCursor;
      hasMore = page.hasNextPage;
    }
  };

  const tick = async (): Promise<void> => {
    try {
      await pollModule('relay_registry');
      await pollModule('room_manager');
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
