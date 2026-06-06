/**
 * @dvconf/shared — Barrel export.
 *
 * Re-exports all types, chain helpers, and logger for consumption by daemon packages.
 */

// Types
export type {
  MinerRegistered,
  MinerUnregistered,
  RoleChanged,
  RoleVoteCast,
  RoleAssigned,
  RoleApplied,
  RevoteEligibleMarked,
  RoleTransitioned,
  CPRegistered,
  CPHeartbeat,
  CPAssignedToRoom,
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  ValidatorRegistered,
  SessionWalletAssigned,
  SessionWalletRevealed,
  RoomCreated,
  RoomAssigned,
  RoomClosed,
  RoomRulesUpdated,
  UserRegistered,
  UserProfileUpdated,
  SignalingRegistered,
  SignalingHeartbeat,
  SignalingLoadUpdated,
  SignalingUnregistered,
  EscrowCreated,
  SessionProofSubmitted,
  RewardsDistributed,
  RelaySlashed,
  SecretRotated,
  DvconfEvent,
} from './types/events.js';

export type {
  SuiObjectRef,
  NetworkConfig,
  TxResult,
} from './types/chain.js';

export { economicLayerModuleName } from './types/chain.js';

export {
  RelayMode,
  MinerRole,
  ErrorCodes,
  SIGNALING_SESSION_REWARD,
  MIN_PROOFS_FOR_DISTRIBUTION,
  QUALITY_EXCELLENT_BPS,
  QUALITY_GOOD_BPS,
  QUALITY_ACCEPTABLE_BPS,
  SLASH_PERCENTAGE_BPS,
} from './types/constants.js';

// Chain helpers
export { createSuiClient, loadNetworkConfig } from './chain/client.js';
export { loadKeypair, generateSessionKeypair } from './chain/keypair.js';
export { executeWithRetry, extractCreatedObjectByType } from './chain/tx.js';
export { EventPoller } from './chain/events.js';
export type { EventPollerOptions } from './chain/events.js';
export { waitForRoleAssignment, applyVotedRole } from './chain/role-assignment.js';

// Logger
export { createLogger, buildLoggerOptions } from './logger.js';
export type { Logger, LoggerEnv } from './logger.js';

// P17 M1 / F63 — cross-daemon trace primitive (x-trace-id chain).
export {
  TRACE_HEADER,
  genTraceId,
  readTraceId,
  withTraceHeader,
  traceChild,
} from './trace.js';
export type { IncomingHeaders } from './trace.js';

// P17 M1 / F65 — shared liveness server.
export { startHealthzServer, healthzBody } from './healthz.js';
export type { HealthzOptions, HealthzHandle } from './healthz.js';

// Cap-token primitive contract types (F62 W1 Stage 1 + Phase 2.4-retro). Append-only
// re-exports so daemon consumers (Phase 3.1 cap-token-issuer, Phase 3.2 signaling auth,
// Phase 3.3 signaling cache) can import QuorumSig + Capability* types from the root.
export type {
  QuorumSig,
  QuorumConfigState,
  QuorumSigEvent,
  QuorumVerifiedEvent,
  QuorumInsufficientEvent,
  QuorumConfigUpdatedEvent,
  QuorumSigErrorCode,
  CapabilityIssuedEvent,
  CapabilityRevokedEvent,
  CapabilityRefreshedEvent,
  CapabilityEvent,
  CapabilityErrorCode,
  CapTokenPrimitiveEvent,
  RoomCapabilityRefreshArgs,
} from './interfaces/cp-quorum-sig.contract.js';
export { QUORUM_SIG_ERRORS, CAPABILITY_ERRORS } from './interfaces/cp-quorum-sig.contract.js';

// Bench harness (Task #26)
export {
  LATENCY_EVENT_SCHEMA_VERSION,
  LatencyWriter,
  appendLatencyEvent,
  isBenchEnabled,
  resolveTraceId,
  resolveScenario,
  timeAsync,
  timeSync,
  startSampler,
} from './bench/index.js';
export type {
  LatencyEvent,
  LatencyMetric,
  LatencyScenario,
  LatencySource,
  LatencyWriterOptions,
} from './bench/index.js';

// Relay endpoint cache (REQ-RO-008 / D-RO-3 — relay-ID → WS-URL map + room →
// ordered relay-IDs, populated from RelayRegistered + RoomAssigned chain events).
// Extracted from apps/signaling (G3.2a) so the signaling + relay daemons share
// ONE impl. `DualRelayRouter` (ws-dependent) stays in apps/signaling.
export { InMemoryRelayEndpointCache, subscribeRelayEndpoints } from './chain/relay-endpoint-cache.js';
export type { RelayEndpointCache } from './chain/relay-endpoint-cache.js';
