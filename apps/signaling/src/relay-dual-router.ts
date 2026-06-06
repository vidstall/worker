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
 *   The `RelayEndpointCache` contract + its `InMemoryRelayEndpointCache` impl +
 *   the `subscribeRelayEndpoints` chain poller were EXTRACTED to `@dvconf/shared`
 *   (G3.2a, GO_REUSE) so the relay daemon (a standby resolving the primary's
 *   WS-URL) shares one implementation. This module imports the contract from
 *   shared; only `DualRelayRouter` (which depends on `ws`) stays here.
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
import type { Logger, RelayEndpointCache } from '@dvconf/shared';

const MODULE = 'relay-dual-router';

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
