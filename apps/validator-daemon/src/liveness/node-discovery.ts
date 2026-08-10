/**
 * Liveness sweep -- node discovery.
 *
 * DISCOVERY (mirrors canary/validator-discovery.ts's convention): each of the
 * three registries' `get_active_*` getters is read via a read-only `devInspect`
 * (no gas, no signature) using a hand-copied positional BCS schema matching the
 * Move struct's field order EXACTLY (load-bearing, same convention as
 * ValidatorInfoSchema there).
 *
 * Extracted from the former `liveness-sweep.ts` monolith. Re-exported from
 * `liveness-sweep.ts` so external import sites are unchanged.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { bcs } from '@mysten/sui/bcs';
import type { NetworkConfig, Logger } from '@dvconf/shared';

const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Role codes (dvconf::constants — role_user=0, role_validator=1, role_relay=2, role_cp=3).
// (role_signaling=4 was removed along with the standalone signaling node type.)
const ROLE_VALIDATOR = 1;
const ROLE_RELAY = 2;
const ROLE_CP = 3;

// ── BCS schemas (VERBATIM copies of each registry's *Info struct, positional / load-bearing order) ──

const ValidatorInfoSchema = bcs.struct('ValidatorInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  session_count: bcs.u64(),
});

// relay_registry.move:26-33
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

// control_plane_registry.move:27-33
const CPNodeInfoSchema = bcs.struct('CPNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  registered_at: bcs.u64(),
  reputation: bcs.u64(),
});

interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

/** A discovered node candidate for liveness voting. */
export interface LivenessCandidate {
  minerId: string;
  role: number;
}

/**
 * Read-only devInspect of one registry's `get_active_*` getter, decoded via
 * `schema` and projected to `{minerId, role}`. CRASH-SAFE:
 * resolves to `[]` on any failure (mirrors discoverActiveValidatorMinerIds).
 */
async function discoverRole(
  client: SuiClient,
  config: NetworkConfig,
  target: string,
  registryObjectId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any,
  role: number,
  logger: Logger,
): Promise<LivenessCandidate[]> {
  try {
    const tx = new Transaction();
    tx.moveCall({ target, arguments: [tx.object(registryObjectId)] });
    const r = (await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;

    if (r.error) {
      logger.warn({ target, err: r.error }, 'liveness-sweep discovery devInspect error');
      return [];
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) {
      logger.warn({ target }, 'liveness-sweep discovery devInspect returned no values');
      return [];
    }

    const infos = bcs.vector(schema).parse(Uint8Array.from(bytes)) as Array<{ miner_id: string }>;
    return infos.map((i) => ({
      minerId: normalizeSuiAddress(i.miner_id),
      role,
    }));
  } catch (err) {
    logger.warn({ target, err }, 'liveness-sweep discovery failed');
    return [];
  }
}

/** Discover all active nodes across all three role registries. */
export async function discoverAllActiveNodes(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<LivenessCandidate[]> {
  const pkg = config.packageId;
  const [validators, relays, cps] = await Promise.all([
    discoverRole(
      client, config,
      `${pkg}::validator_registry::get_active_validators`,
      config.validatorRegistryId, ValidatorInfoSchema, ROLE_VALIDATOR, logger,
    ),
    discoverRole(
      client, config,
      `${pkg}::relay_registry::get_active_relays`,
      config.relayRegistryId, RelayNodeInfoSchema, ROLE_RELAY, logger,
    ),
    discoverRole(
      client, config,
      `${pkg}::control_plane_registry::get_active_cps`,
      config.cpRegistryId, CPNodeInfoSchema, ROLE_CP, logger,
    ),
  ]);
  return [...validators, ...relays, ...cps];
}
