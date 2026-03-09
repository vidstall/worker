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
  RoomClosed,
  RoomRulesUpdated,
  UserRegistered,
  UserProfileUpdated,
  DvconfEvent,
} from './types/events.js';

export type {
  SuiObjectRef,
  NetworkConfig,
  TxResult,
} from './types/chain.js';

export {
  RelayMode,
  MinerRole,
  ErrorCodes,
} from './types/constants.js';

// Chain helpers
export { createSuiClient, loadNetworkConfig } from './chain/client.js';
export { loadKeypair, generateSessionKeypair } from './chain/keypair.js';
export { executeWithRetry, extractCreatedObjectByType } from './chain/tx.js';
export { EventPoller } from './chain/events.js';
export type { EventPollerOptions } from './chain/events.js';

// Logger
export { createLogger } from './logger.js';
export type { Logger } from './logger.js';
