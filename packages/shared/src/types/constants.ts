/**
 * Constants matching on-chain enum values and error code namespaces.
 */

/** Relay operating mode (matches relay_registry.move). */
export const RelayMode = {
  SFU: 0,
  MCU: 1,
} as const;
export type RelayMode = (typeof RelayMode)[keyof typeof RelayMode];

/** Miner role (matches registration.move role parameter). */
export const MinerRole = {
  User: 0,
  Validator: 1,
  Relay: 2,
  CP: 3,
} as const;
export type MinerRole = (typeof MinerRole)[keyof typeof MinerRole];

// ── Error code namespaces ───────────────────────────────────────────

export const ErrorCodes = {
  networkRegistry: {
    E_NOT_ADMIN: 100,
    E_INVALID_WEIGHTS: 101,
    E_PAUSED: 102,
  },
  staking: {
    E_INSUFFICIENT_STAKE: 200,
    E_STAKE_LOCKED: 201,
    E_NOT_OWNER: 202,
  },
  minerStore: {
    E_NOT_FOUND: 300,
  },
  registration: {
    E_ALREADY_REGISTERED: 400,
    E_STAKE_LOCKED: 401,
    E_NOT_OWNER: 402,
    E_PAUSED: 403,
    E_NOT_REGISTERED: 404,
  },
  roomManager: {
    E_PAUSED: 500,
    E_NOT_CREATOR: 501,
    E_NOT_FOUND: 502,
    E_ALREADY_CLOSED: 503,
    E_INVALID_MODE: 504,
    E_INVALID_MIN: 505,
    E_USER_NOT_REGISTERED: 506,
  },
  controlPlaneRegistry: {
    E_NOT_CP: 510,
    E_ALREADY_REGISTERED: 511,
    E_NOT_REGISTERED: 512,
    E_PAUSED: 513,
    E_NOT_ACTIVE: 514,
    E_ALREADY_ASSIGNED: 515,
  },
  relayRegistry: {
    E_NOT_RELAY: 520,
    E_ALREADY_REGISTERED: 521,
    E_NOT_REGISTERED: 522,
    E_PAUSED: 523,
    E_NOT_OPERATOR: 524,
    E_INVALID_MODE: 525,
  },
  validatorRegistry: {
    E_NOT_VALIDATOR: 530,
    E_ALREADY_REGISTERED: 531,
    E_NOT_REGISTERED: 532,
    E_PAUSED: 533,
    E_SESSION_EXISTS: 534,
    E_NO_SESSION: 535,
  },
  userRegistry: {
    E_ALREADY_REGISTERED: 540,
    E_NOT_REGISTERED: 541,
    E_PAUSED: 542,
  },
} as const;
