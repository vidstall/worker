/**
 * SuiClient factory and network configuration loader.
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
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
      url = getFullnodeUrl('devnet');
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
 * Load network configuration from environment variables.
 * Call `dotenv.config()` before this if loading from .env file.
 */
export function loadNetworkConfig(): NetworkConfig {
  config(); // load .env

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
    networkRegistryId: required('NETWORK_REGISTRY_ID'),
    minerStoreId: required('MINER_STORE_ID'),
    cpRegistryId: required('CP_REGISTRY_ID'),
    relayRegistryId: required('RELAY_REGISTRY_ID'),
    validatorRegistryId: required('VALIDATOR_REGISTRY_ID'),
    userRegistryId: required('USER_REGISTRY_ID'),
    roomManagerId: required('ROOM_MANAGER_ID'),
  };
}
