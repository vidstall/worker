/**
 * Pre-assignment relay liveness probe (REQ-RMS liveness gate, opt-in via
 * RMS_RELAY_HEALTH_PROBE=1 -- see room-assignment.ts's usage).
 *
 * cp-daemon's existing pool-health gate (admission-capacity.ts's
 * poolHealthGate) only checks on-chain heartbeat freshness, which a relay
 * keeps refreshing even while its registered endpoint_url is stale garbage
 * (relay_heartbeat() writes last_heartbeat, never endpoint_url -- see
 * relay_registry.move's update_endpoint_url doc comment). This module adds
 * an actual HTTP reachability check against a candidate's real endpoint
 * before it's handed to a bot, so a stale-but-heartbeating relay is caught
 * and swapped for the next-best candidate instead of crashing the caller
 * with a dead connection.
 *
 * BCS schema mirrors relay-chain-state-reader.ts's RelayNodeInfoSchema
 * (kept independent/duplicated on purpose -- same rationale as that file's
 * own header comment: a divergence surfaces in the live integration smoke
 * rather than silently coupling two otherwise-decoupled readers).
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { NetworkConfig, Logger } from '@dvconf/shared';

const MODULE = 'relay-liveness-probe';

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

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

interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

function decodeUtf8(bytes: number[]): string {
  return Buffer.from(bytes).toString('utf8');
}

/** Reads relay_registry::get_active_relays and returns miner_id -> endpoint_url. */
export async function getActiveRelayEndpoints(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<Map<string, string>> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::relay_registry::get_active_relays`,
    arguments: [tx.object(config.relayRegistryId)],
  });
  const r = (await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ZERO,
  })) as DevInspectLike;
  if (r.error) {
    logger.warn({ module: MODULE, err: r.error }, 'get_active_relays devInspect failed; treating as no known endpoints');
    return new Map();
  }
  const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
  if (bytes === undefined) return new Map();

  const decoded = bcs.vector(RelayNodeInfoSchema).parse(Uint8Array.from(bytes)) as Array<{
    miner_id: string;
    endpoint_url: number[];
  }>;
  return new Map(decoded.map((n) => [normalizeSuiAddress(n.miner_id), decodeUtf8(n.endpoint_url)]));
}

/**
 * GETs `<endpoint's host+path>/healthz` (the same public route Caddyfile.j2
 * proxies to the relay's metrics-server, alongside /metrics) with a short
 * timeout. `endpointUrl` is a `wss://`/`ws://` URL (relay_registry's
 * on-chain endpoint_url shape) -- rewritten to `https://`/`http://` since
 * the probe is a plain HTTP GET, not a WebSocket handshake. The path is
 * PRESERVED (not dropped) -- path-based Caddy routing shares one public
 * hostname across every worker on a host, disambiguated by
 * `/<provider>-<host>/<service>-<index>`; dropping it would probe a
 * different worker's /healthz (or a nonexistent route) instead of this one's.
 */
export async function probeRelayHealthz(endpointUrl: string, timeoutMs = 2500): Promise<boolean> {
  let healthzUrl: string;
  try {
    const parsed = new URL(endpointUrl);
    const scheme = parsed.protocol === 'wss:' ? 'https:' : parsed.protocol === 'ws:' ? 'http:' : parsed.protocol;
    const path = parsed.pathname.replace(/\/$/, '');
    healthzUrl = `${scheme}//${parsed.host}${path}/healthz`;
  } catch {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(healthzUrl, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probes each of `candidateIds` (in order) and returns the endpoint map plus
 * which ids are actually reachable right now. Candidates absent from the
 * active-relay endpoint map (deregistered mid-flight) count as unreachable.
 */
export async function probeCandidates(
  client: SuiClient,
  config: NetworkConfig,
  candidateIds: string[],
  logger: Logger,
): Promise<Set<string>> {
  const endpoints = await getActiveRelayEndpoints(client, config, logger);
  const alive = await Promise.all(
    candidateIds.map(async (id) => {
      const endpointUrl = endpoints.get(id);
      if (!endpointUrl) return null;
      const ok = await probeRelayHealthz(endpointUrl);
      if (!ok) {
        logger.warn({ module: MODULE, minerId: id, endpointUrl }, 'relay liveness probe failed -- excluding from this assignment');
      }
      return ok ? id : null;
    }),
  );
  return new Set(alive.filter((id): id is string => id !== null));
}
