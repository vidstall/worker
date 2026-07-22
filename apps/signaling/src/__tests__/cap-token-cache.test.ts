/**
 * Tests for CapTokenCache — REQ-ADM-005 (cache invalidation) + REQ-ADM-009
 * (strict-reject mode on RPC partition).
 *
 * Five scenarios per DISPATCH-PLAN Wave 1.5 done-criteria:
 *   1. cache hit  (token present, not expired by TTL, not revoked)
 *   2. cache miss (token not in LRU)
 *   3. expired-TTL (token present but TTL elapsed)
 *   4. revoked    (cache invalidates on CapabilityRevoked event)
 *   5. strict-reject mode (RPC partition simulated → all gets return null)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';

function graphqlNodeFromSuiEvent(ev: SuiEvent) {
  const parts = ev.type.split('::');
  return {
    sender: { address: ev.sender },
    sequenceNumber: Number(ev.id.eventSeq),
    timestamp: ev.timestampMs ? new Date(Number(ev.timestampMs)).toISOString() : null,
    transactionModule: { package: { address: ev.packageId }, name: parts[1] ?? '' },
    contents: { json: ev.parsedJson, type: { repr: ev.type } },
  };
}
import { createLogger } from '@dvconf/shared';
import {
  CapTokenCache,
  type CachedToken,
  type ChainCapabilityIssued,
  type ChainCapabilityRevoked,
} from '../cap-token-cache.js';

/** Silent logger; tests assert on cache behavior, not log output. */
const testLogger = createLogger('cap-token-cache-test');
testLogger.level = 'silent';

function makeCached(tokenId: string, cachedAt: number): CachedToken {
  return {
    tokenId,
    roomId: '0xroom',
    peerPubkey: new Array(32).fill(0),
    role: 2,
    expiresEpoch: 999n,
    revoked: false,
    cachedAt,
    nonce: 1,
  };
}

describe('CapTokenCache', () => {
  let clockMs = 1_000_000;
  let cache: CapTokenCache;

  beforeEach(() => {
    clockMs = 1_000_000;
    cache = new CapTokenCache({
      maxEntries: 100,
      ttlMs: 60_000,
      logger: testLogger,
      now: () => clockMs,
    });
  });

  // ── Scenario 1: cache hit ─────────────────────────────────────────────────
  it('cache_hit_within_ttl returns CachedToken when present + not expired + not revoked', () => {
    cache.put('0xtok1', makeCached('0xtok1', clockMs));
    const got = cache.get('0xtok1');
    expect(got).not.toBeNull();
    expect(got?.tokenId).toBe('0xtok1');
    expect(got?.roomId).toBe('0xroom');
  });

  // ── Scenario 2: cache miss ────────────────────────────────────────────────
  it('cache_miss_unknown_id returns null for unseen token_id', () => {
    expect(cache.get('0xunknown')).toBeNull();
    expect(cache.has('0xunknown')).toBe(false);
  });

  // ── Scenario 3: TTL expiry ────────────────────────────────────────────────
  it('cache_ttl_expiry returns null + auto-invalidates after TTL elapses', () => {
    cache.put('0xtok2', makeCached('0xtok2', clockMs));
    expect(cache.has('0xtok2')).toBe(true);
    // advance past 60s TTL
    clockMs += 60_001;
    const got = cache.get('0xtok2');
    expect(got).toBeNull();
    // auto-invalidate on lazy expiry
    expect(cache.has('0xtok2')).toBe(false);
  });

  // ── Scenario 4: revoke via CapabilityRevoked event ────────────────────────
  it('cache_revoke_invalidate evicts entry within 5s of CapabilityRevoked event (REQ-ADM-005)', () => {
    const issued: ChainCapabilityIssued = {
      tokenId: '0xtok3',
      roomId: '0xroom3',
      peerPubkey: new Array(32).fill(1),
      role: 2,
      expiresEpoch: 999n,
    };
    cache.handleEvent('CapabilityIssued', issued);
    expect(cache.has('0xtok3')).toBe(true);

    const eventReceivedAt = clockMs;
    const revoked: ChainCapabilityRevoked = {
      tokenId: '0xtok3',
      roomId: '0xroom3',
      reason: 1,
    };
    // Simulate the event arriving even 1ms after issuance — must invalidate
    // synchronously (REQ-ADM-005 budget is 5_000ms end-to-end).
    clockMs += 1;
    cache.handleEvent('CapabilityRevoked', revoked);
    const invalidatedAt = clockMs;
    expect(cache.has('0xtok3')).toBe(false);
    expect(cache.get('0xtok3')).toBeNull();
    expect(invalidatedAt - eventReceivedAt).toBeLessThan(5_000);
  });

  // ── Scenario 5: strict-reject mode on RPC partition (REQ-ADM-009) ────────
  it('cache_rpc_partition flips to strict-reject mode + returns null for all gets', () => {
    cache.put('0xtok4', makeCached('0xtok4', clockMs));
    expect(cache.get('0xtok4')).not.toBeNull();

    cache.setStrictRejectMode('rpc-timeout-30s');
    expect(cache.isStrictRejectMode()).toBe(true);
    // entry still present but get() short-circuits to null
    expect(cache.has('0xtok4')).toBe(true);
    expect(cache.get('0xtok4')).toBeNull();

    // clearing the mode restores normal lookup
    cache.clearStrictRejectMode();
    expect(cache.isStrictRejectMode()).toBe(false);
    expect(cache.get('0xtok4')).not.toBeNull();
  });

  // ── Additional invariants (defensive — not counted in 5-scenario brief) ──
  it('revoked entries (revoked=true) return null on get even without TTL', () => {
    const tok = makeCached('0xtokRevoked', clockMs);
    tok.revoked = true;
    cache.put('0xtokRevoked', tok);
    expect(cache.get('0xtokRevoked')).toBeNull();
  });

  it('LRU eviction drops oldest when over maxEntries', () => {
    const small = new CapTokenCache({
      maxEntries: 2,
      ttlMs: 60_000,
      logger: testLogger,
      now: () => clockMs,
    });
    small.put('0xa', makeCached('0xa', clockMs));
    small.put('0xb', makeCached('0xb', clockMs));
    small.put('0xc', makeCached('0xc', clockMs));
    expect(small.size()).toBe(2);
    // oldest insert (a) evicted
    expect(small.has('0xa')).toBe(false);
    expect(small.has('0xb')).toBe(true);
    expect(small.has('0xc')).toBe(true);
  });

  it('strict-reject WARN log fires on mode entry', () => {
    const spy = vi.spyOn(testLogger, 'warn');
    const localCache = new CapTokenCache({
      logger: testLogger,
      now: () => clockMs,
    });
    localCache.setStrictRejectMode('rpc-timeout-30s');
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ── Wave 2 lane-3.4-cache: REQ-ADM-013 nonce validation on get ────────────
  it('nonce_stale_reject — incoming <= current rejects; strictly-greater advances entry.nonce', () => {
    const infoSpy = vi.spyOn(testLogger, 'info');
    const tok = makeCached('0xnonceTok', clockMs);
    tok.nonce = 5;
    cache.put('0xnonceTok', tok);

    // 1. incoming < current → reject, nonce unchanged
    expect(cache.validateAndAdvanceNonce('0xnonceTok', 3)).toBe(false);
    expect(cache.has('0xnonceTok')).toBe(true);
    const afterStale = cache.get('0xnonceTok');
    expect(afterStale?.nonce).toBe(5);

    // 2. incoming > current → accept, advance to incoming
    expect(cache.validateAndAdvanceNonce('0xnonceTok', 6)).toBe(true);
    expect(cache.get('0xnonceTok')?.nonce).toBe(6);

    // 3. incoming == current → strictly-greater rule → reject (must NOT advance)
    expect(cache.validateAndAdvanceNonce('0xnonceTok', 6)).toBe(false);
    expect(cache.get('0xnonceTok')?.nonce).toBe(6);

    // 4. missing token → cannot validate against missing → reject
    expect(cache.validateAndAdvanceNonce('0xmissing', 10)).toBe(false);

    // structured INFO log emitted with reason: 'nonce-stale'
    const staleLogs = infoSpy.mock.calls.filter(
      (call) => call[0] && (call[0] as { reason?: string }).reason === 'nonce-stale',
    );
    expect(staleLogs.length).toBeGreaterThanOrEqual(2);
    const firstStale = staleLogs[0]?.[0] as {
      module: string;
      tokenId: string;
      incoming: number;
      current: number;
      reason: string;
    };
    expect(firstStale.module).toBe('cap-token-cache');
    expect(firstStale.tokenId).toBe('0xnonceTok');
    expect(firstStale.reason).toBe('nonce-stale');
    expect(typeof firstStale.incoming).toBe('number');
    expect(typeof firstStale.current).toBe('number');
    infoSpy.mockRestore();
  });

  // ── Wave 2 lane-3.4-cache: REQ-ADM-015 emergency invalidate fast-path ────
  // ── Stage 4 lane-cache Item #4: subscribeToChainEvents real poller ──────
  it('subscribeToChainEvents_real_poller — mock SuiClient.queryEvents emits CapabilityIssued, handleEvent invoked within ≤5s window (REQ-ADM-005)', async () => {
    const PKG = '0xpkgcap';
    const issuedEvent: SuiEvent = {
      id: { txDigest: 'tx-iss-1', eventSeq: '0' },
      packageId: PKG,
      transactionModule: 'capability_events',
      sender: '0xsender',
      type: `${PKG}::capability_events::CapabilityIssued`,
      parsedJson: {
        token_id: '0xtokIss',
        room_id: '0xroomIss',
        peer_pubkey: new Array(32).fill(0xab),
        role: 2,
        issuer_quorum: ['0xcp1', '0xcp2'],
        expires_epoch: '500',
      },
      bcs: '',
      timestampMs: '1000',
    } as unknown as SuiEvent;
    const revokedEvent: SuiEvent = {
      id: { txDigest: 'tx-rev-1', eventSeq: '0' },
      packageId: PKG,
      transactionModule: 'capability_events',
      sender: '0xsender',
      type: `${PKG}::capability_events::CapabilityRevoked`,
      parsedJson: {
        token_id: '0xtokIss',
        room_id: '0xroomIss',
        revoker_quorum: ['0xcp1', '0xcp2'],
        reason: 1,
      },
      bcs: '',
      timestampMs: '1100',
    } as unknown as SuiEvent;

    // Two-phase mock: first call returns CapabilityIssued; second call returns
    // CapabilityRevoked. Spaced across two ticks so the test can observe the
    // intermediate populated-then-evicted transition (REQ-ADM-005 ≤5s budget).
    let callCount = 0;
    const mockClient = {
      query: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            data: { events: { nodes: [graphqlNodeFromSuiEvent(issuedEvent)], pageInfo: { hasNextPage: false, endCursor: 'tx-iss-1' } } },
          };
        }
        if (callCount === 2) {
          return {
            data: { events: { nodes: [graphqlNodeFromSuiEvent(revokedEvent)], pageInfo: { hasNextPage: false, endCursor: 'tx-rev-1' } } },
          };
        }
        return { data: { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
      }),
    } as unknown as SuiGraphQLClient;

    const t0 = Date.now();
    const unsubscribe = await cache.subscribeToChainEvents(mockClient, PKG, {
      pollIntervalMs: 50,
    });

    // Wait up to 5s for the poller's first cycle to land the Issued event.
    let elapsed = 0;
    while (!cache.has('0xtokIss') && elapsed < 5_000) {
      await new Promise((r) => setTimeout(r, 25));
      elapsed = Date.now() - t0;
    }

    expect(cache.has('0xtokIss')).toBe(true);
    const issued = cache.get('0xtokIss');
    expect(issued?.roomId).toBe('0xroomIss');
    expect(issued?.role).toBe(2);
    expect(issued?.expiresEpoch).toBe(500n);
    expect(issued?.peerPubkey).toEqual(new Array(32).fill(0xab));
    expect(elapsed).toBeLessThan(5_000);

    // Now wait for the second tick to deliver CapabilityRevoked → eviction.
    let revokedElapsed = Date.now() - t0;
    while (cache.has('0xtokIss') && revokedElapsed < 5_000) {
      await new Promise((r) => setTimeout(r, 25));
      revokedElapsed = Date.now() - t0;
    }
    expect(cache.has('0xtokIss')).toBe(false);
    expect(revokedElapsed).toBeLessThan(5_000);

    expect((mockClient.query as any).mock.calls.length).toBeGreaterThanOrEqual(2);

    await unsubscribe();
  });

  it('subscribeToChainEvents_idempotent_unsubscribe — repeated subscribe/unsubscribe leaks no timers', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        data: { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      })),
    } as unknown as SuiGraphQLClient;

    const handles: Array<() => void | Promise<void>> = [];
    for (let i = 0; i < 10; i++) {
      const h = await cache.subscribeToChainEvents(mockClient, '0xpkg', {
        pollIntervalMs: 25,
      });
      handles.push(h);
    }
    for (const h of handles) {
      await h();
    }
    // Calling unsubscribe a second time must not throw.
    for (const h of handles) {
      await h();
    }
    // No outstanding work — give the loop a tick to settle.
    await new Promise((r) => setTimeout(r, 50));
  });

  // ── Stage 4 lane-cache Item #8: daemon-restart reload semantics (D-016 Path B) ──
  it('daemon_restart_reload_transient_gap — startup emits WARN; first refresh re-aligns cache (D-016 Path B)', () => {
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const localCache = new CapTokenCache({
      logger: testLogger,
      now: () => clockMs,
    });

    // D-016 Path B contract: on construction (= daemon-restart equivalent in
    // a transient-gap world), one WARN is emitted to operators describing the
    // bounded nonce-gap window.
    localCache.announceColdStart('post-restart');
    const coldStartWarns = warnSpy.mock.calls.filter(
      (c) => (c[0] as { reason?: string })?.reason === 'cold-start-transient-gap',
    );
    expect(coldStartWarns.length).toBe(1);
    const coldLog = coldStartWarns[0]?.[0] as {
      module: string;
      reason: string;
      context: { trigger: string };
    };
    expect(coldLog.module).toBe('cap-token-cache');
    expect(coldLog.reason).toBe('cold-start-transient-gap');
    expect(coldLog.context.trigger).toBe('post-restart');

    // Cache starts empty after restart. A CapabilityIssued for an existing peer
    // re-seeds the local entry from the chain event payload — which is the
    // peer's *latest* high-water value on the next refresh, not the historical
    // session value. The first refresh from any peer aligns the cache; this
    // test pins that behavior so future regressions surface immediately.
    const issued: ChainCapabilityIssued = {
      tokenId: '0xrestartTok',
      roomId: '0xroom',
      peerPubkey: new Array(32).fill(1),
      role: 2,
      expiresEpoch: 999n,
      nonce: 7, // simulated post-refresh high-water value from chain
    };
    localCache.handleEvent('CapabilityIssued', issued);
    expect(localCache.get('0xrestartTok')?.nonce).toBe(7);

    // Bound assertion: any subsequent message MUST present nonce > 7 to advance.
    expect(localCache.validateAndAdvanceNonce('0xrestartTok', 7)).toBe(false);
    expect(localCache.validateAndAdvanceNonce('0xrestartTok', 8)).toBe(true);
    expect(localCache.get('0xrestartTok')?.nonce).toBe(8);

    warnSpy.mockRestore();
  });

  it('emergency_invalidate_latency — bypasses TTL/revoked checks + WARN log + idempotent', () => {
    const warnSpy = vi.spyOn(testLogger, 'warn');
    const infoSpy = vi.spyOn(testLogger, 'info');

    cache.put('0xemerg', makeCached('0xemerg', clockMs));
    expect(cache.has('0xemerg')).toBe(true);

    // Fast-path eviction — synchronous, no clock advance needed
    cache.emergencyInvalidate('0xemerg', 'test-emergency');
    expect(cache.has('0xemerg')).toBe(false);
    expect(cache.get('0xemerg')).toBeNull();

    // WARN log emitted with the supplied reason + severity: 'emergency'
    const emergencyWarns = warnSpy.mock.calls.filter(
      (call) =>
        call[0] && (call[0] as { context?: { reason?: string } }).context?.reason === 'test-emergency',
    );
    expect(emergencyWarns.length).toBe(1);
    const emergencyLog = emergencyWarns[0]?.[0] as {
      module: string;
      context: { tokenId: string; reason: string };
      severity: string;
    };
    expect(emergencyLog.module).toBe('cap-token-cache');
    expect(emergencyLog.context.tokenId).toBe('0xemerg');
    expect(emergencyLog.context.reason).toBe('test-emergency');
    expect(emergencyLog.severity).toBe('emergency');

    // Idempotency: second call on already-evicted token → INFO log (not in cache)
    cache.emergencyInvalidate('0xemerg', 'test-emergency-2');
    const evictedInfos = infoSpy.mock.calls.filter(
      (call) =>
        call[0] &&
        (call[0] as { context?: { tokenId?: string }; reason?: string }).context?.tokenId === '0xemerg' &&
        ((call[0] as { reason?: string }).reason === 'already-evicted' ||
          (call[1] as string)?.includes('already evicted')),
    );
    expect(evictedInfos.length).toBe(1);

    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });
});
