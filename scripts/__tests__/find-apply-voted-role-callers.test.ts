/**
 * Characterization tests for find-apply-voted-role-callers.ts (REQ-RV-008,
 * F47 Phase 1.0 pre-impl gate).
 *
 * Spec: plans/role-revote-pool/milestone-1/ROADMAP.md § Phase 1.0 TDD evidence.
 *
 * Scope: validate the enumerator's external contract — count is sane, schema
 * matches, output is deterministic, the known production TS TX call site is
 * present, and paths are POSIX-style (cross-platform).
 *
 * The script's main() is gated by `isDirectRun` so importing it for tests
 * does NOT trigger a filesystem walk; only enumerateCallers() runs on demand.
 */

import { describe, it, expect } from 'vitest';
import {
  enumerateCallers,
  type CallerLocation,
  type CallerEnumResult,
} from '../find-apply-voted-role-callers';

describe('find-apply-voted-role-callers (REQ-RV-008 Phase 1.0)', () => {
  it('finds at least 1 caller of apply_voted_role', () => {
    const result = enumerateCallers();
    expect(result.count).toBeGreaterThanOrEqual(1);
    expect(result.locations.length).toBe(result.count);
  });

  it('returns deterministic sorted locations (file ASC, line ASC)', () => {
    const a = enumerateCallers();
    const b = enumerateCallers();
    // Byte-equal JSON of the locations array — two independent runs must match.
    expect(JSON.stringify(a.locations)).toBe(JSON.stringify(b.locations));
    // Verify sort invariant directly: file ASC then line ASC.
    for (let i = 1; i < a.locations.length; i++) {
      const prev = a.locations[i - 1];
      const curr = a.locations[i];
      if (prev.file === curr.file) {
        expect(curr.line).toBeGreaterThan(prev.line);
      } else {
        expect(prev.file < curr.file).toBe(true);
      }
    }
  });

  it('schema matches: count + locations[].{file,line,context}', () => {
    const result: CallerEnumResult = enumerateCallers();
    expect(typeof result.count).toBe('number');
    expect(Number.isInteger(result.count)).toBe(true);
    expect(Array.isArray(result.locations)).toBe(true);
    for (const loc of result.locations as CallerLocation[]) {
      expect(typeof loc.file).toBe('string');
      expect(loc.file.length).toBeGreaterThan(0);
      expect(typeof loc.line).toBe('number');
      expect(Number.isInteger(loc.line)).toBe(true);
      expect(loc.line).toBeGreaterThan(0);
      expect(typeof loc.context).toBe('string');
    }
  });

  it('includes the known production TS TX call site (role-assignment.ts:82)', () => {
    const result = enumerateCallers();
    const hit = result.locations.some(
      (l) => l.file.endsWith('role-assignment.ts') && l.line === 82,
    );
    expect(hit).toBe(true);
  });

  it('uses POSIX-style forward-slash paths (cross-platform)', () => {
    const result = enumerateCallers();
    expect(
      result.locations.every((l) => !l.file.includes('\\')),
    ).toBe(true);
  });
});
