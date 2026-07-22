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
  /**
   * The package ID that ORIGINALLY defined the on-chain structs (caps,
   * StakePosition, ...), as opposed to `packageId` which is the latest
   * upgraded bytecode version. Sui pins a struct's fully-qualified type to
   * its defining package forever, so an owned-object `StructType` filter
   * must use this -- not `packageId` -- or it silently returns nothing
   * after every contract upgrade even though the object is still valid.
   * Entry-function calls (`${packageId}::module::function`) still need the
   * latest `packageId`. Optional and falls back to `packageId` wherever
   * unset (e.g. a fresh deployment that has never been upgraded, or a test
   * fixture that doesn't care about the distinction) since they're
   * identical until the first upgrade.
   */
  originalPackageId?: string;
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
