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
export { createLogger } from './logger.js';
export type { Logger } from './logger.js';

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
