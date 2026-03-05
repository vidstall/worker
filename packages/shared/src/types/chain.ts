/**
 * Chain interaction types for Sui network communication.
 */

/** Reference to a Sui object (used for owned object tracking). */
export interface SuiObjectRef {
  objectId: string;
  version: string;
  digest: string;
}

/** Network configuration loaded from environment variables. */
export interface NetworkConfig {
  rpcUrl: string;
  packageId: string;
  networkRegistryId: string;
  minerStoreId: string;
  cpRegistryId: string;
  relayRegistryId: string;
  validatorRegistryId: string;
  userRegistryId: string;
  roomManagerId: string;
}

/** Result of a successful transaction execution. */
export interface TxResult {
  digest: string;
  effects: Record<string, unknown>;
  events: Record<string, unknown>[];
}
