/**
 * REQ-CFA-004 (Phase 5 / Task 5.1) — per-relay canary "cell" coverage glue tests.
 *
 * The on-chain RO-023c coverage rule (economic_layer.move:420-461) requires a relay to
 * have >= min_proofs_for_distribution() DISTINCT validator_ids attesting it before it can
 * earn — and that distinctness is counted by VALIDATOR identity (the dedup of
 * `validator_id` into `r_validators`), NOT by raw proof count: "one validator covering
 * both relays does NOT alone satisfy either" (OQ-M2-6). This off-chain cell-assignment
 * glue is the canary-plane analog: it must give EVERY relay a cell covered by >= 2
 * DISTINCT validator_miner_id (co-homed = each picked validator runs BOTH a covert
 * publisher and a consumer/verifier on that relay), counted by `miner_id` — the validator's
 * stable on-chain identity — NOT by the per-session `sessionWallet`.
 *
 * THE LOAD-BEARING ATTACK this test pins (mirrors the on-chain OQ-M2-6 caveat): a SINGLE
 * validator that rotates a second session wallet (Wallet-B) presents TWO session-wallets
 * but ONE miner_id. Counting session-wallets would let it self-satisfy the >=2 rule and
 * forge "independent" coverage of its own relay. The assignment MUST dedup by miner_id, so
 * that single validator counts as ONE distinct attester and CANNOT satisfy >=2 alone.
 *
 * DETERMINISM + ROTATION: assignment is a pure function of (relays, validators, round) via
 * a stable score, so two daemons computing the same inputs agree (no central coordinator),
 * AND rotating the round reassigns which validators home on which relay WITHOUT ever
 * dropping a relay below the >=2-distinct-miner_id coverage floor.
 */

import { describe, it, expect } from 'vitest';
import {
  assignCells,
  MIN_DISTINCT_CANARY_VALIDATORS,
  type CanaryValidator,
  type CellAssignment,
} from '../cell.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────────
const RELAYS = ['relay-A', 'relay-B', 'relay-C'];

/**
 * REQ-CFA-022 / D-CFA-19 — a deterministic validator-held assignment secret threaded
 * into every assignCells call (it is now a REQUIRED, non-empty input). These coverage /
 * dedup / rotation invariants are secret-independent (they hold for ANY fixed secret); the
 * secret's covertness effect (different secret ⇒ different covered set) is pinned
 * separately in cell-salt.test.ts.
 */
const SECRET = new Uint8Array(16).fill(0xab);

/** N distinct validators, each with one session wallet (miner_id !== sessionWallet). */
const distinctValidators = (n: number): CanaryValidator[] =>
  Array.from({ length: n }, (_, i) => ({
    minerId: `miner-${i}`,
    sessionWallet: `0xwallet-${i}`,
  }));

/** Count DISTINCT miner_ids in a cell (the on-chain RO-023c r_distinct analog). */
const distinctMinerIds = (cell: CellAssignment): number =>
  new Set(cell.validators.map((v) => v.minerId)).size;

describe('REQ-CFA-004 assignCells — >=2 distinct validator_miner_id coverage per relay', () => {
  it('the coverage floor mirrors the on-chain min_proofs_for_distribution (>=2)', () => {
    expect(MIN_DISTINCT_CANARY_VALIDATORS).toBe(2);
  });

  it('(a) every relay gets a cell of >= 2 DISTINCT validator_miner_id (co-homed pub+consumer)', () => {
    const validators = distinctValidators(4);
    const cells = assignCells({ relays: RELAYS, validators, assignmentSecret: SECRET });

    expect(cells.map((c) => c.relayId).sort()).toEqual([...RELAYS].sort());
    for (const cell of cells) {
      expect(distinctMinerIds(cell)).toBeGreaterThanOrEqual(MIN_DISTINCT_CANARY_VALIDATORS);
      // Co-homing: each picked validator is BOTH publisher and consumer on this relay.
      for (const v of cell.validators) {
        expect(v.publish).toBe(true);
        expect(v.consume).toBe(true);
      }
    }
  });

  it('(b) a SINGLE validator rotating Wallet-B (2 session-wallets, SAME miner_id) does NOT satisfy >=2 distinct (counted by miner_id)', () => {
    // ONE validator, presented as TWO entries differing only by sessionWallet — the
    // OQ-M2-6 self-coverage attack. Distinctness is by miner_id, so this is ONE attester.
    const sybil: CanaryValidator[] = [
      { minerId: 'miner-X', sessionWallet: '0xwallet-A' },
      { minerId: 'miner-X', sessionWallet: '0xwallet-B' }, // rotated wallet, same miner
    ];
    const cells = assignCells({ relays: ['relay-solo'], validators: sybil, assignmentSecret: SECRET });

    const cell = cells.find((c) => c.relayId === 'relay-solo')!;
    // Counted by miner_id: only ONE distinct attester exists, so the floor is NOT met.
    expect(distinctMinerIds(cell)).toBe(1);
    expect(distinctMinerIds(cell)).toBeLessThan(MIN_DISTINCT_CANARY_VALIDATORS);
    expect(cell.covered).toBe(false);
    // And it must never have padded the cell with the duplicate wallet to fake coverage.
    expect(cell.validators.length).toBeLessThanOrEqual(1);
  });

  it('(b) two DISTINCT miner_ids DO satisfy the floor (positive control for the sybil case)', () => {
    const validators = distinctValidators(2);
    const cells = assignCells({ relays: ['relay-solo'], validators, assignmentSecret: SECRET });
    const cell = cells.find((c) => c.relayId === 'relay-solo')!;
    expect(distinctMinerIds(cell)).toBe(2);
    expect(cell.covered).toBe(true);
  });

  it('(c) assignment is DETERMINISTIC — same (relays, validators, round) ⇒ identical cells', () => {
    const validators = distinctValidators(5);
    const a = assignCells({ relays: RELAYS, validators, round: 3, assignmentSecret: SECRET });
    const b = assignCells({ relays: RELAYS, validators, round: 3, assignmentSecret: SECRET });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('(c) rotation reassigns DETERMINISTICALLY across rounds WITHOUT dropping coverage', () => {
    const validators = distinctValidators(6);
    const rounds = [0, 1, 2, 3, 4];
    const fingerprints = new Set<string>();

    for (const round of rounds) {
      const cells = assignCells({ relays: RELAYS, validators, round, assignmentSecret: SECRET });
      // Coverage floor holds EVERY round.
      for (const cell of cells) {
        expect(distinctMinerIds(cell)).toBeGreaterThanOrEqual(MIN_DISTINCT_CANARY_VALIDATORS);
        expect(cell.covered).toBe(true);
      }
      // Record a per-round fingerprint of who-covers-what (sorted miner_ids per relay).
      const fp = cells
        .map((c) => `${c.relayId}:${c.validators.map((v) => v.minerId).sort().join(',')}`)
        .sort()
        .join('|');
      fingerprints.add(fp);
    }

    // Rotation actually MOVES the assignment across rounds (it is not a constant map):
    // with 6 validators over 3 relays and 5 rounds, at least two distinct fingerprints.
    expect(fingerprints.size).toBeGreaterThanOrEqual(2);
  });

  it('(c) rotation is a pure function of round — re-deriving any past round reproduces it (no central coordinator)', () => {
    const validators = distinctValidators(6);
    const round2First = assignCells({ relays: RELAYS, validators, round: 2, assignmentSecret: SECRET });
    // ...derive other rounds in between...
    assignCells({ relays: RELAYS, validators, round: 7, assignmentSecret: SECRET });
    assignCells({ relays: RELAYS, validators, round: 99, assignmentSecret: SECRET });
    const round2Again = assignCells({ relays: RELAYS, validators, round: 2, assignmentSecret: SECRET });
    expect(JSON.stringify(round2Again)).toBe(JSON.stringify(round2First));
  });

  it('(d) marks a relay UNCOVERED (does not crash) when the validator pool is too thin for the floor', () => {
    // Only ONE distinct validator across the whole pool ⇒ no relay can reach >=2.
    const validators = distinctValidators(1);
    const cells = assignCells({ relays: RELAYS, validators, assignmentSecret: SECRET });
    for (const cell of cells) {
      expect(cell.covered).toBe(false);
      expect(distinctMinerIds(cell)).toBeLessThan(MIN_DISTINCT_CANARY_VALIDATORS);
    }
  });

  it('(d) empty inputs yield no cells (additive-safe: never throws)', () => {
    expect(assignCells({ relays: [], validators: distinctValidators(4), assignmentSecret: SECRET })).toEqual([]);
    expect(() => assignCells({ relays: RELAYS, validators: [], assignmentSecret: SECRET })).not.toThrow();
  });
});
