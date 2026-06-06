/**
 * TDD tests for the relay-side primary-endpoint resolver (G3.2a, REQ-RO-008 / G3).
 *
 * A STANDBY relay must resolve `relayIds[0]` (the PRIMARY relay's miner_id) into
 * the primary's WS endpoint URL, read from the shared `RelayEndpointCache` (which
 * `subscribeRelayEndpoints` populates from chain `RelayRegistered` events). This
 * is the pure, unit-testable half of G3.2a; the live `subscribeRelayEndpoints`
 * start + `new WebSocket(primaryUrl)` socket open are the index.ts glue (G3.2b).
 *
 * Contract: `resolvePrimaryEndpoint(cache, relayIds)`
 *   - relayIds[0] = primary (length-driven, never hardcoded — per determineRole).
 *   - returns the cached URL for relayIds[0], or null when absent/uncached.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryRelayEndpointCache } from '@dvconf/shared';
import { resolvePrimaryEndpoint } from '../relay-endpoint-resolver.js';

describe('resolvePrimaryEndpoint (G3.2a relay-side resolution)', () => {
  it('resolves relayIds[0] → the primary relay’s cached WS URL', () => {
    const cache = new InMemoryRelayEndpointCache();
    cache.setUrl('0xprimary', 'ws://primary.example.com:4000');
    cache.setUrl('0xstandby', 'ws://standby.example.com:4000');

    const url = resolvePrimaryEndpoint(cache, ['0xprimary', '0xstandby']);
    expect(url).toBe('ws://primary.example.com:4000');
  });

  it('returns the PRIMARY ([0]), not the standby ([1]) — direction is fixed', () => {
    const cache = new InMemoryRelayEndpointCache();
    cache.setUrl('0xa', 'ws://a.test');
    cache.setUrl('0xb', 'ws://b.test');
    // From the standby's perspective, [0] is always the primary it dials.
    expect(resolvePrimaryEndpoint(cache, ['0xa', '0xb'])).toBe('ws://a.test');
  });

  it('returns null when relayIds is empty (unassigned room)', () => {
    const cache = new InMemoryRelayEndpointCache();
    expect(resolvePrimaryEndpoint(cache, [])).toBeNull();
  });

  it('returns null for a blank/falsy primary id (malformed relayIds[0])', () => {
    const cache = new InMemoryRelayEndpointCache();
    // The `!primaryId` guard intentionally rejects an empty-string id, not just
    // an absent one — a blank chain id must not resolve.
    expect(resolvePrimaryEndpoint(cache, [''])).toBeNull();
    expect(resolvePrimaryEndpoint(cache, ['', '0xstandby'])).toBeNull();
  });

  it('returns null when the primary relay’s URL is not yet in the cache', () => {
    const cache = new InMemoryRelayEndpointCache();
    // standby cached, but primary (relayIds[0]) not registered yet
    cache.setUrl('0xstandby', 'ws://standby.test');
    expect(resolvePrimaryEndpoint(cache, ['0xprimary', '0xstandby'])).toBeNull();
  });

  it('is length-driven — a single-relay room resolves [0] only', () => {
    const cache = new InMemoryRelayEndpointCache();
    cache.setUrl('0xsolo', 'ws://solo.test');
    expect(resolvePrimaryEndpoint(cache, ['0xsolo'])).toBe('ws://solo.test');
  });

  it('resolves from a cache populated via onRelayRegistered (UTF-8 bytes round-trip)', () => {
    const cache = new InMemoryRelayEndpointCache();
    const url = 'ws://chain-registered.test:4000';
    cache.onRelayRegistered('0xprimary', Array.from(Buffer.from(url, 'utf8')));
    expect(resolvePrimaryEndpoint(cache, ['0xprimary', '0xstandby'])).toBe(url);
  });
});
