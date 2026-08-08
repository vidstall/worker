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
  /**
   * The package ID that first introduced the `liveness_voting` module.
   * Distinct from `originalPackageId` because `liveness_voting` was added
   * in a LATER upgrade than the package's first-ever publish -- its event
   * structs (e.g. `NodeEjectionApproved`) are pinned to THAT upgrade's
   * package address, not the package-wide original. Using
   * `originalPackageId` here silently matches zero events forever (see
   * EventPoller's packageId doc). Falls back to `originalPackageId` (then
   * `packageId`) for deployments where liveness_voting shipped at the
   * original publish (no prior upgrade history to diverge from).
   */
  livenessVotingOriginPackageId?: string;
  /**
   * The package ID that first introduced the `room_health_alerts` module. Same rationale as
   * `livenessVotingOriginPackageId` -- its events (`WorkerDownReported`, `WorkerConfirmedDead`)
   * are pinned to whichever upgrade first defined them, not the package-wide original.
   */
  roomHealthAlertsOriginPackageId?: string;
  /**
   * Package split (see services/contract/role-voting): `role_voting` and its
   * revote/governance/events satellites now live in their OWN published
   * package, `dvconf_role_voting`, not `packageId`. Every `role_voting::`
   * moveCall/event-filter target must use this instead of `packageId` --
   * unlike `livenessVotingOriginPackageId`/`roomHealthAlertsOriginPackageId`
   * (which track a module added in a LATER upgrade of the SAME package),
   * this is a genuinely different package with its own address, so there is
   * no `packageId` fallback that would ever be correct.
   */
  roleVotingPackageId: string;
  networkRegistryId: string;
  minerStoreId: string;
  cpRegistryId: string;
  relayRegistryId: string;
  validatorRegistryId: string;
  userRegistryId: string;
  roomManagerId: string;
  roleVoteBoxId: string;
  livenessVoteBoxId: string;
  /**
   * Shared RoomHealthAlertBox object ID (room_health_alerts.move). Optional: unset on any
   * deployment that hasn't published/initialized this module yet -- callers that need it
   * (report_worker_down, cast_health_vote, the WorkerConfirmedDead listener) skip/warn rather
   * than hard-fail when it's missing.
   */
  roomHealthAlertBoxId?: string;
}

/** Result of a successful transaction execution. */
export interface TxResult {
  digest: string;
  effects: Record<string, unknown>;
  events: Record<string, unknown>[];
  objectChanges: Record<string, unknown>[];
}

// ── Move module name constants ────────────────────────────────────

/**
 * Module name to use with EventPoller when watching for economic_layer's
 * events (EscrowCreated, etc.). NOT 'economic_layer' -- those structs are
 * actually DEFINED in the companion economic_layer_events module
 * (LOC-budget split, economic_layer/events.move), and events are pinned to
 * whichever module FIRST DEFINED the struct, not economic_layer.move (which
 * only calls the emit wrapper). Confirmed via live GraphQL introspection
 * against a real create_escrow tx: filtering by 'economic_layer' matched
 * zero events; 'economic_layer_events' matched EscrowCreated correctly.
 */
export const economicLayerModuleName = 'economic_layer_events' as const;
