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

/** The carrier's canonical default port (free vs the in-use daemon set). */
export const DEFAULT_QUORUM_CLAIMS_PORT = 8092 as const;

/**
 * The ports already bound by the daemon set (ROADMAP §9):
 *   8090 TURN_RPC · 8091 CP_HEALTHZ · 8082 SIGNALING_HEALTHZ · 8080 SIGNALING ·
 *   8081 BENCH · 4000 relay WS · 4001 relay METRICS · 8101 VALIDATOR_HEALTHZ ·
 *   8102 VALIDATOR_CANARY_COVERAGE.
 */
export const DAEMON_PORTS_IN_USE: readonly number[] = [
  8090, 8091, 8082, 8080, 8081, 4000, 4001, 8101, 8102,
];

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Fail-closed pre-flight assert: throws if `port` collides with a port already
 * in use by the daemon set. The error names the offending port so an operator
 * can debug the mis-config. Mirrors the EADDRINUSE failure mode without binding.
 */
export function assertQuorumPortFree(
  port: number,
  inUse: readonly number[] = DAEMON_PORTS_IN_USE,
): void {
  if (inUse.includes(port)) {
    throw new Error(
      `quorum-claims port ${port} is in use (EADDRINUSE-style collision) — ` +
        `it conflicts with the daemon port set [${[...inUse].join(', ')}]. ` +
        `Set QUORUM_CLAIMS_PORT to a free port.`,
    );
  }
}

/**
 * Resolve the carrier port from env `QUORUM_CLAIMS_PORT`, defaulting to
 * {@link DEFAULT_QUORUM_CLAIMS_PORT}. Fail-closed on a non-numeric or
 * out-of-range value (no silent fallback to the default, which would mask a
 * typo and hand the carrier a wrong port).
 */
export function resolveQuorumClaimsPort(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['QUORUM_CLAIMS_PORT'];
  if (raw === undefined || raw === '') {
    return DEFAULT_QUORUM_CLAIMS_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `QUORUM_CLAIMS_PORT="${raw}" is not a valid TCP port (${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return parsed;
}
