/**
 * Shared constant-time Bearer-token check for the off-media claim carriers
 * (cap-token `/quorum/claims` + canary `/canary/claims`).
 *
 * DRY extraction (2026-06-23 review D2): the two per-carrier auth helpers
 * (`isQuorumClaimsAuthorized`, `isCanaryClaimsAuthorized`) were byte-identical.
 * Two copies of a security check drift — the constant-time compare now lives
 * ONCE. The token VALUE stays per-carrier (each server reads its own
 * `*_AUTH_TOKEN`); only the carrier-agnostic compare is shared.
 *
 * FAIL-CLOSED on an empty expected token (a transport carrying quorum
 * signatures / divergence attestations must never run open). NOT a `===`;
 * NOT imported from `apps/relay` (INV-B) — `node:crypto` `timingSafeEqual`
 * imported FRESH.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Returns true iff the request carries `Authorization: Bearer <expectedToken>`,
 * compared in constant time. The length pre-check short-circuits before the
 * `timingSafeEqual` call (length is not secret); an empty `expectedToken` is
 * rejected fail-closed.
 */
export function isBearerAuthorized(
  req: IncomingMessage,
  expectedToken: string,
): boolean {
  if (expectedToken === '') return false; // FAIL-CLOSED (security-critical transport)
  const authHeader = req.headers['authorization'];
  if (typeof authHeader !== 'string') return false;
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) return false;
  const presented = authHeader.slice(prefix.length);
  if (presented.length === 0) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedToken, 'utf8');
  if (a.length !== b.length) return false; // length is not secret; short-circuit before the call
  return timingSafeEqual(a, b);
}
