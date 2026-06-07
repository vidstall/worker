/**
 * Forensic CLI types — JSONL schema v1.0 + report-stage normalized shapes.
 *
 * Schema is locked. Additive evolution only (new fields = OK; renames/removals = bump major).
 * Spec: docs/70-operations/forensic-cli.md § 6.
 */

import type {
  RelaySlashed,
  SessionProofSubmitted,
  RewardsDistributed,
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  RoomCreated,
  RoomAssigned,
  RoomClosed,
  NodeDegraded,
} from '@dvconf/shared';

/**
 * Extra event type not yet in @dvconf/shared/types/events.ts.
 * Mirrors `dvconf::relay_registry::RelayPerformanceDegraded` (Move struct).
 * Inline here to avoid touching the shared package mid-feature.
 */
export interface RelayPerformanceDegraded {
  room_id: string;
  relay_miner_id: string;
  rtt: string;
  load: string;
  epoch: string;
}

/** Canonical forensic transcript line — one JSON object per JSONL row. */
export interface ForensicLine {
  schema: 'forensic-cli/1.0';
  ts: string; // ISO-8601
  tx: string; // Sui tx digest
  seq: string; // Sui event seq within tx
  module: string;
  event: string;
  payload: Record<string, unknown>;
}

/** Known event payloads — used for type-narrowing in reports. */
export type KnownPayload =
  | RelaySlashed
  | SessionProofSubmitted
  | RewardsDistributed
  | RelayRegistered
  | RelayLoadUpdated
  | RelayRTTUpdated
  | RelayPerformanceDegraded
  | NodeDegraded // P17 M2a-P5 — single-owner mirror imported from @dvconf/shared
  | RoomCreated
  | RoomAssigned
  | RoomClosed;

// ── Report output shapes ────────────────────────────────────────────

export interface SlashReportRow {
  ts: string;
  tx: string;
  room_id: string;
  relay_miner_id: string;
  slash_amount: string;
}

export interface ProofReportRow {
  ts: string;
  tx: string;
  validator_id: string;
  relay_miner_id: string;
  bytes_transferred: string;
  packet_loss_bps: string;
}

export interface ProofReport {
  room_id: string;
  rows: ProofReportRow[];
  unique_validators: number;
  quorum_required: number; // from ADR-0006: 3
  insufficient_quorum: boolean; // unique_validators < quorum_required
  median_bytes_transferred: string | null; // null if < 1 proof
  median_packet_loss_bps: string | null;
}

export interface RelayHistoryEntry {
  ts: string;
  tx: string;
  event: string;
  detail: Record<string, unknown>;
}

export interface RelayHistoryReport {
  miner_id: string;
  timeline: RelayHistoryEntry[];
  registered: boolean;
  slashed: boolean;
  performance_degraded_count: number;
}

export interface RewardRow {
  ts: string;
  tx: string;
  room_id: string;
  relay_reward: string;
  validator_pool: string;
  cp_pool: string;
  signaling_pool: string;
  remainder: string;
  sum_check: 'ok' | 'mismatch';
  total: string;
}

export interface RewardReport {
  rows: RewardRow[];
  total_distributed: string;
  total_remainder: string;
  any_mismatch: boolean;
}
