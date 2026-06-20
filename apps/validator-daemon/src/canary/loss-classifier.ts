/**
 * REQ-CFA-026..030 (M3 chunk 2, D-CFA-21/22/23) — pure off-chain loss classifier
 * (validator-daemon). The W-E2 crux: a BENIGN network drop must NOT be mistaken for a
 * tampering divergence and slashed.
 *
 * This module sits UPSTREAM of `buildDivergenceProof` (proof.ts:164) and DOWNSTREAM of
 * `verifyForwardedCanary` (verifier.ts:189). It decides which `CanaryDivergence`s are
 * PROMOTED to slashable (one proof per promoted frameSeq) and which are ABSORBED as benign
 * loss. It NEVER touches the byte-frozen 145-byte canonical message — it only FILTERS the
 * divergence list the proof builder consumes (the trusted off-chain gate, D-CFA-23 /
 * W-M3-OFFCHAIN, tied to W-E4 — on record).
 *
 * TWO TEETH, SPLIT (D-CFA-20):
 *   - TAMPER (observedHash !== 'MISSING' — a delivered frame with WRONG bytes) is ALWAYS
 *     promoted p=1, 1-of-n, NEVER gated. Benign loss cannot manufacture wrong-bytes-on-a-
 *     delivered-frame, so this stays deterministic (REQ-CFA-027 / D-CFA-22). This is the
 *     STRUCTURAL part of the closure.
 *   - DROP (observedHash === 'MISSING' — a frame never forwarded) is STATISTICAL: promoted
 *     IFF BOTH composed rules hold, RANKED by what is actually exercisable —
 *       (1) PRIMARY  — the cumulative cross-round bound 1-(1-f)^n keyed by relayMinerId
 *           (a pure accumulator, FULLY HERMETIC now): the relay's cumulative observed drop
 *           rate over >= MIN_ROUNDS_FOR_CUMULATIVE rounds STRICTLY exceeds the benign budget;
 *       (2) SECONDARY (SIMULATED-only, W-M3-SIM) — MISSING in >= k DISTINCT co-homed
 *           receivers (verifyForwardedCanary has ZERO production callers; fed by synthetic
 *           per-receiver fixtures here, the live verify loop is Task 5.2+).
 *     Otherwise ABSORBED (no proof built).
 *
 *     The benign budget = the validator-probed STUN loss prior + cfg.deltaBps. The STUN prior
 *     (D-CFA-25, W-M3-STUN-PATH) is FOLDED INTO THE BUDGET the cumulative bound is measured
 *     against — it is NOT a separate third gate. (The M3 build review found that a separate
 *     "weak-prior" term reading the SAME cumulative rate is logically SUBSUMED by PRIMARY, and
 *     that a per-WINDOW variant would DEFEAT the cumulative tooth's whole purpose — catching a
 *     SUSTAINED sub-window withholder — so STUN belongs in the budget, not as an AND-gate.
 *     STUN-UDP != canary-RTP and is a single global probe, so it is a coarse prior, not a
 *     binding deterrent: on record.)
 *
 * PURE: deterministic in its inputs (the STUN loss is a plain bigint arg; the cumulative
 * state is an explicit immutable-style accumulator). No I/O, no clock, no ports — unit-
 * testable over SYNTHETIC per-receiver lists, a synthetic loss number, and a synthetic
 * round sequence. Emits the SAME `CanaryDivergence` shape `buildDivergenceProof` consumes.
 *
 * LOGGING (HARD-GATE): holds NO key material (cellSecret/K_canary live in keying.ts). Only
 * non-secret classification metadata is logged (relayMinerId, promoted/absorbed counts).
 */

import { createLogger } from '@dvconf/shared';
import { OBSERVED_HASH_MISSING } from './proof.js';
import type { CanaryDivergence } from './verifier.js';

const log = createLogger('canary/loss-classifier');

/** Each cell verifier's `VerifyResult.divergences[]`, keyed by the verifier's `minerId`. */
export type PerReceiverDivergences = Map<string, CanaryDivergence[]>;

/** Tuning for the composed DROP gate. */
export interface LossClassifierConfig {
  /**
   * The relay this batch audits — the KEY into the cumulative accumulator (D-CFA-21:
   * keyed by the STABLE relayMinerId, NOT by cell, which reshuffles every round).
   */
  relayMinerId: string;
  /**
   * SECONDARY signal floor: a DROP is correlated only when MISSING in >= k DISTINCT
   * receivers (k >= MIN_DISTINCT_ATTESTERS = 2). SIMULATED-only (W-M3-SIM).
   */
  k: number;
  /**
   * WEAK PRIOR band (basis points) added to the STUN loss prior. The windowed canary
   * drop-rate must exceed `stunPacketLossBps + deltaBps` for the weak-prior floor to pass.
   * The irreducible knob (W-E2-RES): too loose = a censorship channel of size delta;
   * too tight = WAN false positives burning a fixed 10% bond. Calibrated by the WAN run.
   */
  deltaBps: bigint;
  /**
   * The canary send-rate window: expected frames per round. RESERVED for the deferred live
   * verify loop (Task 5.2+, W-M3-SIM) as the per-window denominator — the hermetic classifier
   * does NOT read it (the cumulative accumulator carries the real denominator in
   * `RoundObservation.expectedSends`). The "round" for the ShortMAC `n` is this send-rate
   * window, NOT the 5-min cell rotation (D-CFA-21).
   */
  sendRate: number;
}

/** The classification result: which divergences slash, which are absorbed as benign. */
export interface ClassifyResult {
  /** Divergences promoted to slashable — one proof per `frameSeq` (deduped). */
  promoted: CanaryDivergence[];
  /** Divergences absorbed as benign loss — NO proof built. */
  absorbed: CanaryDivergence[];
}

// ── PRIMARY: the per-relay cumulative cross-round accumulator (ShortMAC adaptation) ──
//
// Across `n` send-rate rounds the cumulative observed drop fraction converges to the relay's
// TRUE drop rate. A withholder dropping ABOVE the modeled benign floor is caught cumulatively
// even when each single window is sub-delta (W-E2-RES: this is the ONLY catcher of sustained
// sub-budget withholding). An honest relay AT the benign floor never strictly exceeds it, so
// it is never promoted (no false positive). Keyed by relayMinerId (stable across cell
// reshuffles). Crash-safe / immutable-style: each `accumulateRound` returns a NEW accumulator.

/** Per-relay cumulative drop state. */
export interface DropAccumulator {
  /** relayMinerId -> { observed cumulative drops, cumulative expected sends, rounds seen }. */
  byRelay: Map<string, { drops: number; sends: number; rounds: number }>;
}

/** One round's observed drop tally for a relay (synthetic in tests; live = per send-rate window). */
export interface RoundObservation {
  /** Frames observed MISSING this round (the DROP count). */
  observedDrops: number;
  /** Frames expected this round (the send-rate window denominator). */
  expectedSends: number;
}

/**
 * Minimum rounds of history before the cumulative bound is allowed to fire. Below this the
 * sample is too small for 1-(1-f)^n to be statistically meaningful (a single unlucky window
 * must not slash). A modest floor — the WAN run calibrates it alongside delta.
 */
export const MIN_ROUNDS_FOR_CUMULATIVE = 5;

/** A fresh, empty accumulator. */
export function newDropAccumulator(): DropAccumulator {
  return { byRelay: new Map() };
}

/**
 * Fold one round's observation into the accumulator for `relayMinerId`, returning a NEW
 * accumulator (the previous one is left untouched — crash-safe, no shared mutation). PURE.
 */
export function accumulateRound(
  acc: DropAccumulator,
  relayMinerId: string,
  round: RoundObservation,
): DropAccumulator {
  const next = new Map(acc.byRelay);
  const prev = next.get(relayMinerId) ?? { drops: 0, sends: 0, rounds: 0 };
  next.set(relayMinerId, {
    drops: prev.drops + Math.max(0, round.observedDrops),
    sends: prev.sends + Math.max(0, round.expectedSends),
    rounds: prev.rounds + 1,
  });
  return { byRelay: next };
}

/**
 * The relay's cumulative observed drop rate in basis points (integer bigint math — no float
 * drift), or `null` when there is no history yet. Read by the PRIMARY cumulative gate, which
 * adds the MIN_ROUNDS confidence requirement on top.
 */
function cumulativeDropRateBps(acc: DropAccumulator, relayMinerId: string): bigint | null {
  const state = acc.byRelay.get(relayMinerId);
  if (!state || state.sends === 0) return null;
  return (BigInt(state.drops) * 10_000n) / BigInt(state.sends);
}

/**
 * The cumulative-bound predicate (PRIMARY signal): TRUE iff, over >= MIN_ROUNDS_FOR_CUMULATIVE
 * rounds of history for this relay, the cumulative observed drop rate STRICTLY exceeds the
 * benign budget. The cumulative tooth is what makes a SUSTAINED sub-window withholder, who
 * evades each single window, eventually crossable. An honest relay whose true rate sits at
 * or below the budget never strictly exceeds it → never crosses (no false positive).
 */
function cumulativeBoundCrossed(
  acc: DropAccumulator,
  relayMinerId: string,
  budgetBps: bigint,
): boolean {
  const state = acc.byRelay.get(relayMinerId);
  if (!state || state.rounds < MIN_ROUNDS_FOR_CUMULATIVE) return false;
  const rateBps = cumulativeDropRateBps(acc, relayMinerId);
  return rateBps !== null && rateBps > budgetBps;
}

// ── SECONDARY (SIMULATED): cross-receiver agreement ────────────────────────────────

/**
 * Group the per-receiver divergences into, for each DROP frameSeq, the SET of DISTINCT
 * receiver miner_ids that saw it MISSING (a receiver listing the same frame twice counts
 * ONCE). TAMPER frames are collected separately keyed by frameSeq (one canonical divergence
 * each — they are promoted unconditionally). PURE.
 */
function groupByFrame(perReceiver: PerReceiverDivergences): {
  tampers: Map<number, CanaryDivergence>;
  dropReceivers: Map<number, Set<string>>;
  dropDivergence: Map<number, CanaryDivergence>;
} {
  const tampers = new Map<number, CanaryDivergence>();
  const dropReceivers = new Map<number, Set<string>>();
  const dropDivergence = new Map<number, CanaryDivergence>();

  for (const [receiverMinerId, divergences] of perReceiver) {
    for (const d of divergences) {
      if (d.observedHash !== OBSERVED_HASH_MISSING) {
        // TAMPER — present-but-wrong bytes; one canonical divergence per frameSeq.
        if (!tampers.has(d.frameSeq)) tampers.set(d.frameSeq, d);
        continue;
      }
      // DROP — track the DISTINCT receiver set + a canonical divergence for the proof.
      let set = dropReceivers.get(d.frameSeq);
      if (!set) {
        set = new Set<string>();
        dropReceivers.set(d.frameSeq, set);
        dropDivergence.set(d.frameSeq, d);
      }
      set.add(receiverMinerId);
    }
  }
  return { tampers, dropReceivers, dropDivergence };
}

/**
 * Classify a batch of per-receiver canary divergences for ONE relay into PROMOTED (slashable,
 * one proof per frameSeq) vs ABSORBED (benign). See the module header for the full model.
 *
 *   - TAMPER (observedHash !== MISSING): ALWAYS promoted, p=1, 1-of-n, NEVER gated.
 *   - DROP (observedHash === MISSING): promoted IFF
 *       (PRIMARY)   the cumulative 1-(1-f)^n bound keyed by relayMinerId is crossed
 *                   (cumulative rate over >= MIN_ROUNDS rounds > stunPacketLossBps + deltaBps), AND
 *       (SECONDARY) MISSING in >= cfg.k DISTINCT receivers (simulated).
 *     The STUN prior is FOLDED INTO the budget (D-CFA-25), not a separate gate.
 *     A frameSeq also reported TAMPER wins (p=1) and is NOT re-promoted as a drop.
 *     Else ABSORBED.
 *
 * The cumulative accumulator MUST already include this window's observation (the caller folds
 * the round in via `accumulateRound` before classifying — kept explicit so the function is
 * pure and the accumulator is testable in isolation). PURE: no I/O, no clock.
 */
export function classifyDivergences(
  perReceiver: PerReceiverDivergences,
  stunPacketLossBps: bigint,
  roundAccumulator: DropAccumulator,
  cfg: LossClassifierConfig,
): ClassifyResult {
  const { tampers, dropReceivers, dropDivergence } = groupByFrame(perReceiver);

  const promoted: CanaryDivergence[] = [];
  const absorbed: CanaryDivergence[] = [];

  // TAMPER tooth — always promoted (D-CFA-22), one per frameSeq.
  for (const d of tampers.values()) promoted.push(d);

  // The benign budget the DROP tooth gates against = STUN prior + delta (basis points).
  const budgetBps = stunPacketLossBps + cfg.deltaBps;

  // The PRIMARY cumulative bound is a per-relay property (independent of any single frameSeq):
  // cumulative observed rate over >= MIN_ROUNDS rounds strictly exceeds the budget (which has
  // the STUN prior folded in — D-CFA-25, NOT a separate gate).
  const cumulativeCrossed = cumulativeBoundCrossed(roundAccumulator, cfg.relayMinerId, budgetBps);

  for (const [frameSeq, receiverSet] of dropReceivers) {
    // Cross-teeth dedup (REQ-CFA-026, "one proof per frameSeq"): if this frameSeq was ALSO
    // reported TAMPER by some receiver (a partial/lossy-forward where one co-auditor got wrong
    // bytes and another got nothing), TAMPER WINS — it is already promoted p=1 above. Never
    // double-promote one frameSeq as both a tamper and a drop.
    if (tampers.has(frameSeq)) continue;

    const d = dropDivergence.get(frameSeq)!;

    // (SECONDARY, simulated, W-M3-SIM) MISSING in >= k DISTINCT receivers.
    const correlated = receiverSet.size >= cfg.k;

    // DROP promoted IFF the PRIMARY cumulative bound (rate > STUN+delta budget over
    // >= MIN_ROUNDS rounds) AND the SECONDARY cross-receiver agreement both hold.
    if (cumulativeCrossed && correlated) {
      promoted.push(d); // one proof per promoted frameSeq (deduped — one entry per frameSeq)
    } else {
      absorbed.push(d);
    }
  }

  log.info(
    {
      relayMinerId: cfg.relayMinerId,
      promoted: promoted.length,
      absorbed: absorbed.length,
      tampers: tampers.size,
      cumulativeCrossed,
    },
    'canary divergences classified (drop gate / tamper p=1)',
  );

  return { promoted, absorbed };
}
