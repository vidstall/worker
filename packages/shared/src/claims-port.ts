/**
 * Shared startup PORT-COLLISION guard for the off-media claim carriers
 * (cap-token `/quorum/claims` + canary `/canary/claims`).
 *
 * DRY extraction (2026-06-23 review D1): the two per-carrier port modules
 * (`apps/cp-daemon/src/quorum-claims-port.ts`,
 * `apps/validator-daemon/src/canary/canary-claims-port.ts`) were near-identical
 * clones — including the in-use daemon-port SET. A duplicated set drifts: adding
 * a new daemon port to one copy and forgetting the other would silently disable
 * a carrier's collision check. The set + the resolve/assert logic now live here
 * ONCE; each carrier keeps only its own `DEFAULT_*_PORT` constant + env-var name
 * and delegates.
 *
 * PURE: carries ZERO transport (no `server.listen`). Additive — the per-carrier
 * modules keep their exact public API as thin wrappers, so callers/tests are
 * unchanged.
 */

/**
 * The ports already bound by the daemon set on a single host (ROADMAP §9):
 *   8090 TURN_RPC · 8091 CP_HEALTHZ · 8082 SIGNALING_HEALTHZ · 8080 SIGNALING ·
 *   8081 BENCH · 4000 relay WS · 4001 relay METRICS · 8101 VALIDATOR_HEALTHZ ·
 *   8102 VALIDATOR_CANARY_COVERAGE.
 * (8092 — each claim carrier's own default — is intentionally NOT here: in prod
 * the two carriers live on DISTINCT hosts so 8092 is free on each; a co-located
 * dev run overrides one via its env var.)
 */
export const DAEMON_PORTS_IN_USE: readonly number[] = [
  8090, 8091, 8082, 8080, 8081, 4000, 4001, 8101, 8102,
];

const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Fail-closed pre-flight assert: throws if `port` collides with a port already
 * in use by the daemon set. The error names the offending port + the carrier
 * `label` + the `envVar` to set, so an operator can debug the mis-config.
 * Mirrors the EADDRINUSE failure mode without binding.
 */
export function assertClaimsPortFree(
  port: number,
  label: string,
  envVar: string,
  inUse: readonly number[] = DAEMON_PORTS_IN_USE,
): void {
  if (inUse.includes(port)) {
    throw new Error(
      `${label} port ${port} is in use (EADDRINUSE-style collision) — ` +
        `it conflicts with the daemon port set [${[...inUse].join(', ')}]. ` +
        `Set ${envVar} to a free port.`,
    );
  }
}

/**
 * Resolve a carrier port from env `envVar`, defaulting to `defaultPort`.
 * Fail-closed on a non-numeric or out-of-range value (no silent fallback to the
 * default, which would mask a typo and hand the carrier a wrong port).
 */
export function resolveClaimsPort(
  env: Record<string, string | undefined>,
  envVar: string,
  defaultPort: number,
): number {
  const raw = env[envVar];
  if (raw === undefined || raw === '') {
    return defaultPort;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < MIN_PORT || parsed > MAX_PORT) {
    throw new Error(
      `${envVar}="${raw}" is not a valid TCP port (${MIN_PORT}-${MAX_PORT}).`,
    );
  }
  return parsed;
}
