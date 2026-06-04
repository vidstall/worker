/**
 * F62 M2 daemon-wiring (W-P3, REQ-ADW-002) — LIVE cap-token admission wiring.
 *
 * Extracts the signaling daemon's cap-token admission bootstrap out of the
 * top-level `main()` IIFE into a single testable seam. Wires:
 *   1. a `CapTokenCache` (LRU snapshot store consumed by `AuthHook`),
 *   2. the REAL `capability_events` chain-event poller (subscribeToChainEvents),
 *   3. a cached-epoch refresher (mirrors cp-daemon `startCapTokenIssuer`),
 *   4. an `AuthHook` consuming the cache + a SYNC `currentEpoch()` closure.
 *
 * `main()` passes the returned `authHook` into `createServer(PORT, { authHook })`
 * so a live signaling daemon GATES room joins against on-chain cap-tokens.
 *
 * `shutdown()` clears the epoch timer AND awaits the poller unsubscribe so a
 * graceful SIGTERM/SIGINT leaves no dangling RPC poll or timer.
 *
 * NOTE: `CapTokenCache` structurally satisfies `AuthCacheConsumer` (its `get`
 * returns `CachedToken`, a superset of `CachedTokenSnapshot`; `has`,
 * `isStrictRejectMode`, `validateAndAdvanceNonce` are all present) so no adapter
 * is needed — it is passed directly as the AuthHook's `cache`.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Logger } from '@dvconf/shared';
import { AuthHook } from './auth.js';
import { CapTokenCache } from './cap-token-cache.js';

export interface StartCapTokenAdmissionOpts {
  /** Cap-token event poll interval (ms). Default 2_000 (cache default). */
  pollIntervalMs?: number;
  /** Cached-epoch refresh interval (ms). Default 60_000 (mirrors cp-daemon). */
  epochRefreshIntervalMs?: number;
}

export interface CapTokenAdmission {
  authHook: AuthHook;
  cache: CapTokenCache;
  /** SYNC accessor for the latest cached Sui epoch (used by AuthHook expiry). */
  currentEpoch: () => bigint;
  /** Clear the epoch timer + await poller unsubscribe. Safe to call once. */
  shutdown: () => Promise<void>;
}

/**
 * Construct + start LIVE cap-token admission. Primes the cached epoch before
 * returning so the first join uses a real epoch, starts the real event poller,
 * and announces the D-016 cold-start nonce-gap window once.
 */
export async function startCapTokenAdmission(
  client: SuiClient,
  packageId: string,
  logger: Logger,
  opts: StartCapTokenAdmissionOpts = {},
): Promise<CapTokenAdmission> {
  const cache = new CapTokenCache({ logger });

  // Cached-epoch source (mirrors cp-daemon startCapTokenIssuer W-P2 / D-W7).
  let cachedEpoch = 0n;
  let epochTimer: ReturnType<typeof setInterval> | undefined;
  const refreshEpoch = async (): Promise<void> => {
    try {
      const sys = await client.getLatestSuiSystemState();
      cachedEpoch = BigInt(sys.epoch);
    } catch (err) {
      logger.warn(
        { module: 'cap-token-admission', context: { err: (err as Error).message } },
        'epoch refresh failed — keeping last cached epoch',
      );
    }
  };
  await refreshEpoch(); // prime so the first join expiry check uses a real epoch
  const intervalMs = opts.epochRefreshIntervalMs ?? 60_000;
  epochTimer = setInterval(() => {
    void refreshEpoch();
  }, intervalMs);
  if (typeof epochTimer.unref === 'function') epochTimer.unref();
  const currentEpoch = (): bigint => cachedEpoch;

  // Start the REAL capability_events poller. Returns an async unsubscribe.
  cache.announceColdStart('signaling-daemon-start');
  const unsubscribe = await cache.subscribeToChainEvents(client, packageId, {
    pollIntervalMs: opts.pollIntervalMs ?? 2_000,
  });

  const authHook = new AuthHook({ cache, currentEpoch, logger });

  logger.info(
    { module: 'cap-token-admission', context: { packageId } },
    'cap-token admission wired — live chain poller + epoch refresher active',
  );

  return {
    authHook,
    cache,
    currentEpoch,
    shutdown: async () => {
      if (epochTimer) {
        clearInterval(epochTimer);
        epochTimer = undefined;
      }
      await unsubscribe();
      logger.info({ module: 'cap-token-admission' }, 'cap-token admission stopped');
    },
  };
}
