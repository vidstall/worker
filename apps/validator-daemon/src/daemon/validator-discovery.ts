/**
 * Validator Daemon -- cached live-discovered active-validator refresh.
 *
 * Extracted from the former `index.ts` monolith (via `daemon/bootstrap.ts`).
 */

import type { Logger } from '@dvconf/shared';
import { discoverActiveValidatorMinerIds } from '../canary/validator-discovery.js';
import type { DaemonState } from './state.js';

/**
 * M2 chunk 2 (REQ-CFA-019/020): refresh the cached live-discovered active-validator
 * miner_ids via a read-only devInspect of validator_registry::get_active_validators.
 *
 * Fire-and-forget per canary round (called from the cell loop's getValidators) — no new
 * timer. CRASH-SAFE: a devInspect failure is swallowed by discoverActiveValidatorMinerIds
 * (returns []), and we only OVERWRITE the cache with a non-empty result, so a transient RPC
 * flake leaves the last good set in place; an empty result (genuinely no peers) is reflected
 * as [] so the union degrades to self-only. The self-entry is always re-added by the union,
 * so the daemon never drops below self-coverage. Re-entrancy is bounded by a single in-flight
 * guard so a slow RPC cannot stack refreshes across rounds.
 */
let discoveryRefreshInFlight = false;
export async function refreshDiscoveredValidators(state: DaemonState, log: Logger): Promise<void> {
  if (discoveryRefreshInFlight) return;
  discoveryRefreshInFlight = true;
  try {
    const ids = await discoverActiveValidatorMinerIds(state.client, state.config, log);
    if (ids.length > 0) {
      state.discoveredValidatorMinerIds = ids;
    } else if (state.discoveredValidatorMinerIds === undefined) {
      // First-ever refresh returned empty (no peers yet) — record [] so the union is
      // self-only rather than staying `undefined` forever.
      state.discoveredValidatorMinerIds = [];
    }
  } catch (err) {
    // Defense-in-depth: the discovery reader is already crash-safe, but never let a refresh
    // reject escape into the cell loop.
    log.warn({ err }, 'canary validator discovery refresh failed (keeping last good set)');
  } finally {
    discoveryRefreshInFlight = false;
  }
}
