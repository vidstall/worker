/**
 * Multi-CP Voting Live (N=5) — C4 live-demo PURE helpers, extracted from
 * run-multicp-voting.ts (pure code movement, no behavior change). All the
 * fragile parsing/quorum logic lives here so the impure orchestration (spawn /
 * devInspect / queryEvents polling / main()) stays thin and is exercised by
 * the controller's live run.
 */

import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { RoleAssigned, RoleVoteCast, RoomAssigned } from '../../../packages/shared/src/index.ts'; // relative SOURCE import — scripts/ sits OUTSIDE the pnpm workspace graph (mirrors seed-multicp.ts:56 / escrow-driver.ts:61).

/**
 * The genuine N=5 quorum the demo pins: required = max(1, ceil(active_cp * 6667 /
 * 10000)) (role_voting::compute_threshold / pairing PVR). At 5 active CPs → 4.
 * Single-sourced so the magic "4" is not scattered across the asserts (fact B/C).
 */
export const REQUIRED_QUORUM_AT_N5 = 4;

/**
 * The #7 ProposalSubmitted parsedJson shape (room_manager.move:148-154). NOT a
 * shared type → declared locally. `verified_score` carries the submitted score
 * (room_manager.move:441 — the field is named verified_score, NOT submitted_score).
 */
export interface ProposalSubmittedJson {
  room_id: string;
  cp_id: string;
  verified_score: string;
  relay_count: string;
  validator_count: string;
}

/**
 * Parse the escrow-driver's single STDOUT contract line `ROOM_ID=0x…`
 * (escrow-driver.ts:228). pino JSON logs share the same stdout, so match with the
 * ANCHORED multiline regex — never by reading the whole stream. The optional `\r?`
 * before `$` tolerates CRLF line endings (under /m, `$` matches before `\n`, so a
 * bare `$` would fail on a `\r\n` line). PURE.
 */
export function parseRoomId(stdout: string): string | null {
  const m = stdout.match(/^ROOM_ID=(\S+)\r?$/m);
  return m ? m[1]! : null;
}

/**
 * Decode an 8-byte little-endian BCS u64 (the devInspect count-getter return
 * shape). Fail-closed: THROWS on any length ≠ 8 (a self-verifying precondition
 * must never silently pass on a malformed read). PURE. Mirrors seed-multicp.ts's
 * inline decode (NOT value-imported — that module runs main() on import).
 */
export function decodeLeU64(bytes: readonly number[]): bigint {
  if (bytes.length !== 8) {
    throw new Error(`decodeLeU64: expected 8 bytes (u64 LE), got ${bytes.length}`);
  }
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) {
    v = (v << 8n) | BigInt(bytes[i] ?? 0);
  }
  return v;
}

/** The evidence surfaced from a passing #6 role-vote quorum. */
export interface RoleQuorumResult {
  role: number;
  voteCount: string;
  threshold: string;
  /** The distinct, normalized voter addresses that crossed the quorum (size === expectedCount). */
  voters: string[];
}

/**
 * HARD-ASSERT the live #6 role-vote quorum for the user-miner (fact B). Throws on
 * any divergence; returns the evidence on success. At N=5 the finalized
 * RoleAssigned has vote_count === threshold === '4' (u64 → decimal STRING), and
 * exactly 4 DISTINCT RoleVoteCast voters (the 5th CP's late cast aborts 711 → no
 * event). `casts` may contain other miners' votes (a queryEvents MoveEventType
 * filter is not miner-scoped) — they are filtered out here by miner_id. PURE.
 */
export function assertRoleQuorum(
  assigned: RoleAssigned,
  casts: readonly RoleVoteCast[],
  minerAddress: string,
  expectedCount: number,
): RoleQuorumResult {
  const expected = String(expectedCount);
  const miner = normalizeSuiAddress(minerAddress);

  if (normalizeSuiAddress(assigned.miner_id) !== miner) {
    throw new Error(
      `assertRoleQuorum: RoleAssigned.miner_id ${assigned.miner_id} is not the user-miner ${minerAddress}`,
    );
  }
  if (assigned.vote_count !== expected) {
    throw new Error(`assertRoleQuorum: vote_count=${assigned.vote_count}, expected ${expected} (the live 4-of-5 quorum)`);
  }
  if (assigned.threshold !== expected) {
    throw new Error(`assertRoleQuorum: threshold=${assigned.threshold}, expected ${expected} (only 4 when 5 CPs are active)`);
  }

  const voters = [
    ...new Set(
      casts
        .filter((c) => normalizeSuiAddress(c.miner_id) === miner)
        .map((c) => normalizeSuiAddress(c.voter)),
    ),
  ];
  if (voters.length !== expectedCount) {
    throw new Error(
      `assertRoleQuorum: ${voters.length} distinct voters for the user-miner, expected exactly ${expectedCount}`,
    );
  }

  return { role: assigned.role, voteCount: assigned.vote_count, threshold: assigned.threshold, voters };
}

/** The evidence surfaced from a passing #7 pairing quorum. */
export interface PairingQuorumResult {
  winningScore: string;
  winningCp: string;
  /** The distinct, normalized cp_ids that proposed the winning score (size >= expectedCount). */
  agreeingCpIds: string[];
}

/**
 * HARD-ASSERT the live #7 pairing quorum for a room (fact C). Throws on any
 * divergence; returns the evidence on success. A PVR-consensus finalize sets
 * consensus_reached === true and a real winning_cp (the zero ID is the admin
 * fallback), and ≥ expectedCount DISTINCT ProposalSubmitted.cp_id share the SAME
 * verified_score as the winning RoomAssigned.verified_score. `proposals` should
 * already be room-scoped by the caller; this only groups by score. PURE.
 */
export function assertPairingQuorum(
  assigned: RoomAssigned,
  proposals: readonly ProposalSubmittedJson[],
  expectedCount: number,
): PairingQuorumResult {
  if (assigned.consensus_reached !== true) {
    throw new Error(
      `assertPairingQuorum: consensus_reached=${assigned.consensus_reached}, expected true (a CP-quorum finalize, not the admin fallback)`,
    );
  }
  const winningCp = (assigned.winning_cp ?? '').trim();
  const zeroId = normalizeSuiAddress('0x0');
  if (winningCp === '' || normalizeSuiAddress(winningCp) === zeroId) {
    throw new Error(
      `assertPairingQuorum: winning_cp is empty/zero (${assigned.winning_cp}) — that is the admin fallback, not a CP-consensus finalize`,
    );
  }

  const winningScore = assigned.verified_score;
  const agreeingCpIds = [
    ...new Set(
      proposals
        .filter((p) => p.verified_score === winningScore)
        .map((p) => normalizeSuiAddress(p.cp_id)),
    ),
  ];
  if (agreeingCpIds.length < expectedCount) {
    throw new Error(
      `assertPairingQuorum: ${agreeingCpIds.length} distinct CPs proposed the winning score ${winningScore}, expected >= ${expectedCount}`,
    );
  }

  // The winning CP is the FIRST CP to submit the winning score (fact C) → its cp_id
  // MUST be in the agreeing set; otherwise the RoomAssigned.winning_cp is inconsistent
  // with the ProposalSubmitted record we tallied.
  const normalizedWinner = normalizeSuiAddress(winningCp);
  if (!agreeingCpIds.includes(normalizedWinner)) {
    throw new Error(
      `assertPairingQuorum: winning_cp ${winningCp} did not propose the winning score ${winningScore} (not among the ${agreeingCpIds.length} agreeing CPs)`,
    );
  }

  return { winningScore, winningCp: normalizedWinner, agreeingCpIds };
}

/**
 * Classify a daemon log line as an executeWithRetry benign-abort trace (fact G):
 * `<label> failed, retrying` (tx.ts:60, warn) or `<label> exhausted retries,
 * skipping` (tx.ts:63, error). Detects the substrings so it works whether or not
 * the line is pino-JSON-wrapped. Returns null for ordinary lines. PURE.
 */
export function classifyRetryLine(line: string): 'retrying' | 'exhausted' | null {
  if (line.includes('exhausted retries, skipping')) return 'exhausted';
  if (line.includes('failed, retrying')) return 'retrying';
  return null;
}

/** Aggregate benign-abort retry traces across every daemon's in-memory tail. */
export interface RetrySummary {
  retrying: number;
  exhausted: number;
}

/**
 * Count executeWithRetry retry/exhaustion traces across a set of daemon tails
 * (fact G honest re-scope): a deterministic Move abort (704/711/719/508) is
 * RETRIED 5× (warn) then swallowed (one benign "exhausted retries" error, null
 * return, NO throw, NO crash). This is a diagnostic SUMMARY only — it is NOT a
 * failure signal (the load-bearing benign-abort check is "every daemon still
 * alive"). PURE.
 */
export function summarizeRetryTails(tails: readonly (readonly string[])[]): RetrySummary {
  const summary: RetrySummary = { retrying: 0, exhausted: 0 };
  for (const tail of tails) {
    for (const line of tail) {
      const kind = classifyRetryLine(line);
      if (kind === 'retrying') summary.retrying++;
      else if (kind === 'exhausted') summary.exhausted++;
    }
  }
  return summary;
}
