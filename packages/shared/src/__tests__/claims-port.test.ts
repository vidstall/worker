/**
 * Shared claim-carrier PORT-COLLISION guard (DRY extraction D1).
 *
 * Pins the generic `assertClaimsPortFree` / `resolveClaimsPort` + the single
 * canonical `DAEMON_PORTS_IN_USE` that both per-carrier port modules now
 * delegate to. The per-carrier wrappers keep their own behavior-preserving
 * suites (`quorum-claims-port.test.ts`, `claims-carrier.test.ts`); this file
 * pins the shared core + the label/env parameterization.
 *
 * HERMETIC: pure functions only, no `server.listen`, no port bound.
 */

import { describe, it, expect } from 'vitest';
import {
  assertClaimsPortFree,
  resolveClaimsPort,
  DAEMON_PORTS_IN_USE,
} from '../claims-port.js';

describe('claims-port — DAEMON_PORTS_IN_USE (single canonical set)', () => {
  it('is exactly the documented daemon port set', () => {
    expect([...DAEMON_PORTS_IN_USE].sort((a, b) => a - b)).toEqual(
      [4000, 4001, 8080, 8081, 8082, 8090, 8091, 8101, 8102],
    );
  });

  it('does NOT include 8092 (each carrier default is free per-host)', () => {
    expect(DAEMON_PORTS_IN_USE).not.toContain(8092);
  });
});

describe('claims-port — assertClaimsPortFree', () => {
  it('the default 8092 is FREE against the in-use set', () => {
    expect(() => assertClaimsPortFree(8092, 'quorum-claims', 'QUORUM_CLAIMS_PORT')).not.toThrow();
  });

  it.each(DAEMON_PORTS_IN_USE)('fail-closed on in-use port %i', (port) => {
    expect(() => assertClaimsPortFree(port, 'quorum-claims', 'QUORUM_CLAIMS_PORT')).toThrow(
      /in use|EADDRINUSE|collision/i,
    );
  });

  it('names the offending port AND the carrier label AND the env var', () => {
    expect(() => assertClaimsPortFree(8090, 'canary-claims', 'CANARY_CLAIMS_PORT')).toThrow(
      /8090/,
    );
    expect(() => assertClaimsPortFree(8090, 'canary-claims', 'CANARY_CLAIMS_PORT')).toThrow(
      /canary-claims/,
    );
    expect(() => assertClaimsPortFree(8090, 'canary-claims', 'CANARY_CLAIMS_PORT')).toThrow(
      /CANARY_CLAIMS_PORT/,
    );
  });

  it('honors a custom in-use set', () => {
    expect(() => assertClaimsPortFree(9999, 'x', 'X', [9999])).toThrow(/in use/i);
    expect(() => assertClaimsPortFree(9998, 'x', 'X', [9999])).not.toThrow();
  });
});

describe('claims-port — resolveClaimsPort', () => {
  it('returns the default when env is unset or empty', () => {
    expect(resolveClaimsPort({}, 'QUORUM_CLAIMS_PORT', 8092)).toBe(8092);
    expect(resolveClaimsPort({ QUORUM_CLAIMS_PORT: '' }, 'QUORUM_CLAIMS_PORT', 8092)).toBe(8092);
  });

  it('parses a numeric override', () => {
    expect(resolveClaimsPort({ CANARY_CLAIMS_PORT: '9100' }, 'CANARY_CLAIMS_PORT', 8092)).toBe(9100);
  });

  it('fail-closed on non-numeric / out-of-range (no silent fallback)', () => {
    expect(() => resolveClaimsPort({ P: 'nope' }, 'P', 8092)).toThrow(/valid TCP port/);
    expect(() => resolveClaimsPort({ P: '0' }, 'P', 8092)).toThrow();
    expect(() => resolveClaimsPort({ P: '99999' }, 'P', 8092)).toThrow();
  });
});
