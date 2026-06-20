/**
 * REQ-CFA-026..030 (M3 chunk 2, D-CFA-21/22/23) — loss-classifier tests.
 *
 * The W-E2 crux: M1 detection is DETERMINISTIC over a LOSSLESS hermetic loopback, so any
 * expected-ctr gap reads as withholding -> slash. On a real WAN, packets drop BENIGNLY.
 * M3 inserts a PURE off-chain classifier UPSTREAM of the byte-frozen 145-byte proof that
 * gates ONLY the DROP path (observedHash === 'MISSING'); the TAMPER path (present-but-wrong
 * bytes) stays deterministic p=1 and is NEVER softened.
 *
 * Chosen model (user gate F1 2026-06-20, Hybrid honest-framed; refined by the M3 build review):
 * a DROP is promoted IFF BOTH composed rules hold, RANKED by what is actually exercisable:
 *   (1) PRIMARY  — cumulative cross-round bound (1-(1-f)^n-style; a cumulative MEAN drop-rate
 *       threshold, not the literal binomial) keyed by relayMinerId (hermetic now): the
 *       cumulative drop rate over >= MIN_ROUNDS rounds strictly exceeds the benign budget;
 *   (2) SECONDARY (SIMULATED) — MISSING in >= k distinct co-homed receivers.
 * The validator-probed STUN loss prior is FOLDED INTO the budget (= stunPacketLossBps + deltaBps,
 * D-CFA-25), NOT a separate third gate (a separate term reading the same cumulative rate is
 * subsumed by PRIMARY; a per-window variant would defeat the cumulative tooth — review finding).
 * TAMPER is ALWAYS promoted p=1, 1-of-n, never gated; a frameSeq also reported TAMPER wins and
 * is never re-promoted as a drop (cross-teeth dedup, REQ-CFA-026).
 *
 * ALL SYNTHETIC — no ports, no mediasoup, no localnet. The cross-receiver signal is
 * SIMULATED-only (W-M3-SIM): verifyForwardedCanary has ZERO production callers (the verify
 * loop is Task 5.2+), so these tests prove the classifier LOGIC over synthetic per-receiver
 * lists, NOT live cross-receiver corroboration.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDivergences,
  newDropAccumulator,
  accumulateRound,
  type LossClassifierConfig,
  type PerReceiverDivergences,
  type DropAccumulator,
} from '../loss-classifier.js';
import { OBSERVED_HASH_MISSING } from '../proof.js';
import type { CanaryDivergence } from '../verifier.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const RELAY = 'relay-under-audit';

const drop = (frameSeq: number): CanaryDivergence => ({
  frameSeq,
  expectedHash: 'a'.repeat(64),
  observedHash: OBSERVED_HASH_MISSING,
});

const tamper = (frameSeq: number): CanaryDivergence => ({
  frameSeq,
  expectedHash: 'a'.repeat(64),
  observedHash: 'b'.repeat(64), // present-but-wrong bytes
});

/** A config with the cumulative bound already crossed (so isolated rules can be tested). */
const crossedAcc = (): DropAccumulator => {
  // 12 rounds at 100 sends each, ALL dropped → cumulative mean rate far above any benign budget.
  let acc = newDropAccumulator();
  for (let r = 0; r < 12; r++) {
    acc = accumulateRound(acc, RELAY, { observedDrops: 100, expectedSends: 100 });
  }
  return acc;
};

const CFG: LossClassifierConfig = {
  relayMinerId: RELAY,
  k: 2,
  deltaBps: 200n, // 2% benign-loss tolerance band over the STUN prior
  sendRate: 100, // frames per send-rate window (round)
};

const perReceiver = (entries: Array<[string, CanaryDivergence[]]>): PerReceiverDivergences =>
  new Map(entries);

describe('classifyDivergences — TAMPER tooth (REQ-CFA-027, D-CFA-22)', () => {
  it('(1) TAMPER is ALWAYS promoted regardless of any budget, 1-of-n, never gated', () => {
    // A single receiver sees ONE tampered frame. STUN prior is wide-open (high loss), the
    // accumulator is fresh (cumulative NOT crossed), k is unmet — none of it matters.
    const result = classifyDivergences(
      perReceiver([['v1', [tamper(7)]]]),
      9_000n, // huge STUN loss budget — would absorb any DROP
      newDropAccumulator(), // cumulative NOT crossed
      { ...CFG, k: 5 }, // k unmet (only 1 receiver)
    );
    expect(result.promoted.map((d) => d.frameSeq)).toEqual([7]);
    expect(result.absorbed).toHaveLength(0);
    // The promoted divergence keeps the present-but-wrong observedHash (NOT 'MISSING').
    expect(result.promoted[0]?.observedHash).not.toBe(OBSERVED_HASH_MISSING);
  });

  it('a TAMPER and a benign DROP in the same batch: TAMPER promoted, DROP absorbed', () => {
    const result = classifyDivergences(
      perReceiver([['v1', [tamper(3), drop(4)]]]),
      9_000n,
      newDropAccumulator(),
      CFG,
    );
    expect(result.promoted.map((d) => d.frameSeq)).toEqual([3]);
    expect(result.absorbed.map((d) => d.frameSeq)).toEqual([4]);
  });
});

describe('classifyDivergences — DROP tooth gating (REQ-CFA-028, D-CFA-21)', () => {
  it('(2) benign-independent drop (1 receiver, within band) → ZERO promoted', () => {
    // Only ONE receiver sees frame 4 missing (k unmet), drop-rate within the STUN band, and
    // the cumulative bound is not crossed → absorbed as benign.
    const result = classifyDivergences(
      perReceiver([['v1', [drop(4)]]]),
      300n, // STUN prior 3%
      newDropAccumulator(),
      CFG,
    );
    expect(result.promoted).toHaveLength(0);
    expect(result.absorbed.map((d) => d.frameSeq)).toEqual([4]);
  });

  it('drop seen by >=k receivers but cumulative NOT crossed → still absorbed', () => {
    // k met + over the STUN band, but signal (1) PRIMARY (cumulative) is fresh → NOT promoted.
    const result = classifyDivergences(
      perReceiver([
        ['v1', [drop(4)]],
        ['v2', [drop(4)]],
      ]),
      0n,
      newDropAccumulator(),
      CFG,
    );
    expect(result.promoted).toHaveLength(0);
    expect(result.absorbed.map((d) => d.frameSeq)).toEqual([4]);
  });

  it('(3) targeted-correlated (>=k receivers, exceeds band+delta, cumulative crossed) → exactly ONE promoted', () => {
    // Frame 4 MISSING in 2 distinct receivers (k=2 met), drop-rate over stun+delta, AND the
    // cumulative bound crossed → the ONE correlated frame is promoted exactly once.
    const result = classifyDivergences(
      perReceiver([
        ['v1', [drop(4)]],
        ['v2', [drop(4)]],
      ]),
      0n, // STUN prior 0% → drop-rate easily exceeds stun+delta
      crossedAcc(),
      CFG,
    );
    expect(result.promoted.map((d) => d.frameSeq)).toEqual([4]); // EXACTLY ONE, deduped across receivers
    expect(result.absorbed).toHaveLength(0);
  });

  it('promotes a frame ONLY when MISSING in >=k DISTINCT receivers (one receiver twice ≠ two)', () => {
    // Same receiver listed once with a duplicate divergence must NOT count as 2 distinct.
    const result = classifyDivergences(
      perReceiver([['v1', [drop(4), drop(4)]]]),
      0n,
      crossedAcc(),
      CFG,
    );
    expect(result.promoted).toHaveLength(0); // only 1 distinct receiver → k unmet
  });

  it('a high STUN prior raises the budget above the cumulative rate → absorbed (STUN folded into the budget, D-CFA-25)', () => {
    // crossedAcc() is 100% cumulative (10000bps). With a STUN prior of 9900bps the budget is
    // 9900 + delta(200) = 10100bps, so the cumulative rate (10000) does NOT strictly exceed the
    // budget → the cumulative bound does not cross → absorbed. This proves the STUN prior is
    // folded into the budget the cumulative tooth is measured against (not a separate gate).
    const result = classifyDivergences(
      perReceiver([
        ['v1', [drop(4)]],
        ['v2', [drop(4)]],
      ]),
      9_900n, // STUN prior 99% → budget 101% > the 100% cumulative rate → not crossed
      crossedAcc(),
      CFG,
    );
    expect(result.promoted).toHaveLength(0);
    expect(result.absorbed.map((d) => d.frameSeq)).toEqual([4]);
  });

  it('cross-teeth dedup (REQ-CFA-026): a frameSeq seen TAMPER by one receiver AND DROP by another is promoted ONCE, as the TAMPER (p=1)', () => {
    // Partial/lossy forward: receiver v1 got wrong bytes for frame 4 (TAMPER), v2 got nothing
    // (DROP). The cumulative bound is crossed and k=2 is met, so absent the dedup the drop would
    // ALSO promote → two proofs for one frameSeq. TAMPER must win: exactly ONE promoted entry.
    const result = classifyDivergences(
      perReceiver([
        ['v1', [tamper(4)]],
        ['v2', [drop(4)]],
      ]),
      0n,
      crossedAcc(),
      CFG,
    );
    const seqs = result.promoted.map((d) => d.frameSeq);
    expect(seqs).toEqual([4]); // exactly one entry for frameSeq 4
    expect(result.promoted[0]?.observedHash).not.toBe(OBSERVED_HASH_MISSING); // the TAMPER, not the drop
    expect(result.absorbed).toHaveLength(0); // the drop is neither re-promoted nor absorbed (tamper won)
  });
});

describe('cumulative accumulator — ShortMAC-style cumulative-rate bound over synthetic rounds (REQ-CFA-028 PRIMARY)', () => {
  it('keyed by relayMinerId: independent relays accumulate separately', () => {
    let acc = newDropAccumulator();
    // Accumulate enough rounds (>= MIN_ROUNDS_FOR_CUMULATIVE) so the confidence gate is met
    // for BOTH relays — the point of THIS test is per-relay ISOLATION, not the round floor.
    for (let r = 0; r < 6; r++) {
      acc = accumulateRound(acc, 'relay-X', { observedDrops: 50, expectedSends: 100 }); // 50%
      acc = accumulateRound(acc, 'relay-Y', { observedDrops: 1, expectedSends: 100 }); // 1%
    }
    // relay-X is at 50% cumulative; relay-Y at 1% — they do not bleed into each other.
    const resX = classifyDivergences(
      perReceiver([
        ['v1', [drop(4)]],
        ['v2', [drop(4)]],
      ]),
      0n,
      acc,
      { ...CFG, relayMinerId: 'relay-X' },
    );
    const resY = classifyDivergences(
      perReceiver([
        ['v1', [drop(4)]],
        ['v2', [drop(4)]],
      ]),
      0n,
      acc,
      { ...CFG, relayMinerId: 'relay-Y' },
    );
    // relay-X far over budget after one big round → promoted; relay-Y barely lossy → absorbed.
    expect(resX.promoted.map((d) => d.frameSeq)).toEqual([4]);
    expect(resY.promoted).toHaveLength(0);
  });

  it('(4) a sustained ABOVE-budget withholder is promoted only AFTER the MIN_ROUNDS confidence floor (rounds 0–3 absorbed, round 4 = the 5th promotes)', () => {
    // Each round the relay drops 4% (400bps), STRICTLY ABOVE the benign budget (STUN 1% + delta
    // 2% = 300bps). The cumulative rate is 400bps > 300bps from round 0, but the MIN_ROUNDS_FOR_
    // CUMULATIVE=5 confidence floor SUPPRESSES promotion until 5 rounds of history exist (so a
    // single unlucky window cannot slash). The co-auditor pair CHANGES per round (different
    // receiver ids), which only HELPS cross-round independence.
    let acc = newDropAccumulator();
    let promotedRound = -1;
    for (let round = 0; round < 40; round++) {
      acc = accumulateRound(acc, RELAY, { observedDrops: 4, expectedSends: 100 }); // 4% > 3% budget
      const a = `v${2 * round}`;
      const b = `v${2 * round + 1}`;
      const res = classifyDivergences(
        perReceiver([
          [a, [drop(round)]],
          [b, [drop(round)]],
        ]),
        100n, // STUN prior 1%; with CFG delta 2% → budget 300bps; 4% drop strictly exceeds it
        acc,
        CFG,
      );
      if (res.promoted.length > 0 && promotedRound < 0) promotedRound = round;
    }
    // rounds 0–3 = 1–4 rounds of history (< MIN_ROUNDS_FOR_CUMULATIVE) → absorbed; round 4 is the
    // 5th round of history → the cumulative bound is finally allowed to cross → promoted.
    expect(promotedRound).toBe(4);
  });

  it('W-E2-RES residual: a sustained SUB-budget withholder is NEVER promoted (the irreducible gap; the cumulative rate never strictly exceeds the budget)', () => {
    // The adversarial dual of the no-false-positive test: a MALICIOUS relay withholding just
    // UNDER the benign budget (1% drop vs a 1% STUN + 2% delta = 3% budget) evades forever — the
    // cumulative rate (100bps) never strictly exceeds the budget (300bps). This is W-E2-RES on
    // record: delta sizing is the irreducible knob (too loose = a censorship channel of size
    // delta). k is met and the co-auditors agree every round; only the budget saves the relay.
    let acc = newDropAccumulator();
    let everPromoted = false;
    for (let round = 0; round < 100; round++) {
      acc = accumulateRound(acc, RELAY, { observedDrops: 1, expectedSends: 100 }); // 1% < 3% budget
      const res = classifyDivergences(
        perReceiver([
          ['v1', [drop(round)]],
          ['v2', [drop(round)]],
        ]),
        100n, // STUN 1% + CFG delta 2% = 300bps budget; 1% drop never exceeds it
        acc,
        CFG,
      );
      if (res.promoted.length > 0) everPromoted = true;
    }
    expect(everPromoted).toBe(false);
  });

  it('a benign relay at the budget never crosses the cumulative bound across many rounds', () => {
    // A relay dropping exactly at the benign floor (1%) for 100 rounds must NOT be promoted
    // (no false positive — the cumulative bound tolerates the modeled benign rate).
    let acc = newDropAccumulator();
    let everPromoted = false;
    for (let round = 0; round < 100; round++) {
      acc = accumulateRound(acc, RELAY, { observedDrops: 1, expectedSends: 100 });
      const res = classifyDivergences(
        perReceiver([
          ['v1', [drop(round)]],
          ['v2', [drop(round)]],
        ]),
        100n, // STUN prior 1% == the benign rate → drop-rate never beats stun+delta
        acc,
        CFG,
      );
      if (res.promoted.length > 0) everPromoted = true;
    }
    expect(everPromoted).toBe(false);
  });
});

describe('classifyDivergences — output shape (REQ-CFA-026: feeds buildDivergenceProof)', () => {
  it('promoted entries are the SAME CanaryDivergence shape buildDivergenceProof consumes', () => {
    const result = classifyDivergences(
      perReceiver([['v1', [tamper(9)]]]),
      0n,
      newDropAccumulator(),
      CFG,
    );
    const d = result.promoted[0]!;
    expect(typeof d.frameSeq).toBe('number');
    expect(typeof d.expectedHash).toBe('string');
    expect(typeof d.observedHash).toBe('string');
    // One proof per promoted frameSeq — no duplicate frameSeqs in the promoted list.
    const seqs = result.promoted.map((x) => x.frameSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});
