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

import {
  DAEMON_PORTS_IN_USE,
  assertClaimsPortFree,
  resolveClaimsPort,
} from '@dvconf/shared';

/** The canary carrier's canonical default port (DESIGN; per-host distinct from cp-daemon in prod). */
export const DEFAULT_CANARY_CLAIMS_PORT = 8092 as const;

/**
 * The ports already bound by the daemon set on a single host. Re-exported from the single canonical
 * `@dvconf/shared` set (DRY review D1) under the carrier-local name, so the cap-token + canary
 * carriers can no longer drift their in-use lists. (8092 — this carrier's own default — is NOT in the
 * set; see the module header.) Kept exported under this name for the existing callers/tests.
 */
export const CANARY_DAEMON_PORTS_IN_USE: readonly number[] = DAEMON_PORTS_IN_USE;

/**
 * Fail-closed pre-flight assert (delegates to the shared generic): throws if `port` collides with a
 * port already in use by the daemon set. Mirrors the EADDRINUSE failure mode without binding.
 */
export function assertCanaryClaimsPortFree(
  port: number,
  inUse: readonly number[] = CANARY_DAEMON_PORTS_IN_USE,
): void {
  assertClaimsPortFree(port, 'canary-claims', 'CANARY_CLAIMS_PORT', inUse);
}

/**
 * Resolve the carrier port from env `CANARY_CLAIMS_PORT`, defaulting to
 * {@link DEFAULT_CANARY_CLAIMS_PORT}. Fail-closed on a non-numeric / out-of-range value (delegates to
 * the shared generic).
 */
export function resolveCanaryClaimsPort(
  env: Record<string, string | undefined> = process.env,
): number {
  return resolveClaimsPort(env, 'CANARY_CLAIMS_PORT', DEFAULT_CANARY_CLAIMS_PORT);
}

/**
 * The carrier's default bind host — LOOPBACK (off-media-path, the single-host slice). The cross-host
 * WAN run bridged peer↔peer over SSH tunnels to loopback, so 127.0.0.1 is byte-identical there.
 */
export const DEFAULT_CANARY_CLAIMS_BIND_HOST = '127.0.0.1' as const;

/**
 * Resolve the carrier bind host from env `CANARY_CLAIMS_BIND_HOST`, defaulting to
 * {@link DEFAULT_CANARY_CLAIMS_BIND_HOST} (loopback). A multi-CONTAINER demo (val-1 + val-2 as DISTINCT
 * containers on ONE bridge network — no SSH tunnel) sets `0.0.0.0` so the PEER container can reach the
 * board at the container IP; the SPKI pin (not the address) remains the trust anchor. Empty/whitespace
 * falls back to the loopback default (fail-safe to the byte-identical single-host behavior).
 */
export function resolveCanaryClaimsBindHost(
  env: Record<string, string | undefined> = process.env,
): string {
  const v = env['CANARY_CLAIMS_BIND_HOST']?.trim();
  return v ? v : DEFAULT_CANARY_CLAIMS_BIND_HOST;
}
