/**
 * F62 M2 daemon-wiring (W-P3, REQ-ADW-002) — LIVE cap-token admission wiring.
 *
 * Asserts the extracted `startCapTokenAdmission` seam:
 *   (a) constructs a CapTokenCache + starts the REAL chain poller and wires the
 *       returned unsubscribe into shutdown();
 *   (b) primes cachedEpoch from a mocked getLatestSuiSystemState and exposes it
 *       SYNCHRONOUSLY as bigint via currentEpoch();
 *   (c) shutdown() clears the epoch timer AND awaits the poller unsubscribe;
 *   (d) the produced authHook is usable as createServer({ authHook }) input.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@dvconf/shared';
import { startCapTokenAdmission } from '../cap-token-admission.js';
import { AuthHook } from '../auth.js';
import { CapTokenCache } from '../cap-token-cache.js';

// ── Test scaffolding ─────────────────────────────────────────────────────

function makeLoggerSpy(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  } as unknown as Logger;
}

/**
 * Minimal SuiClient + SuiGraphQLClient stub pair. `getLatestSuiSystemState`
 * returns a controllable epoch; the GraphQL `query` stub returns an empty
 * events page so the poller idles after one tick.
 */
function makeClientStub(epoch = '42'): {
  client: {
    getLatestSuiSystemState: ReturnType<typeof vi.fn>;
  };
  graphqlClient: {
    query: ReturnType<typeof vi.fn>;
  };
} {
  return {
    client: {
      getLatestSuiSystemState: vi.fn().mockResolvedValue({ epoch }),
    },
    graphqlClient: {
      query: vi.fn().mockResolvedValue({
        data: { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
    },
  };
}

const PACKAGE_ID = '0xpkg';

describe('startCapTokenAdmission (REQ-ADW-002 — W-P3 live cap-token wiring)', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = makeLoggerSpy();
  });

  it('(a) constructs a CapTokenCache and starts the real chain-event poller', async () => {
    const { client, graphqlClient } = makeClientStub();
    const subSpy = vi.spyOn(CapTokenCache.prototype, 'subscribeToChainEvents');

    const admission = await startCapTokenAdmission(
      client as never,
      graphqlClient as never,
      PACKAGE_ID,
      logger,
    );

    expect(admission.cache).toBeInstanceOf(CapTokenCache);
    expect(subSpy).toHaveBeenCalledWith(
      graphqlClient,
      PACKAGE_ID,
      expect.objectContaining({ pollIntervalMs: expect.any(Number) }),
    );

    await admission.shutdown();
    subSpy.mockRestore();
  });

  it('(b) primes cachedEpoch from getLatestSuiSystemState; currentEpoch() is sync bigint', async () => {
    const { client, graphqlClient } = makeClientStub('77');

    const admission = await startCapTokenAdmission(
      client as never,
      graphqlClient as never,
      PACKAGE_ID,
      logger,
    );

    expect(client.getLatestSuiSystemState).toHaveBeenCalled();
    const epoch = admission.currentEpoch();
    expect(typeof epoch).toBe('bigint');
    expect(epoch).toBe(77n);

    await admission.shutdown();
  });

  it('(c) shutdown() clears the epoch timer AND awaits the poller unsubscribe', async () => {
    const { client, graphqlClient } = makeClientStub();
    const unsubscribe = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(CapTokenCache.prototype, 'subscribeToChainEvents').mockResolvedValue(
      unsubscribe,
    );
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');

    const admission = await startCapTokenAdmission(
      client as never,
      graphqlClient as never,
      PACKAGE_ID,
      logger,
    );

    await admission.shutdown();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalled();

    clearSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('(d) produces an AuthHook usable as the createServer({ authHook }) input', async () => {
    const { client, graphqlClient } = makeClientStub();

    const admission = await startCapTokenAdmission(
      client as never,
      graphqlClient as never,
      PACKAGE_ID,
      logger,
    );

    // The hook is the concrete AuthHook type accepted by CreateServerOpts.authHook.
    expect(admission.authHook).toBeInstanceOf(AuthHook);
    // Smoke: strict-reject short-circuit works through the wired cache.
    admission.cache.setStrictRejectMode('test');
    const result = await admission.authHook.verifyJoin(
      { type: 'join', roomId: '0xr', token: '0xt', signature: '', nonce: 1 },
      { close: vi.fn(), readyState: 1 } as never,
      'trace-1',
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('auth-degraded');

    await admission.shutdown();
  });
});
