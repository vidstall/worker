/**
 * Multi-CP quorum Phase 1 — Leg 0(a): startup PORT-COLLISION guard (PURE).
 *
 * The shared `/quorum/claims` carrier (Leg 7, DEFERRED) will bind a NEW port,
 * default 8092 — verified free (ROADMAP §9 / DESIGN line 31) against the in-use
 * daemon set. This module is the pure pre-flight assert that catches a
 * mis-configured port BEFORE any server bind (no `server.listen` here): a
 * collision with a known in-use port throws fail-closed at startup rather than
 * surfacing as a runtime EADDRINUSE crash.
 *
 * Carries ZERO transport: a later leg calls `resolveQuorumClaimsPort(env)` then
 * `assertQuorumPortFree(port, DAEMON_PORTS_IN_USE)` before constructing the
 * carrier. Additive — no existing surface is touched.
 */

import {
  DAEMON_PORTS_IN_USE,
  assertClaimsPortFree,
  resolveClaimsPort,
} from '@dvconf/shared';

/** The carrier's canonical default port (free vs the in-use daemon set). */
export const DEFAULT_QUORUM_CLAIMS_PORT = 8092 as const;

/**
 * The ports already bound by the daemon set (ROADMAP §9). Re-exported from the
 * single canonical `@dvconf/shared` set (DRY review D1) so the cap-token + canary
 * carriers can no longer drift their in-use lists. Kept exported for the existing
 * callers/tests.
 */
export { DAEMON_PORTS_IN_USE };

/**
 * Fail-closed pre-flight assert (delegates to the shared generic): throws if
 * `port` collides with a port already in use by the daemon set. Mirrors the
 * EADDRINUSE failure mode without binding.
 */
export function assertQuorumPortFree(
  port: number,
  inUse: readonly number[] = DAEMON_PORTS_IN_USE,
): void {
  assertClaimsPortFree(port, 'quorum-claims', 'QUORUM_CLAIMS_PORT', inUse);
}

/**
 * Resolve the carrier port from env `QUORUM_CLAIMS_PORT`, defaulting to
 * {@link DEFAULT_QUORUM_CLAIMS_PORT}. Fail-closed on a non-numeric / out-of-range
 * value (delegates to the shared generic).
 */
export function resolveQuorumClaimsPort(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveClaimsPort(env, 'QUORUM_CLAIMS_PORT', DEFAULT_QUORUM_CLAIMS_PORT);
}
