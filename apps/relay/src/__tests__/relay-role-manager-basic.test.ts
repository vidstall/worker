/**
 * Unit tests for relay-role-manager (REQ-RO-004 + REQ-RO-005) — basic role /
 * port-range helpers.
 *
 * RED cases (TDD contract):
 *   - determineRole: own ID at index 0 → primary; at index 1 → standby; not in list → throws
 *   - parsePipePortRange: parses "40000-40100" → {min:40000, max:40100}
 *
 * Requirements: REQ-RO-004, REQ-RO-005
 */

import { describe, it, expect } from 'vitest';
import { determineRole, parsePipePortRange } from '@dvconf/inter-relay-client';

// ── determineRole ──────────────────────────────────────────────────────

describe('determineRole', () => {
  it('returns "primary" when ownRelayId is assigned_relays[0]', () => {
    expect(determineRole(['relay-A', 'relay-B'], 'relay-A')).toBe('primary');
  });

  it('returns "standby" when ownRelayId is assigned_relays[1]', () => {
    expect(determineRole(['relay-A', 'relay-B'], 'relay-B')).toBe('standby');
  });

  it('returns "standby" for any index > 0 (future-proof)', () => {
    expect(determineRole(['relay-A', 'relay-B', 'relay-C'], 'relay-C')).toBe('standby');
  });

  it('throws when own ID is not in assignedRelays', () => {
    expect(() => determineRole(['relay-A', 'relay-B'], 'relay-X')).toThrow();
  });

  it('reads assigned_relays.length, never hardcodes 2', () => {
    // Single relay (edge/degraded) — own ID at 0 → primary
    expect(determineRole(['relay-solo'], 'relay-solo')).toBe('primary');
  });
});

// ── parsePipePortRange ─────────────────────────────────────────────────

describe('parsePipePortRange', () => {
  it('parses "40000-40100" correctly', () => {
    const range = parsePipePortRange('40000-40100');
    expect(range.min).toBe(40000);
    expect(range.max).toBe(40100);
  });

  it('uses default range when env is undefined', () => {
    const range = parsePipePortRange(undefined);
    expect(range.min).toBe(40000);
    expect(range.max).toBe(40100);
  });

  it('throws on malformed range string', () => {
    expect(() => parsePipePortRange('not-a-range')).toThrow();
  });
});
