/**
 * Per-relay metrics endpoint resolution (closes part of G3).
 *
 * The validator must probe the metrics endpoint of the relay it is ATTESTING. The cp
 * assigns a DYNAMIC primary relay per room, so a single static `RELAY_METRICS_URL` only ever
 * matches one relay and returns 404 ("room not found") for every other -> bytesForwarded=0 ->
 * work-based reward gross=0 (G-DEMO-9). This reader maps each relay's on-chain ws endpoint to
 * its metrics base URL so `measureRelay` reaches whichever relay actually forwards the room.
 *
 * The relay metrics-server binds METRICS_PORT = WS_PORT + 1 (run-rms-live-local.ps1), so a
 * registered `ws://host:PORT` resolves to `http://host:(PORT+1)`.
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
});

/**
 * Derive the metrics base URL from a relay's registered ws endpoint.
 * `ws://host:PORT` -> `http://host:(PORT+1)`. Returns null if unparseable.
 */
export function metricsUrlFromEndpoint(endpointUrl: string): string | null {
  const m = endpointUrl.match(/^wss?:\/\/([^/:]+):(\d+)/i);
  if (!m) return null;
  const port = Number.parseInt(m[2], 10);
  if (!Number.isFinite(port)) return null;
  return `http://${m[1]}:${port + 1}`;
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
