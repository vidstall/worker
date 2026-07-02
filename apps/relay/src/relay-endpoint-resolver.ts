/**
 * Relay-side primary-endpoint resolution — G3.2a (REQ-RO-008 / G3 sub-lane).
 *
 * A STANDBY relay resolves the PRIMARY relay's WebSocket endpoint URL so it can
 * open the inter-relay pipe to it (the `new WebSocket(primaryUrl)` open is the
 * live G3.2b glue). The primary is `relayIds[0]` (length-driven, per the
 * `determineRole` contract: assigned_relays[0]=primary, [1..]=standby). The URL
 * is read from the shared `RelayEndpointCache`, which `subscribeRelayEndpoints`
 * populates from chain `RelayRegistered` events (each relay self-publishes its
 * `endpoint_url` at register time — see auto-register.ts).
 *
 * Pure + injectable so it is unit-testable without the chain/isMainModule glue.
 */

import type { RelayEndpointCache } from '@dvconf/shared';
import type { TreePosition } from './tree-position.js';

/**
 * Resolve a SINGLE relayId's WS endpoint from the shared cache (null if unknown).
 *
 * T-B generalizes the shipped single-standby resolver: a child relay resolves its
 * tree PARENT's endpoint the same way a standby resolves the primary. Works for
 * ANY relayId (parent, child, or slot-0 primary).
 */
export function resolveRelayEndpoint(cache: RelayEndpointCache, relayId: string): string | null {
  return cache.getUrl(relayId) ?? null;
}

/**
 * Resolve a standby room's PRIMARY relay WS URL from the shared endpoint cache.
 *
 * Now a thin wrapper over {@link resolveRelayEndpoint} on slot [0] — the shipped
 * single-standby helper (signature + behavior unchanged).
 *
 * @param cache    the shared relay-ID → WS-URL cache (populated from chain).
 * @param relayIds the room's ordered assigned relay IDs ([0]=primary).
 * @returns the primary's WS URL, or `null` if the room is unassigned or the
 *          primary's endpoint has not been observed on chain yet.
 */
export function resolvePrimaryEndpoint(
  cache: RelayEndpointCache,
  relayIds: string[],
): string | null {
  const primaryId = relayIds[0];
  if (!primaryId) return null;
  return resolveRelayEndpoint(cache, primaryId);
}

/**
 * T-B (I1 / N1): the tree-active inter-relay DIAL target for a node — a PURE function of
 * its TREE position, NOT its chain slot-0 role.
 *
 *  - a position WITH a parent → dial the tree PARENT (child→parent link).
 *  - the true tree root (`pos.parent === null`) OR no position → null (accept-only, dials nobody).
 *
 * The tree root is the sorted-min canonical relayId (`deriveTree` is order-independent), which
 * DIVERGES from chain slot-0 after `promote_relay` or when `relay_ids` arrives unsorted — so the
 * dial MUST NOT be gated on `role === 'primary'`. A non-root chain-primary correctly dials its
 * tree parent here while still accepting its children's dials via the unchanged WS accept path.
 * Unit-tested (relay-endpoint-resolver.test.ts) with non-sorted relay_ids where slot-0 ≠ root.
 */
export function resolveTreeParentDial(
  pos: TreePosition | undefined,
  cache: RelayEndpointCache,
): string | null {
  return pos && pos.parent ? resolveRelayEndpoint(cache, pos.parent) : null;
}
