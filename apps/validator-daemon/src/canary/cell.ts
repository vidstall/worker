/**
 * REQ-CFA-004 / D-CFA (Phase 5 / Task 5.1) — per-relay canary "cell" coverage glue
 * (validator-daemon).
 *
 * A canary "cell" is the set of validators that audit ONE relay's forward path: each
 * picked validator is CO-HOMED on that relay (it runs BOTH a covert publisher —
 * publisher.ts — and a consumer/verifier — verifier.ts). This module is the assignment
 * layer that decides WHICH validators home on WHICH relay, with one load-bearing
 * invariant, lifted straight from the on-chain reward-coverage rule:
 *
 *   RO-023c (economic_layer.move:420-461): a relay needs >= min_proofs_for_distribution()
 *   DISTINCT validator_ids attesting it, where distinctness is counted by VALIDATOR
 *   IDENTITY (the dedup of `validator_id`), NOT by raw proof count — "one validator
 *   covering both relays does NOT alone satisfy either" (OQ-M2-6).
 *
 * The canary analog: every relay's cell must hold >= {@link MIN_DISTINCT_CANARY_VALIDATORS}
 * DISTINCT `validator_miner_id`. Distinctness is counted by `minerId` (the validator's
 * STABLE on-chain identity), NEVER by `sessionWallet`. That dedup is the whole point of
 * the requirement: a single validator that rotates a second session wallet (Wallet-B)
 * presents two session-wallets but ONE miner_id, so it counts as ONE attester and CANNOT
 * self-satisfy the >=2-distinct floor — exactly the OQ-M2-6 self-coverage attack, closed
 * off-chain to mirror the chain.
 *
 * DETERMINISM (no central coordinator): assignment is a PURE function of
 * (relays, validators, round, assignmentSecret) via a stable SHA-256 score over
 * (round, relayId, minerId, assignmentSecret). Two daemons that share the SAME secret
 * derive the same cells, and any past round can be re-derived. ROTATION = bumping `round`:
 * it reshuffles which validators home on which relay (so audit pressure is spread, not
 * pinned to one pair) while the >=2-distinct coverage floor holds EVERY round (the top-N
 * pick is always taken from the deduped, distinct-by-miner_id pool, so it never drops a
 * relay below the floor when the pool can support it).
 *
 * COVERTNESS (REQ-CFA-022 / D-CFA-19): the score preimage folds a VALIDATOR-HELD
 * `assignmentSecret` the relay never holds. Even with ALL public inputs (the active
 * validator/relay set from get_active_validators, the round cadence), a relay CANNOT
 * recompute (predict) its own coverage -> it cannot selectively forward-honestly-when-
 * covered (closes the M2-review W-M2-10 recomputability hole). The secret is distributed
 * over the SAME covert Wallet-B channel that carries cellSecret/K_canary (D-CFA-10);
 * all validators hold it (they must agree on the assignment). It is REQUIRED — there is
 * NO public-input fallback that would re-open the hole — and it NEVER crosses the wire.
 *
 * ADDITIVE-SAFE: pure, allocation-only, throws on nothing operational (empty inputs →
 * empty / uncovered cells). It is started from index.ts behind a guard so a cell-loop
 * fault can NEVER crash the existing validator startup.
 *
 * LOGGING (HARD-GATE): NEVER log key material / cellSecret. This module holds none —
 * it deals only in relay ids, miner ids, and session-wallet addresses (all public).
 */

import { createHash } from 'node:crypto';
import { createLogger, type Logger } from '@dvconf/shared';

const MOD = 'canary/cell';

/**
 * The per-relay distinct-validator coverage floor, mirroring the on-chain
 * `constants::min_proofs_for_distribution()` (= 2) that economic_layer.move:423 reads as
 * `min_distinct`. Kept as a named constant so the off-chain canary floor and the on-chain
 * reward-coverage floor are visibly the SAME number.
 */
export const MIN_DISTINCT_CANARY_VALIDATORS = 2;

/** A validator eligible to home a canary cell. `minerId` is the stable on-chain identity;
 *  `sessionWallet` is the per-session address (rotatable — NEVER used for distinctness). */
export interface CanaryValidator {
  /** Stable on-chain validator identity (object id). The ONLY distinctness key. */
  minerId: string;
  /** Per-session wallet address (Wallet-B rotation lives here — NOT a distinctness key). */
  sessionWallet: string;
}

/** One validator's homing on a relay's cell: co-homed ⇒ it BOTH publishes and consumes. */
export interface CellValidator extends CanaryValidator {
  /** Co-homed: runs a covert canary publisher on this relay (publisher.ts). */
  publish: boolean;
  /** Co-homed: runs a consumer/verifier on this relay (verifier.ts). */
  consume: boolean;
}

/** The canary cell covering ONE relay's forward path. */
export interface CellAssignment {
  /** The relay whose forward path this cell audits. */
  relayId: string;
  /** The co-homed validators auditing this relay (distinct by `minerId`). */
  validators: CellValidator[];
  /** True iff the cell holds >= MIN_DISTINCT_CANARY_VALIDATORS DISTINCT `minerId`s. */
  covered: boolean;
}

/**
 * Domain separator for {@link deriveAssignmentSecret}. Folded into the digest so the
 * derived assignment-salt is cryptographically DISTINCT from any other use of the same
 * out-of-band canary `cellSecret` (e.g. the AES-GCM K_canary the keying module derives) —
 * the SAME domain-separation discipline as keying.ts's CANARY_SENDER_ID.
 */
const ASSIGNMENT_SECRET_DOMAIN = 'dvconf-canary/assignment-salt/v1';

/**
 * REQ-CFA-022 / D-CFA-19 — derive the validator-held `assignmentSecret` (the salt folded
 * into the {@link assignCells} score) DETERMINISTICALLY from the out-of-band covert canary
 * `cellSecret` (the SAME secret material distributed over the Wallet-B channel that the
 * keying module — keying.ts:37 — consumes as the OOB factor; D-CFA-10 trust model).
 *
 * It is domain-separated (so it is NOT the encryption key) and deterministic, so every
 * validator that holds the same `cellSecret` derives the SAME assignment secret and they
 * agree on the assignment — while a relay (no `cellSecret`) cannot derive it.
 *
 * Throws on an absent/empty `cellSecret` (the salt is REQUIRED — there is no public-input
 * fallback that would re-open the W-M2-10 recomputability hole). NEVER logs the secret.
 */
export function deriveAssignmentSecret(cellSecret: Uint8Array): Uint8Array {
  if (!(cellSecret instanceof Uint8Array) || cellSecret.length === 0) {
    throw new Error(`${MOD}: deriveAssignmentSecret requires a non-empty cellSecret (REQ-CFA-022)`);
  }
  return createHash('sha256')
    .update(ASSIGNMENT_SECRET_DOMAIN)
    .update('\x1f')
    .update(cellSecret) // raw OOB bytes — NEVER stringified / logged / wired
    .digest();
}

export interface AssignCellsInput {
  /** Relay miner ids to cover (one cell each). */
  relays: string[];
  /** The eligible validator pool (may contain Wallet-B duplicates — deduped here). */
  validators: CanaryValidator[];
  /** Rotation round (default 0). Bumping it deterministically reshuffles the assignment. */
  round?: number;
  /**
   * REQ-CFA-022 / D-CFA-19 — the VALIDATOR-HELD assignment secret folded into the score
   * preimage so a relay (which never holds it) cannot recompute/predict its own coverage.
   * REQUIRED + non-empty (an absent/empty secret throws — there is no public-input
   * fallback that would re-open the recomputability hole). Distributed over the covert
   * Wallet-B channel (same trust model as cellSecret/K_canary). NEVER crosses the wire.
   */
  assignmentSecret: Uint8Array;
}

/**
 * Stable, deterministic score for (round, relayId, minerId, assignmentSecret): the first
 * 8 bytes of SHA-256(round‖relayId‖minerId‖assignmentSecret) as a BigInt. Pure —
 * identical inputs (incl. the SAME secret) always yield the identical score, so the sort
 * (and thus the assignment) is reproducible by any validator that holds the secret and for
 * any past round. Folding `round` into the digest is what makes a round bump reshuffle the
 * ordering (rotation) without any shared state.
 *
 * REQ-CFA-022 / D-CFA-19: `assignmentSecret` is appended to the preimage as raw bytes
 * (kept SEPARATE from the public string fields by the \x1f delimiter, so a relay cannot
 * substitute a public value to mimic it). A relay that does not hold the secret derives a
 * DIFFERENT score ordering -> cannot reproduce/predict the assignment.
 */
function score(round: number, relayId: string, minerId: string, assignmentSecret: Uint8Array): bigint {
  const h = createHash('sha256')
    .update(`${round}\x1f${relayId}\x1f${minerId}\x1f`)
    .update(assignmentSecret) // raw secret bytes — NEVER stringified / logged / wired
    .digest();
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(h[i]!);
  return v;
}

/**
 * Dedup the validator pool by `minerId` — the load-bearing sybil/Wallet-B defense. A
 * miner that presents multiple session-wallets collapses to ONE entry (the FIRST seen
 * under a deterministic minerId sort, so the survivor is stable across runs). Distinctness
 * downstream is therefore always by stable identity, never by session-wallet.
 */
function dedupByMinerId(validators: CanaryValidator[]): CanaryValidator[] {
  const seen = new Map<string, CanaryValidator>();
  // Sort by (minerId, sessionWallet) first so the surviving entry per miner is deterministic.
  const ordered = [...validators].sort(
    (a, b) => a.minerId.localeCompare(b.minerId) || a.sessionWallet.localeCompare(b.sessionWallet),
  );
  for (const v of ordered) {
    if (!seen.has(v.minerId)) seen.set(v.minerId, v);
  }
  return [...seen.values()];
}

/**
 * Assign a canary cell to every relay: each cell is the top-N distinct-by-miner_id
 * validators by the per-(relay, round) stable score, co-homed (publish + consume). The
 * cell is `covered` iff it reaches the {@link MIN_DISTINCT_CANARY_VALIDATORS} floor;
 * an under-supplied relay yields an honest under-covered cell rather than a faked one
 * (we NEVER pad with a duplicate miner_id to fake distinctness — RO-023c parity).
 *
 * PURE: deterministic in (relays, validators, round, assignmentSecret); no I/O. Rotation =
 * a different `round` ⇒ a deterministically different homing that still holds the coverage
 * floor every round when the pool can support it.
 *
 * THROWS (REQ-CFA-022 / D-CFA-19) when `assignmentSecret` is absent/empty — the secret is
 * REQUIRED and there is NO public-input fallback (a fallback would re-open the W-M2-10
 * recomputability hole). Operational empties (no relays / no validators) still yield an
 * empty / under-covered result, never a throw.
 */
export function assignCells(input: AssignCellsInput): CellAssignment[] {
  const round = input.round ?? 0;
  const assignmentSecret = input.assignmentSecret;
  if (!(assignmentSecret instanceof Uint8Array) || assignmentSecret.length === 0) {
    // Covertness invariant: a missing/empty secret would collapse the score back to the
    // public-only preimage a relay can recompute — refuse rather than silently weaken.
    throw new Error(`${MOD}: assignCells requires a non-empty assignmentSecret (REQ-CFA-022)`);
  }
  // Distinct-by-miner_id pool — counted by stable identity, NEVER by session wallet.
  const pool = dedupByMinerId(input.validators);

  return input.relays.map((relayId) => {
    // Deterministic ordering for THIS relay+round: ascending stable (salted) score.
    const ranked = [...pool].sort((a, b) => {
      const sa = score(round, relayId, a.minerId, assignmentSecret);
      const sb = score(round, relayId, b.minerId, assignmentSecret);
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      // Score tie (astronomically unlikely): break by stable identity for determinism.
      return a.minerId.localeCompare(b.minerId);
    });

    // Take the top N distinct miners (N = the floor). Cap at the pool size — we do NOT
    // pad with a duplicate miner_id to fake coverage; an honest short cell stays short.
    const picked = ranked.slice(0, MIN_DISTINCT_CANARY_VALIDATORS);
    const validators: CellValidator[] = picked.map((v) => ({
      minerId: v.minerId,
      sessionWallet: v.sessionWallet,
      publish: true, // co-homed
      consume: true, // co-homed
    }));

    const distinct = new Set(validators.map((v) => v.minerId)).size;
    return {
      relayId,
      validators,
      covered: distinct >= MIN_DISTINCT_CANARY_VALIDATORS,
    };
  });
}

// ── Additive cell-loop (started from index.ts behind a guard) ──────────────────────

/** Snapshot of who-currently-covers-what + the round it was computed for. */
export interface CellRoundSnapshot {
  round: number;
  cells: CellAssignment[];
}

/** Supplies the current relay + validator pool each round (event-discovered, off-chain). */
export interface CanaryCellLoopDeps {
  /** Relay miner ids to cover this round (e.g. the daemon's known active relays). */
  getRelays: () => string[];
  /** The eligible validator pool this round (deduped by miner_id inside assignCells). */
  getValidators: () => CanaryValidator[];
}

/** Live handle: the latest snapshot for downstream pub/consume loops + a stop fn. */
export interface CanaryCellLoopHandle {
  /** The most recently computed assignment (null until the first tick runs). */
  latest: () => CellRoundSnapshot | null;
  /** Stop the rotation interval. */
  stop: () => void;
}

/**
 * Start the deterministic canary cell-rotation loop. Each tick BUMPS the round and
 * recomputes {@link assignCells} from the current (relay, validator) inputs, so coverage
 * rotates across rounds while the >=2-distinct floor holds. The latest snapshot is exposed
 * for the downstream covert-publish / verify loops (Task 5.2+).
 *
 * ADDITIVE + CRASH-SAFE: each tick is wrapped so a fault NEVER escapes the loop (and the
 * caller in index.ts wraps the whole start in a guard). Mirrors the startHeartbeat /
 * startHealthMonitor `start(...) => stop()` shape. The first round (0) runs immediately.
 *
 * REQ-CFA-022 / D-CFA-19: `assignmentSecret` (validator-held, REQUIRED, non-empty) is
 * threaded into every {@link assignCells} call so a relay cannot recompute coverage. It
 * lives only in this closure — NEVER logged and NEVER placed on a snapshot/wire surface.
 */
export function startCanaryCellLoop(args: {
  deps: CanaryCellLoopDeps;
  intervalMs: number;
  assignmentSecret: Uint8Array;
  logger?: Logger;
}): CanaryCellLoopHandle {
  const { deps, intervalMs, assignmentSecret } = args;
  const log = args.logger ?? createLogger(MOD);
  let round = 0;
  let snapshot: CellRoundSnapshot | null = null;

  const tick = (): void => {
    try {
      const relays = deps.getRelays();
      const validators = deps.getValidators();
      const cells = assignCells({ relays, validators, round, assignmentSecret });
      snapshot = { round, cells };
      const covered = cells.filter((c) => c.covered).length;
      log.info(
        { round, relays: relays.length, validators: validators.length, cells: cells.length, covered },
        'canary cell round assigned',
      );
      round += 1;
    } catch (err) {
      // Crash-safe: a cell-assignment fault must never take down the validator daemon.
      log.error({ err }, 'canary cell round failed (loop continues)');
    }
  };

  tick(); // round 0 immediately
  const handle = setInterval(tick, intervalMs);

  log.info({ intervalMs }, 'canary cell loop started');
  return {
    latest: () => snapshot,
    stop: () => {
      clearInterval(handle);
      log.info('canary cell loop stopped');
    },
  };
}
