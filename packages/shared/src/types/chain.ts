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
  signalingRegistryId: string;
  roleVoteBoxId: string;
}

/** Result of a successful transaction execution. */
export interface TxResult {
  digest: string;
  effects: Record<string, unknown>;
  events: Record<string, unknown>[];
  objectChanges: Record<string, unknown>[];
}

// ── Move module name constants ────────────────────────────────────

/** Module name for economic_layer.move (used with EventPoller). */
export const economicLayerModuleName = 'economic_layer' as const;
