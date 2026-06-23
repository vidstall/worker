/**
 * OQ-7 Phase D-1 STAGE-2 (CANARY CARRIER) — startup PORT-COLLISION guard (PURE).
 *
 * The canary `/canary/claims` carrier binds a NEW port, default 8092 (DESIGN — a DIFFERENT
 * daemon/host than the cp-daemon cap-token carrier in prod; co-location on one host is only a
 * test/dev convenience, so the test harness injects an ephemeral/distinct port to avoid a local
 * collision). This module is the pure pre-flight assert that catches a mis-configured port BEFORE
 * any server bind (no `server.listen` here): a collision with a known in-use port throws fail-closed
 * at startup rather than surfacing as a runtime EADDRINUSE crash.
 *
 * Mirrors apps/cp-daemon/src/quorum-claims-port.ts. Carries ZERO transport: the carrier calls
 * `resolveCanaryClaimsPort(env)` then `assertCanaryClaimsPortFree(port)` before binding. Additive —
 * no existing surface is touched.
 *
 * NOTE on the shared default 8092: in a single-host dev stack the cap-token carrier (cp-daemon) and
 * the canary carrier (validator-daemon) would both want 8092. In PROD they live on DISTINCT hosts so
 * 8092 is free on each. For a co-located dev/test run, set `CANARY_CLAIMS_PORT` to a free port (or use
 * the test `portOverride: 0`). 8092 is therefore NOT listed in this module's in-use set (it is THIS
 * carrier's own default), but the cp-daemon-side ports ARE, so a mis-point at a busy daemon port is
 * caught.
 */

/** The canary carrier's canonical default port (DESIGN; per-host distinct from cp-daemon in prod). */
export const DEFAULT_CANARY_CLAIMS_PORT = 8092 as const;

/**
 * The ports already bound by the daemon set on a single host (mirrors quorum-claims-port.ts):
 *   8090 TURN_RPC · 8091 CP_HEALTHZ · 8082 SIGNALING_HEALTHZ · 8080 SIGNALING ·
 *   8081 BENCH · 4000 relay WS · 4001 relay METRICS · 8101 VALIDATOR_HEALTHZ ·
 *   8102 VALIDATOR_CANARY_COVERAGE.
 * (8092 — this carrier's own default — is intentionally NOT here; see the module header.)
 */
export const CANARY_DAEMON_PORTS_IN_USE: readonly number[] = [
  8090, 8091, 8082, 8080, 8081, 4000, 4001, 8101, 8102,
];

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Fail-closed pre-flight assert: throws if `port` collides with a port already in use by the daemon
 * set. The error names the offending port so an operator can debug the mis-config. Mirrors the
 * EADDRINUSE failure mode without binding.
 */
export function assertCanaryClaimsPortFree(
  port: number,
  inUse: readonly number[] = CANARY_DAEMON_PORTS_IN_USE,
): void {
  if (inUse.includes(port)) {
    throw new Error(
      `canary-claims port ${port} is in use (EADDRINUSE-style collision) — ` +
        `it conflicts with the daemon port set [${[...inUse].join(', ')}]. ` +
        `Set CANARY_CLAIMS_PORT to a free port.`,
    );
  }
}

/**
 * Resolve the carrier port from env `CANARY_CLAIMS_PORT`, defaulting to
 * {@link DEFAULT_CANARY_CLAIMS_PORT}. Fail-closed on a non-numeric or out-of-range value (no silent
 * fallback to the default, which would mask a typo and hand the carrier a wrong port).
 */
export function resolveCanaryClaimsPort(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env['CANARY_CLAIMS_PORT'];
  if (raw === undefined || raw === '') {
    return DEFAULT_CANARY_CLAIMS_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `CANARY_CLAIMS_PORT="${raw}" is not a valid TCP port (${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return parsed;
}
