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

/**
 * Relay metrics/probe HTTP port. The WS RELAY_URL is :4000; /api/probe is
 * served from the relay's METRICS_PORT (default 4001).
 */
const METRICS_PORT = Number(process.env['RELAY_METRICS_PORT'] ?? '4001');

export interface StandbyFlapGateOptions {
  /** Full probe URL to GET (e.g. http://host:4001/api/probe). */
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
 * Map a WS relay URL to its probe base URL: ws->http / wss->https, and REPLACE
 * the port with the relay METRICS_PORT (the WS :4000 is not the probe :4001).
 * Returns the host:port base (no path); the caller appends `/api/probe`.
 */
export function wsToProbeUrl(wsUrl: string): string {
  const u = new URL(wsUrl);
  u.protocol = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https:' : 'http:';
  u.port = String(METRICS_PORT);
  return u.origin;
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
