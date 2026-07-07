/**
 * REQ-RMS-022 (static-mesh-hardening D1) — poll the co-located validator's /canary/load
 * feed and maintain ONE long-lived Map for capacityCtx.attestedLoad. Refresh is IN PLACE
 * (the event handler holds the same reference). Feed-down policy (spec §2-D1.3): the fetch
 * fail-opens to an empty map and we REPLACE — strict defer-all, never last-known-good
 * (stale attestation is worse than deferral; revisit with canary M4b).
 */
import type { Logger } from '@dvconf/shared';
import { fetchAttestedLoad, type AttestedLoad } from './coverage-load-reader.js';

export interface AttestedLoadPoller {
  /** Long-lived map — pass BY REFERENCE into createEventHandler's capacityCtx. */
  attestedLoad: Map<string, AttestedLoad>;
  stop: () => void;
}

export function startAttestedLoadPoller(args: {
  feedUrl: string;
  pollMs: number;
  logger: Logger;
  /** Injectable for tests; default = the shipped loopback reader. */
  fetcher?: (feedUrl: string, logger: Logger) => Promise<Map<string, AttestedLoad>>;
}): AttestedLoadPoller {
  const fetcher = args.fetcher ?? fetchAttestedLoad;
  const attestedLoad = new Map<string, AttestedLoad>();
  const refresh = async (): Promise<void> => {
    const next = await fetcher(args.feedUrl, args.logger);
    attestedLoad.clear();
    for (const [k, v] of next) attestedLoad.set(k, v);
  };
  void refresh();
  const handle = setInterval(() => {
    void refresh();
  }, args.pollMs);
  (handle as unknown as { unref?: () => void }).unref?.();
  return { attestedLoad, stop: () => clearInterval(handle) };
}
