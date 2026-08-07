/**
 * SuiClient factory and network configuration loader.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { config } from 'dotenv';
import type { NetworkConfig } from '../types/chain.js';

/** Create a SuiClient for the given network name. */
export function createSuiClient(network: string): SuiClient {
  let url: string;

  switch (network) {
    case 'localnet':
      url = 'http://127.0.0.1:9000';
      break;
    case 'testnet':
      url = getFullnodeUrl('testnet');
      break;
    case 'devnet':
      // devnet's public fullnode serves JSON-RPC under /json-rpc now; the
      // root path getFullnodeUrl('devnet') returns 404s as of sui-node 1.76.
      url = 'https://fullnode.devnet.sui.io:443/json-rpc';
      break;
    case 'mainnet':
      url = getFullnodeUrl('mainnet');
      break;
    default:
      // Treat as custom URL
      url = network;
  }

  return new SuiClient({ url });
}

/**
 * Create a SuiGraphQLClient for the given network name -- used ONLY for
 * event queries (EventPoller, see ../chain/events.ts). devnet's public
 * fullnode returns "Method not found" for the legacy JSON-RPC
 * `suix_queryEvents`, which is being phased out network-wide in favor of
 * GraphQL's `events(filter:)` field (see
 * https://docs.sui.io/develop/accessing-data/json-rpc-migration). Every
 * other RPC call (getObject, executeTransactionBlock, etc.) still works
 * fine over JSON-RPC, so this is a narrowly-scoped second client, not a
 * full migration off createSuiClient.
 */
export function createGraphQLClient(network: string): SuiGraphQLClient {
  let url: string;

  switch (network) {
    case 'localnet':
      // Not exercised by the devnet fix this accompanies -- verify against
      // your local `sui start` GraphQL indexer port before relying on this.
      url = 'http://127.0.0.1:9125';
      break;
    case 'testnet':
      url = 'https://fullnode.testnet.sui.io:443/graphql';
      break;
    case 'devnet':
      url = 'https://fullnode.devnet.sui.io:443/graphql';
      break;
    case 'mainnet':
      url = 'https://fullnode.mainnet.sui.io:443/graphql';
      break;
    default:
      // Treat as custom URL
      url = network;
  }

  return new SuiGraphQLClient({ url });
}

/**
 * Load network configuration from environment variables.
 * Call `dotenv.config()` before this if loading from .env file.
 */
export function loadNetworkConfig(): NetworkConfig {
  // Load .env from CWD first, then try monorepo root
  config();
  config({ path: '../../.env' });

  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const network = process.env['SUI_NETWORK'] ?? 'localnet';
  const client = createSuiClient(network);

  return {
    rpcUrl: (client as unknown as { url?: string }).url ?? network,
    packageId: required('PACKAGE_ID'),
    // Optional: only vidctl-managed deployments write this (see
    // cli/contract.py); see NetworkConfig.originalPackageId for why it must
    // stay distinct from packageId after an upgrade.
    originalPackageId: process.env['CONTRACT_ORIGINAL_PACKAGE_ID'] || undefined,
    // See NetworkConfig.livenessVotingOriginPackageId -- distinct from
    // originalPackageId because liveness_voting was added in a later
    // upgrade than the package's first-ever publish.
    livenessVotingOriginPackageId: process.env['LIVENESS_VOTING_ORIGIN_PACKAGE_ID'] || undefined,
    // See NetworkConfig.roomHealthAlertsOriginPackageId -- same rationale, for the
    // room_health_alerts module.
    roomHealthAlertsOriginPackageId: process.env['ROOM_HEALTH_ALERTS_ORIGIN_PACKAGE_ID'] || undefined,
    // Package split (see services/contract/role-voting): vidctl publishes
    // dvconf_role_voting as its own package and writes its id to
    // runtime/contract/<env>.env under the CONTRACT_B_ prefix (see
    // cli/contract/package.py's CONTRACT_B.env_prefix) -- that raw key name
    // passes straight through to this container's env (see
    // IaC/ansible/roles/docker_service/tasks/run_container.yml's
    // xaisen_contract_values combine()), no VITE_-style rename layer here.
    roleVotingPackageId: required('CONTRACT_B_PACKAGE_ID'),
    networkRegistryId: required('NETWORK_REGISTRY_ID'),
    minerStoreId: required('MINER_STORE_ID'),
    cpRegistryId: required('CP_REGISTRY_ID'),
    relayRegistryId: required('RELAY_REGISTRY_ID'),
    validatorRegistryId: required('VALIDATOR_REGISTRY_ID'),
    userRegistryId: required('USER_REGISTRY_ID'),
    roomManagerId: required('ROOM_MANAGER_ID'),
    signalingRegistryId: required('SIGNALING_REGISTRY_ID'),
    roleVoteBoxId: required('ROLE_VOTE_BOX_ID'),
    livenessVoteBoxId: required('LIVENESS_VOTE_BOX_ID'),
    // Optional: unset on any deployment that hasn't published/initialized
    // room_health_alerts.move yet (see NetworkConfig.roomHealthAlertBoxId).
    roomHealthAlertBoxId: process.env['ROOM_HEALTH_ALERT_BOX_ID'] || undefined,
  };
}
