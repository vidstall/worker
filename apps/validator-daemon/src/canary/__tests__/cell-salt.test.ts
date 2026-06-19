/**
 * REQ-CFA-022 / D-CFA-19 — salted cell assignment (covertness) tests.
 *
 * The M2 design review found a CRITICAL covertness gap (W-M2-10): in M1 `assignCells`
 * was a PUBLIC, DETERMINISTIC function of PUBLIC inputs (round, relayId, minerId), so a
 * malicious relay could RECOMPUTE its own coverage every round from the public active-set
 * + the round cadence and selectively forward honestly ONLY when it sees it is covered —
 * a direct D-CFA-2 break that chunk 2 (live discovery) activates.
 *
 * The fix (D-CFA-19): fold a VALIDATOR-HELD `assignmentSecret` into the score preimage —
 *   score = SHA-256( round ‖ relayId ‖ minerId ‖ assignmentSecret )
 * distributed over the SAME covert Wallet-B channel that carries cellSecret/K_canary
 * (D-CFA-10). All validators hold it (they must agree on the assignment to co-home
 * consistently); the RELAY never holds it -> a relay cannot recompute/predict its own
 * coverage even from the (still-public) active-set + round.
 *
 * THIS TEST PINS:
 *   (a) assignment is DETERMINISTIC given the SAME secret (validators agree).
 *   (b) a DIFFERENT secret yields a DIFFERENT covered set (the ordering reshuffles) —
 *       so a relay holding a wrong/guessed secret cannot reproduce the real assignment.
 *   (c) an ABSENT/empty secret is rejected (the secret is REQUIRED — no public-input
 *       fallback that would re-open the recomputability hole).
 *   (d) the secret is NEVER leaked into the CellAssignment output (it must not cross any
 *       wire-bound surface — INV-C off-chain hygiene).
 *
 * HERMETIC: pure function, no I/O, no chain, no ports.
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

/** A deterministic validator-held assignment secret (>=128-bit). */
const SECRET_1 = new Uint8Array(16).fill(0x11);
const SECRET_2 = new Uint8Array(16).fill(0x22);

/** N distinct validators (miner_id !== sessionWallet). */
const distinctValidators = (n: number): CanaryValidator[] =>
  Array.from({ length: n }, (_, i) => ({
    minerId: `miner-${i}`,
    sessionWallet: `0xwallet-${i}`,
  }));

/** A stable fingerprint of who-covers-what (sorted miner_ids per relay). */
const fingerprint = (cells: CellAssignment[]): string =>
  cells
    .map((c) => `${c.relayId}:${c.validators.map((v) => v.minerId).sort().join(',')}`)
    .sort()
    .join('|');

describe('REQ-CFA-022 salted assignCells — relay cannot recompute coverage without the secret', () => {
  it('(a) assignment is DETERMINISTIC given the SAME secret (validators agree)', () => {
    // A larger pool than the floor so the secret-driven SCORE actually selects WHICH
    // miners are picked (otherwise every miner is trivially picked and the salt is moot).
    const validators = distinctValidators(6);
    const a = assignCells({ relays: RELAYS, validators, round: 3, assignmentSecret: SECRET_1 });
    const b = assignCells({ relays: RELAYS, validators, round: 3, assignmentSecret: SECRET_1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('(b) a DIFFERENT secret yields a DIFFERENT covered set (a relay with a wrong secret cannot reproduce it)', () => {
    // 6 distinct miners over 3 relays: the top-2-by-score pick depends on the secret, so
    // swapping the secret reshuffles WHICH 2 miners cover each relay.
    const validators = distinctValidators(6);
    const withSecret1 = assignCells({ relays: RELAYS, validators, round: 0, assignmentSecret: SECRET_1 });
    const withSecret2 = assignCells({ relays: RELAYS, validators, round: 0, assignmentSecret: SECRET_2 });

    // Coverage floor STILL holds under either secret (the salt only changes WHO, not whether).
    for (const cell of [...withSecret1, ...withSecret2]) {
      expect(cell.covered).toBe(true);
    }
    // But the SELECTED set differs — a relay holding the wrong secret derives a different map.
    expect(fingerprint(withSecret1)).not.toBe(fingerprint(withSecret2));
  });

  it('(c) the assignmentSecret is REQUIRED — an absent/empty secret is rejected (no public-input fallback)', () => {
    const validators = distinctValidators(4);
    // @ts-expect-error — deliberately omitting assignmentSecret to prove it is required.
    expect(() => assignCells({ relays: RELAYS, validators, round: 0 })).toThrow();
    expect(() =>
      assignCells({ relays: RELAYS, validators, round: 0, assignmentSecret: new Uint8Array(0) }),
    ).toThrow();
  });

  it('(d) the assignmentSecret NEVER appears in the CellAssignment output (INV-C wire hygiene)', () => {
    const validators = distinctValidators(4);
    const cells = assignCells({ relays: RELAYS, validators, round: 0, assignmentSecret: SECRET_1 });
    const serialized = JSON.stringify(cells);
    // The raw secret bytes (as hex AND as a UTF-8-ish string) must not be present.
    const secretHex = Buffer.from(SECRET_1).toString('hex');
    expect(serialized).not.toContain(secretHex);
    // And no field literally named like the secret leaked onto a cell/validator.
    for (const cell of cells) {
      expect(cell).not.toHaveProperty('assignmentSecret');
      for (const v of cell.validators) {
        expect(v).not.toHaveProperty('assignmentSecret');
      }
    }
  });

  it('(e) salting does not break the >=2-distinct coverage floor', () => {
    const validators = distinctValidators(5);
    const cells = assignCells({ relays: RELAYS, validators, round: 1, assignmentSecret: SECRET_1 });
    for (const cell of cells) {
      const distinct = new Set(cell.validators.map((v) => v.minerId)).size;
      expect(distinct).toBeGreaterThanOrEqual(MIN_DISTINCT_CANARY_VALIDATORS);
      expect(cell.covered).toBe(true);
    }
  });
});
