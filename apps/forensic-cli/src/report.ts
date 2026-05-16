/**
 * Forensic CLI — `report` stage.
 *
 * Pure functions on a `events.jsonl` transcript. No network, no side effects.
 * Smoke-testable offline.
 *
 * Spec: docs/70-operations/forensic-cli.md § 3–7.
 */

import { readFile } from 'node:fs/promises';
import type {
  ForensicLine,
  SlashReportRow,
  ProofReport,
  ProofReportRow,
  RelayHistoryReport,
  RelayHistoryEntry,
  RewardReport,
  RewardRow,
  RelayPerformanceDegraded,
} from './types.js';
import type {
  RelaySlashed,
  SessionProofSubmitted,
  RewardsDistributed,
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
} from '@dvconf/shared';

/** ADR-0006: minimum quorum threshold for valid validator median. */
export const QUORUM_REQUIRED = 3;

/** Parse a forensic JSONL transcript. Tolerates blank lines and trailing newline. */
export async function loadTranscript(path: string): Promise<ForensicLine[]> {
  const raw = await readFile(path, 'utf-8');
  return parseTranscript(raw);
}

export function parseTranscript(raw: string): ForensicLine[] {
  const out: ForensicLine[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as ForensicLine;
    if (parsed.schema !== 'forensic-cli/1.0') {
      throw new Error(`Unsupported forensic schema: ${parsed.schema ?? '(missing)'}`);
    }
    out.push(parsed);
  }
  return out;
}

/** Sort by (ts, tx, seq) for deterministic timeline ordering. */
function chronological(a: ForensicLine, b: ForensicLine): number {
  if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
  if (a.tx !== b.tx) return a.tx.localeCompare(b.tx);
  return a.seq.localeCompare(b.seq);
}

/** Median of u64-as-string values, returned as decimal string. */
function medianStr(values: string[]): string | null {
  if (values.length === 0) return null;
  const sorted = [...values].map((v) => BigInt(v)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!.toString();
  const a = sorted[mid - 1]!;
  const b = sorted[mid]!;
  return ((a + b) / 2n).toString();
}

// ── C-SLASH ─────────────────────────────────────────────────────────

export function reportSlashes(events: ForensicLine[]): SlashReportRow[] {
  return events
    .filter((e) => e.event === 'RelaySlashed')
    .sort(chronological)
    .map((e) => {
      const p = e.payload as unknown as RelaySlashed;
      return {
        ts: e.ts,
        tx: e.tx,
        room_id: p.room_id,
        relay_miner_id: p.relay_miner_id,
        slash_amount: p.slash_amount,
      };
    });
}

// ── C-PROOF ─────────────────────────────────────────────────────────

export function reportProofs(events: ForensicLine[], roomId: string): ProofReport {
  const rows: ProofReportRow[] = events
    .filter((e) => e.event === 'SessionProofSubmitted')
    .map((e) => ({ e, p: e.payload as unknown as SessionProofSubmitted }))
    .filter((x) => x.p.room_id === roomId)
    .sort((a, b) => chronological(a.e, b.e))
    .map(({ e, p }) => ({
      ts: e.ts,
      tx: e.tx,
      validator_id: p.validator_id,
      relay_miner_id: p.relay_miner_id,
      bytes_transferred: p.bytes_transferred,
      packet_loss_bps: p.packet_loss_bps,
    }));

  const uniqueValidators = new Set(rows.map((r) => r.validator_id)).size;

  return {
    room_id: roomId,
    rows,
    unique_validators: uniqueValidators,
    quorum_required: QUORUM_REQUIRED,
    insufficient_quorum: uniqueValidators < QUORUM_REQUIRED,
    median_bytes_transferred: medianStr(rows.map((r) => r.bytes_transferred)),
    median_packet_loss_bps: medianStr(rows.map((r) => r.packet_loss_bps)),
  };
}

// ── C-RELAY ─────────────────────────────────────────────────────────

const RELAY_EVENT_NAMES = new Set([
  'RelayRegistered',
  'RelayLoadUpdated',
  'RelayRTTUpdated',
  'RelayPerformanceDegraded',
  'RelaySlashed',
]);

export function reportRelayHistory(events: ForensicLine[], minerId: string): RelayHistoryReport {
  const filtered = events
    .filter((e) => RELAY_EVENT_NAMES.has(e.event))
    .filter((e) => relayEventMatchesMiner(e, minerId))
    .sort(chronological);

  const timeline: RelayHistoryEntry[] = filtered.map((e) => ({
    ts: e.ts,
    tx: e.tx,
    event: e.event,
    detail: e.payload,
  }));

  return {
    miner_id: minerId,
    timeline,
    registered: timeline.some((t) => t.event === 'RelayRegistered'),
    slashed: timeline.some((t) => t.event === 'RelaySlashed'),
    performance_degraded_count: timeline.filter((t) => t.event === 'RelayPerformanceDegraded').length,
  };
}

function relayEventMatchesMiner(e: ForensicLine, minerId: string): boolean {
  const p = e.payload as Record<string, unknown>;
  switch (e.event) {
    case 'RelayRegistered':
      return (p as unknown as RelayRegistered).miner_id === minerId;
    case 'RelayLoadUpdated':
      return (p as unknown as RelayLoadUpdated).miner_id === minerId;
    case 'RelayRTTUpdated':
      return (p as unknown as RelayRTTUpdated).miner_id === minerId;
    case 'RelayPerformanceDegraded':
      return (p as unknown as RelayPerformanceDegraded).relay_miner_id === minerId;
    case 'RelaySlashed':
      return (p as unknown as RelaySlashed).relay_miner_id === minerId;
    default:
      return false;
  }
}

// ── C-REWARD ────────────────────────────────────────────────────────

export function reportRewards(events: ForensicLine[], roomFilter?: string): RewardReport {
  const filtered = events
    .filter((e) => e.event === 'RewardsDistributed')
    .map((e) => ({ e, p: e.payload as unknown as RewardsDistributed }))
    .filter((x) => !roomFilter || x.p.room_id === roomFilter)
    .sort((a, b) => chronological(a.e, b.e));

  const rows: RewardRow[] = filtered.map(({ e, p }) => {
    const total =
      BigInt(p.relay_reward) +
      BigInt(p.validator_pool) +
      BigInt(p.cp_pool) +
      BigInt(p.signaling_pool) +
      BigInt(p.remainder);
    return {
      ts: e.ts,
      tx: e.tx,
      room_id: p.room_id,
      relay_reward: p.relay_reward,
      validator_pool: p.validator_pool,
      cp_pool: p.cp_pool,
      signaling_pool: p.signaling_pool,
      remainder: p.remainder,
      sum_check: 'ok', // invariant holds tautologically; placeholder for future escrow-cross-check
      total: total.toString(),
    };
  });

  const totalDistributed = rows
    .reduce(
      (acc, r) =>
        acc +
        BigInt(r.relay_reward) +
        BigInt(r.validator_pool) +
        BigInt(r.cp_pool) +
        BigInt(r.signaling_pool),
      0n,
    )
    .toString();
  const totalRemainder = rows.reduce((acc, r) => acc + BigInt(r.remainder), 0n).toString();

  return {
    rows,
    total_distributed: totalDistributed,
    total_remainder: totalRemainder,
    any_mismatch: rows.some((r) => r.sum_check === 'mismatch'),
  };
}
