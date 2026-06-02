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
  region: number[];
  stake_amount: string;
  endpoint_url: number[];  // relay WebSocket URL as UTF-8 bytes
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

// ── Role Voting events (role_voting module) ──────────────────────────

export interface RoleVoteCast {
  miner_id: string;
  role: number;
  voter: string;
  current_votes: string;
  required: string;
}

export interface RoleAssigned {
  miner_id: string;
  role: number;
  vote_count: string;
  threshold: string;
}

export interface RoleApplied {
  miner_id: string;
  role: number;
  owner: string;
}

// F47 re-vote events (role_voting module). Field names match the Move structs
// EXACTLY — a daemon decodes these by Sui-JSON key, so a rename breaks the wire
// contract (locked by the OQ-PH16 field-name test + the Move #[test_only] pins).
export interface RevoteEligibleMarked {
  miner_id: string;
  reason: number;        // u8 — 1=IDLE, 2=COMPOSITION_SHIFT, 3=MINER_REQUEST
  current_role: number;  // u8
  marked_at: string;     // u64 epoch
}

export interface RoleTransitioned {
  miner_id: string;
  old_role: number; // u8
  new_role: number; // u8
}

// ── Room events (room_manager module) ───────────────────────────────

export interface RoomCreated {
  room_id: string;
  creator: string;
  relay_mode: number;
}

export interface RoomAssigned {
  room_id: string;
  relay_ids: string[];
  signaling_id: string;
  relay_mode: number;
  verified_score: string;
  consensus_reached: boolean;
  winning_cp: string;
  validator_ids: string[];
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

// ── Signaling events (signaling_registry module) ────────────────────

export interface SignalingRegistered {
  miner_id: string;
  operator: string;
  endpoint_url: number[];
  region: number[];
  stake_amount: string;
}

export interface SignalingHeartbeat {
  miner_id: string;
  epoch: string;
}

export interface SignalingLoadUpdated {
  miner_id: string;
  new_load: string;
}

export interface SignalingUnregistered {
  miner_id: string;
  operator: string;
}

// ── Economic Layer events (economic_layer module) ───────────────────
// Per ADD IC-5: Event Name/Field Alignment Contract

export interface EscrowCreated {
  escrow_id: string;
  room_id: string;
  creator: string;
  amount: string;  // u64 serialized as string by Sui JSON
}

export interface SessionProofSubmitted {
  room_id: string;
  validator_id: string;
  relay_miner_id: string;
  bytes_transferred: string;
  packet_loss_bps: string;
}

export interface RewardsDistributed {
  room_id: string;
  relay_reward: string;
  validator_pool: string;
  cp_pool: string;
  signaling_pool: string;
  remainder: string;
}

/** Per ADD IMP-2: Use RelaySlashed (not NodeSlashed) matching on-chain event name. */
export interface RelaySlashed {
  room_id: string;
  relay_miner_id: string;
  slash_amount: string;
}

// ── TURN credential events (turn_credential module) ──────────────────
/**
 * F8 (REQ-CRR-004/005) — emergency relay-secret rotation, emitted by
 * dvconf::turn_credential::emergency_rotate_relay_secret. Field names + order
 * mirror the Move struct EXACTLY (a daemon decodes these by Sui-JSON key, so a
 * rename breaks the wire contract). NOTE the orthogonality (ADR-0010 D-009):
 * this rotates the TURN shared SECRET (`secret_id`), distinct from a
 * RoomCapability admission token — the daemon reaction lives in the TURN issuer
 * kill-switch, not the cap-token cache.
 *   reason: u8 — 0=leakage, 1=compromise, 2=admin.
 */
export interface SecretRotated {
  cp_miner_id: string; // ID (hex)
  old_secret_id: string; // u64
  new_secret_id: string; // u64
  reason: number; // u8
  rotated_at_epoch: string; // u64
}

// ── Union type for all events ───────────────────────────────────────

export type DvconfEvent =
  | MinerRegistered
  | MinerUnregistered
  | RoleChanged
  | RoleVoteCast
  | RoleAssigned
  | RoleApplied
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
  | RoomAssigned
  | RoomClosed
  | RoomRulesUpdated
  | UserRegistered
  | UserProfileUpdated
  | SignalingRegistered
  | SignalingHeartbeat
  | SignalingLoadUpdated
  | SignalingUnregistered
  | EscrowCreated
  | SessionProofSubmitted
  | RewardsDistributed
  | RelaySlashed
  | SecretRotated;
