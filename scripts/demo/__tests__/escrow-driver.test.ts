import { describe, it, expect } from 'vitest';
import { extractMoveAbortCode } from '../escrow-driver.ts';

/**
 * Build a realistic `signAndAssert`-style failure string for a given Move abort code.
 * Mirrors the captured shape: signAndAssert embeds `effects.status.error`, which carries
 * `MoveAbort(MoveLocation { … function: N, instruction: M, … }, <code>) in command K`.
 * The INTERIOR `function: 5,` / `instruction: 12,` are decoys — the parser's greedy `.*`
 * must backtrack to the TRAILING `, <code>)`, not match an interior number.
 */
const abortStr = (code: number): string =>
  'register_user failed on-chain: status=failure error=MoveAbort(MoveLocation { ' +
  'module: ModuleId { address: 38e7d8a3f0b2c1d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6, ' +
  'name: Identifier("user_registry") }, function: 5, instruction: 12, ' +
  `function_name: Some("register_user") }, ${code}) in command 0`;

describe('extractMoveAbortCode', () => {
  it('parses a signAndAssert-style 540 (E_ALREADY_REGISTERED) string → 540', () => {
    expect(extractMoveAbortCode(new Error(abortStr(540)))).toBe(540);
  });

  it.each([540, 704, 711, 719, 521])(
    'backtracks greedily to the trailing code %i (not the interior function:/instruction: numbers)',
    (code) => {
      expect(extractMoveAbortCode(new Error(abortStr(code)))).toBe(code);
    },
  );

  it('reads a raw string (the non-Error branch) just as well as an Error', () => {
    expect(extractMoveAbortCode(abortStr(540))).toBe(540);
  });

  it.each([
    'Error: fetch failed',
    'RpcError: Request timed out after 30000ms',
    'failed to confirm transaction within the configured timeout',
  ])('returns null for a non-abort failure (%s) so the caller rethrows real failures', (msg) => {
    expect(extractMoveAbortCode(new Error(msg))).toBeNull();
  });

  it('returns null for a malformed MoveAbort with no trailing `, <code>)` (no false positive)', () => {
    expect(extractMoveAbortCode(new Error('MoveAbort(weird) in command 0'))).toBeNull();
  });

  it('returns null for a non-string/non-Error value (String() yields no MoveAbort)', () => {
    expect(extractMoveAbortCode({ foo: 1 })).toBeNull();
  });

  // Documents the registerUserIdempotent swallow predicate WITHOUT needing a live client:
  // production does `if (extractMoveAbortCode(err) === 540) return; throw err;`, so a
  // non-540 abort (e.g. 521 = relay_registry::E_ALREADY_REGISTERED) is distinguishable
  // and would rethrow — only 540 is swallowed.
  it('discriminates 540 from a non-540 abort (proves only 540 is swallowed)', () => {
    expect(extractMoveAbortCode(new Error(abortStr(540)))).toBe(540);
    expect(extractMoveAbortCode(new Error(abortStr(521)))).not.toBe(540);
  });
});
