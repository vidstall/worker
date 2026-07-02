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
import { toCanonicalRelayId } from '@dvconf/inter-relay-client';
import { resolvePrimaryEndpoint, resolveRelayEndpoint, resolveTreeParentDial } from '../relay-endpoint-resolver.js';
import { deriveTreePosition, type TreePosition } from '../tree-position.js';

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

describe('resolveRelayEndpoint (T-B: resolve ANY relayId, e.g. a tree parent/child)', () => {
  it('returns the cached url for the relayId', () => {
    const cache = { getUrl: (id: string) => (id === '0xparent' ? 'ws://parent:4000' : null) } as never;
    expect(resolveRelayEndpoint(cache, '0xparent')).toBe('ws://parent:4000');
  });
  it('null for an unknown relayId', () => {
    expect(resolveRelayEndpoint({ getUrl: () => null } as never, '0xnope')).toBeNull();
  });
});

describe('resolveTreeParentDial (T-B I1/N1: dial is a PURE function of tree position)', () => {
  const pos = (parent: string | null): TreePosition => ({
    parent, children: [], role: parent === null ? 'root' : 'leaf', diameter: 0, withinDiameterBound: true,
  });
  const mkCache = () => {
    const c = new InMemoryRelayEndpointCache();
    c.setUrl('0xparent', 'ws://parent:4000');
    return c;
  };

  it('a position WITH a parent → the PARENT url (child→parent link)', () => {
    expect(resolveTreeParentDial(pos('0xparent'), mkCache())).toBe('ws://parent:4000');
  });
  it('the true tree ROOT (parent===null) → null (accept-only, dials nobody)', () => {
    expect(resolveTreeParentDial(pos(null), mkCache())).toBeNull();
  });
  it('NO position (undefined) → null', () => {
    expect(resolveTreeParentDial(undefined, mkCache())).toBeNull();
  });
  it('parent not yet cached → null', () => {
    expect(resolveTreeParentDial(pos('0xuncached'), mkCache())).toBeNull();
  });
});

describe('I1 REGRESSION — the tree dial follows TREE-ROLE, not chain slot-0', () => {
  // relay_ids NOT sorted: chain slot-0 (0x02) is NOT the tree root (0x00 = sorted-min canonical).
  const relayIds = ['0x02', '0x00', '0x01'];
  const cache = { getUrl: (id: string) => `ws://${id}:4000` } as never; // resolves ANY canonical id

  it('a NON-root chain-primary (slot-0 = 0x02) dials its TREE PARENT (0x00), NOT nobody', () => {
    const posPrimary = deriveTreePosition(relayIds, '0x02', 2, 3);
    expect(posPrimary.parent).toBe(toCanonicalRelayId('0x00'));
    expect(resolveTreeParentDial(posPrimary, cache)).toBe('ws://' + toCanonicalRelayId('0x00') + ':4000');
  });
  it('the TREE ROOT (0x00, a chain-standby slot-1) dials NOBODY (parent===null)', () => {
    const posRoot = deriveTreePosition(relayIds, '0x00', 2, 3);
    expect(posRoot.parent).toBeNull();
    expect(resolveTreeParentDial(posRoot, cache)).toBeNull();
  });
  it('flag-OFF path is unchanged: the standby still resolves chain slot-0 directly', () => {
    // The shipped flag-off standby branch calls resolvePrimaryEndpoint(cache, relayIds) → slot-0 = 0x02.
    expect(resolvePrimaryEndpoint(cache, relayIds)).toBe('ws://0x02:4000');
  });
});
