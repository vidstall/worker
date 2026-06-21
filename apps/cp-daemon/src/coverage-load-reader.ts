/**
 * REQ-RMS-005 — CP-daemon loopback reader for the validator-daemon /canary/load feed.
 *
 * CO-LOCATION REQUIREMENT (D-CFA-18): the feed binds 127.0.0.1; this reader MUST run on the
 * SAME host as the validator daemon. A relay can never reach the feed. The placement scorer
 * uses this CANARY-ATTESTED l_i (forwarding-path load), NEVER the relay's self-reported
 * RelayLoadUpdated calculateLoad.
 *
 * LOGGING: structured Logger only; on fetch failure, fail-OPEN to an empty map so admission
 * DEFERS (graceful) rather than trusting stale self-report.
 */
import type { Logger } from '@dvconf/shared';

export interface AttestedLoad {
  attestedLoadPaths: number;
  heartbeatFreshEpochs: number;
}

/** PURE: parse the /canary/load JSON into a per-relay map. Tolerant — bad shape -> empty map. */
export function parseLoadFeed(json: unknown): Map<string, AttestedLoad> {
  const out = new Map<string, AttestedLoad>();
  const relays = (json as { relays?: unknown })?.relays;
  if (!Array.isArray(relays)) return out;
  for (const r of relays) {
    const row = r as { relayMinerId?: unknown; attestedLoadPaths?: unknown; heartbeatFreshEpochs?: unknown };
    if (typeof row.relayMinerId !== 'string') continue;
    out.set(row.relayMinerId, {
      attestedLoadPaths: Number(row.attestedLoadPaths ?? 0),
      heartbeatFreshEpochs: Number(row.heartbeatFreshEpochs ?? Number.MAX_SAFE_INTEGER),
    });
  }
  return out;
}

/** Fetch + parse the loopback load feed. Fail-OPEN (empty map) on any error so admission defers. */
export async function fetchAttestedLoad(feedUrl: string, logger: Logger): Promise<Map<string, AttestedLoad>> {
  try {
    const res = await fetch(feedUrl);
    if (!res.ok) {
      logger.warn({ feedUrl, status: res.status }, 'canary load feed non-200 — deferring (fail-open empty)');
      return new Map();
    }
    return parseLoadFeed(await res.json());
  } catch (err) {
    logger.warn({ err, feedUrl }, 'canary load feed fetch failed — deferring (fail-open empty)');
    return new Map();
  }
}
