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

/**
 * Resolve a standby room's PRIMARY relay WS URL from the shared endpoint cache.
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
  return cache.getUrl(primaryId) ?? null;
}
