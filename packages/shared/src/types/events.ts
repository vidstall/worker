/**
 * TypeScript interfaces matching Move event structs from dvconf-contracts.
 *
 * Naming follows the on-chain event names exactly.
 * - Sui object IDs and addresses are `string` (hex).
 * - u64 values are `string` (JSON serialization of large numbers).
 * - u8 values are `number`.
 * - vector<u8> values are `number[]`.
 */

// ── Registration events (registration module) ──────────────────────

export interface MinerRegistered {
  miner_id: string;
  owner: string;
  role: number;
  stake_amount: string;
}

export interface MinerUnregistered {
  miner_id: string;
  owner: string;
}

export interface RoleChanged {
  miner_id: string;
  old_role: number;
  new_role: number;
  new_stake: string;
}

// ── Control Plane events (control_plane_registry module) ────────────

export interface CPRegistered {
  miner_id: string;
  operator: string;
  stake_amount: string;
}

export interface CPHeartbeat {
  miner_id: string;
  epoch: string;
}

export interface CPAssignedToRoom {
  miner_id: string;
  room_id: string;
}

// ── Relay events (relay_registry module) ────────────────────────────

export interface RelayRegistered {
  miner_id: string;
  operator: string;
  mode: number;
  region: number[];
  stake_amount: string;
}

export interface RelayLoadUpdated {
  miner_id: string;
  new_load: string;
}

export interface RelayRTTUpdated {
  miner_id: string;
  rtt: string;
}

// ── Validator events (validator_registry module) ────────────────────

export interface ValidatorRegistered {
  miner_id: string;
  operator: string;
  stake_amount: string;
}

export interface SessionWalletAssigned {
  session_wallet: string;
}

export interface SessionWalletRevealed {
  miner_id: string;
  session_wallet: string;
}

// ── Room events (room_manager module) ───────────────────────────────

export interface RoomCreated {
  room_id: string;
  creator: string;
  relay_mode: number;
}

export interface RoomClosed {
  room_id: string;
  closed_by: string;
  epoch: string;
}

export interface RoomRulesUpdated {
  min_relay: string;
  min_cp: string;
  min_validator: string;
}

// ── User events (user_registry module) ──────────────────────────────

export interface UserRegistered {
  user: string;
  display_name: number[];
}

export interface UserProfileUpdated {
  user: string;
  display_name: number[];
}

// ── Union type for all events ───────────────────────────────────────

export type DvconfEvent =
  | MinerRegistered
  | MinerUnregistered
  | RoleChanged
  | CPRegistered
  | CPHeartbeat
  | CPAssignedToRoom
  | RelayRegistered
  | RelayLoadUpdated
  | RelayRTTUpdated
  | ValidatorRegistered
  | SessionWalletAssigned
  | SessionWalletRevealed
  | RoomCreated
  | RoomClosed
  | RoomRulesUpdated
  | UserRegistered
  | UserProfileUpdated;
