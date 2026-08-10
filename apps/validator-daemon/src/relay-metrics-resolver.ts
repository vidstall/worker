/**
 * Per-relay metrics endpoint resolution (closes part of G3).
 *
 * The validator must probe the metrics endpoint of the relay it is ATTESTING. The cp
 * assigns a DYNAMIC primary relay per room, so a single static `RELAY_METRICS_URL` only ever
 * matches one relay and returns 404 ("room not found") for every other -> bytesForwarded=0 ->
 * work-based reward gross=0 (G-DEMO-9). This reader maps each relay's on-chain ws endpoint to
 * its metrics base URL so `measureRelay` reaches whichever relay actually forwards the room.
 *
 * Path-based Caddy routing (see Caddyfile.j2) fronts every worker's metrics route on the SAME
 * public host+port as its WS endpoint, disambiguated by path (`/<provider>-<host>/<service>-
 * <index>`) rather than a separate port -- so a registered `wss://host/<instance>/<worker>`
 * resolves to `https://host/<instance>/<worker>` (scheme swapped, host+path preserved), not a
 * `WS_PORT + 1` port rewrite.
 */
import { bcs } from '@mysten/sui/bcs';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiClient } from '@mysten/sui/client';

/** relay_registry::RelayNodeInfo — field order mirrors the deployed Move struct. */
const RelayNodeInfoSchema = bcs.struct('RelayNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  region: bcs.vector(bcs.u8()),
  endpoint_url: bcs.vector(bcs.u8()),
  reserved_primary_count: bcs.u64(),
  reserved_standby_count: bcs.u64(),
});

/**
 * Derive the metrics base URL from a relay's registered ws endpoint.
 * `ws(s)://host[/path]` -> `http(s)://host[/path]`, preserving host AND path
 * (path-based Caddy routing shares one public host across every worker on a
 * host -- dropping the path would probe a DIFFERENT worker's metrics, or a
 * nonexistent route, instead of this one's). Any trailing slash on the path
 * is trimmed so the caller's own `${base}/metrics/${roomId}` never doubles
 * up. Returns null if unparseable.
 */
export function metricsUrlFromEndpoint(endpointUrl: string): string | null {
  try {
    const parsed = new URL(endpointUrl);
    const scheme =
      parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
    const path = parsed.pathname.replace(/\/$/, '');
    return `${scheme}//${parsed.host}${path}`;
  } catch {
    return null;
  }
}

/**
 * devInspect `relay_registry::get_active_relays` and build
 * `Map<normalized miner_id, metricsBaseUrl>`. Returns an empty map on any failure — the
 * caller (resolveProbeEndpoint) falls back to the static `RELAY_METRICS_URL`.
 */
export async function readRelayMetricsUrls(
  client: SuiClient,
  packageId: string,
  relayRegistryId: string,
  sender: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${packageId}::relay_registry::get_active_relays`,
      arguments: [tx.object(relayRegistryId)],
    });
    const r = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (!bytes) return out;
    const relays = bcs.vector(RelayNodeInfoSchema).parse(Uint8Array.from(bytes)) as unknown as Array<{
      miner_id: string;
      endpoint_url: number[];
    }>;
    for (const relay of relays) {
      const url = Buffer.from(relay.endpoint_url).toString('utf8');
      const metrics = metricsUrlFromEndpoint(url);
      if (metrics) out.set(normalizeSuiAddress(relay.miner_id), metrics);
    }
  } catch {
    // swallow — caller falls back to the static RELAY_METRICS_URL
  }
  return out;
}
