/**
 * createStandbyFlapGate — Node port of the browser client's flap-gate
 * (services/client/client/src/lib/standby-flap-gate.ts), used by
 * session.ts's handleRelayDeath to confirm a standby relay is actually live
 * before cutting the bot over to it.
 *
 * Before cutting over, OPTIONALLY confirm the standby relay is actually live
 * by polling its GET /api/probe (the metrics HTTP port, NOT the WS port).
 * Asserts `body.ok === true`.
 *
 * Policy = FAIL-OPEN: a probe timeout, network reject, or non-ok HTTP status
 * all CUT OVER anyway (worst case = no-gate behavior). The ONLY verdict that
 * suppresses the cut is a reachable `body.ok === false`. Short ~200ms deadline
 * via AbortController.
 */

/** Default flap-gate probe deadline in ms (short, fail-open). */
export const STANDBY_FLAP_GATE_TIMEOUT_MS = 200;

export interface StandbyFlapGateOptions {
  /** Full probe URL to GET (e.g. https://host.sslip.io/akamai-001/relay-1/api/probe). */
  probeUrl: string;
  /** Probe deadline in ms. Default {@link STANDBY_FLAP_GATE_TIMEOUT_MS} (200). */
  timeoutMs?: number;
}

export interface StandbyFlapGate {
  /**
   * Resolve TRUE = "cut over to standby", FALSE = "suppress the cut".
   * FAIL-OPEN: timeout / reject / non-ok HTTP -> TRUE. Only a reachable
   * body.ok === false -> FALSE.
   */
  check(): Promise<boolean>;
}

/**
 * Map a WS relay URL to its probe base URL: ws->http / wss->https, preserving
 * the URL's host AND path. The caller appends `/api/probe`. Used to only
 * rewrite the port to the relay's separate METRICS_PORT (the WS port doesn't
 * serve /api/probe) -- since path-based Caddy routing (see Caddyfile.j2)
 * fronts every worker's metrics port on the SAME public :443 + path as its
 * main port, there is no longer a separate public port to redirect to; the
 * metrics/probe route is reached over the identical origin+path as the WS
 * endpoint. Any trailing slash on the path is trimmed so the caller's own
 * `${base}/api/probe` never doubles up.
 */
export function wsToProbeUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  const protocol = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
  const path = u.pathname.replace(/\/$/, '');
  return `${protocol}//${u.host}${path}`;
}

/**
 * Build a flap-gate over a relay's GET /api/probe. FAIL-OPEN by design.
 */
export function createStandbyFlapGate(options: StandbyFlapGateOptions): StandbyFlapGate {
  const timeoutMs = options.timeoutMs ?? STANDBY_FLAP_GATE_TIMEOUT_MS;
  return {
    async check(): Promise<boolean> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(options.probeUrl, { signal: controller.signal });
        // Non-ok HTTP -> fail-open (cut anyway).
        if (!res.ok) return true;
        const body = (await res.json()) as { ok?: boolean };
        // The ONLY suppress-the-cut verdict: reachable AND body.ok === false.
        return body.ok !== false;
      } catch {
        // Timeout / network reject -> fail-open (cut anyway).
        return true;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
