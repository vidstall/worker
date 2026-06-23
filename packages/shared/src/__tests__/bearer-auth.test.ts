/**
 * Shared constant-time Bearer-token check (DRY extraction D2).
 *
 * Pins `isBearerAuthorized` — extracted from the two byte-identical per-carrier
 * helpers (`isQuorumClaimsAuthorized`, `isCanaryClaimsAuthorized`). The carrier
 * server suites still pin the end-to-end 401 behavior over HTTP; this file pins
 * the security core directly.
 */

import { describe, it, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { isBearerAuthorized } from '../bearer-auth.js';

/** Minimal IncomingMessage stand-in carrying only the headers the check reads. */
function reqWith(authorization?: string): IncomingMessage {
  return {
    headers: authorization === undefined ? {} : { authorization },
  } as unknown as IncomingMessage;
}

const TOKEN = 'super-secret-bearer-token';

describe('isBearerAuthorized', () => {
  it('accepts the exact Bearer token', () => {
    expect(isBearerAuthorized(reqWith(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
  });

  it('FAIL-CLOSED when the expected token is empty (carrier never runs open)', () => {
    expect(isBearerAuthorized(reqWith('Bearer '), '')).toBe(false);
    expect(isBearerAuthorized(reqWith(`Bearer anything`), '')).toBe(false);
  });

  it('rejects a missing Authorization header', () => {
    expect(isBearerAuthorized(reqWith(undefined), TOKEN)).toBe(false);
  });

  it('rejects a non-Bearer scheme', () => {
    expect(isBearerAuthorized(reqWith(`Basic ${TOKEN}`), TOKEN)).toBe(false);
  });

  it('rejects an empty presented token', () => {
    expect(isBearerAuthorized(reqWith('Bearer '), TOKEN)).toBe(false);
  });

  it('rejects a wrong token of the SAME length (constant-time path reached)', () => {
    const sameLen = 'x'.repeat(TOKEN.length);
    expect(sameLen.length).toBe(TOKEN.length);
    expect(isBearerAuthorized(reqWith(`Bearer ${sameLen}`), TOKEN)).toBe(false);
  });

  it('rejects a wrong token of a different length', () => {
    expect(isBearerAuthorized(reqWith(`Bearer short`), TOKEN)).toBe(false);
  });
});
