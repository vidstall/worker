/**
 * Tests for the shared relay endpoint cache + chain subscription (REQ-RO-008 /
 * D-RO-3). Extracted from apps/signaling/src/__tests__/relay-dual-router.test.ts
 * (G3.2a) so the cache/subscribe contract is tested where it now lives. The
 * `DualRelayRouter`-coupled e2e stays in the signaling test (ws-dependent).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryRelayEndpointCache,
  subscribeRelayEndpoints,
} from '../chain/relay-endpoint-cache.js';

// ── Logger stub ──────────────────────────────────────────────────────────────

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

// ── Mock SuiClient ───────────────────────────────────────────────────────────

/**
 * Mock SuiClient.queryEvents returning a fixed page per module on the FIRST
 * poll, then empty. `subscribeRelayEndpoints` primes once (await tick) so a
 * single poll populates the cache deterministically without timers.
 */
function makeMockSuiClient(events: {
  relay_registry?: any[];
  room_manager?: any[];
}) {
  const served = { relay_registry: false, room_manager: false };
  return {
    queryEvents: vi.fn(async ({ query }: any) => {
      const mod = query.MoveEventModule.module as 'relay_registry' | 'room_manager';
      if (served[mod]) return { data: [], hasNextPage: false, nextCursor: null };
      served[mod] = true;
      return {
        data: events[mod] ?? [],
        hasNextPage: false,
        nextCursor: { txDigest: '0xtx', eventSeq: '1' },
      };
    }),
  } as any;
}

// ── Tests: InMemoryRelayEndpointCache (the real impl) ────────────────────────

describe('InMemoryRelayEndpointCache (D-RO-3: in-memory cache)', () => {
  it('setUrl + getUrl round-trip', () => {
    const cache = new InMemoryRelayEndpointCache();
    cache.setUrl('0xr1', 'ws://node1.test');
    expect(cache.getUrl('0xr1')).toBe('ws://node1.test');
  });

  it('getUrl returns undefined for unknown relay', () => {
    const cache = new InMemoryRelayEndpointCache();
    expect(cache.getUrl('0xunknown')).toBeUndefined();
  });

  it('setRoomRelays + getAssignedRelays round-trip (ordered: [0]=primary, [1]=standby)', () => {
    const cache = new InMemoryRelayEndpointCache();
    cache.setRoomRelays('room-1', ['0xprimary', '0xstandby']);
    expect(cache.getAssignedRelays('room-1')).toEqual(['0xprimary', '0xstandby']);
  });

  it('getAssignedRelays returns [] for an unassigned room', () => {
    const cache = new InMemoryRelayEndpointCache();
    expect(cache.getAssignedRelays('0xnope')).toEqual([]);
  });

  it('onRelayRegistered decodes UTF-8 endpoint bytes into the URL', () => {
    const cache = new InMemoryRelayEndpointCache();
    const url = 'ws://relay-utf8.test:4000';
    cache.onRelayRegistered('0xr', Array.from(Buffer.from(url, 'utf8')));
    expect(cache.getUrl('0xr')).toBe(url);
  });
});

// ── Tests: subscribeRelayEndpoints — cache population from chain events ───────

describe('subscribeRelayEndpoints — cache population (N2, REQ-RO-008)', () => {
  it('RelayRegistered event → cache.onRelayRegistered (id → ws URL from UTF-8 bytes)', async () => {
    const url = 'ws://relay-x.test';
    const urlBytes = Array.from(Buffer.from(url, 'utf8'));
    const client = makeMockSuiClient({
      relay_registry: [
        {
          type: '0xpkg::relay_registry::RelayRegistered',
          parsedJson: { miner_id: '0xrelayX', endpoint_url: urlBytes },
        },
      ],
    });
    const cache = new InMemoryRelayEndpointCache();
    const stop = await subscribeRelayEndpoints(client, '0xpkg', cache, mockLogger(), {
      pollIntervalMs: 999_999,
    });
    expect(cache.getUrl('0xrelayX')).toBe(url);
    await stop();
  });

  it('RoomAssigned event → cache.setRoomRelays (room → [primary, standby])', async () => {
    const client = makeMockSuiClient({
      room_manager: [
        {
          type: '0xpkg::room_manager::RoomAssigned',
          parsedJson: { room_id: '0xroomA', relay_ids: ['0xprimary', '0xstandby'] },
        },
      ],
    });
    const cache = new InMemoryRelayEndpointCache();
    const stop = await subscribeRelayEndpoints(client, '0xpkg', cache, mockLogger(), {
      pollIntervalMs: 999_999,
    });
    expect(cache.getAssignedRelays('0xroomA')).toEqual(['0xprimary', '0xstandby']);
    await stop();
  });

  it('end-to-end: both events primed → cache resolves both relay URLs + assigned list', async () => {
    const pUrl = 'ws://primary.test';
    const sUrl = 'ws://standby.test';
    const client = makeMockSuiClient({
      relay_registry: [
        { type: '0xpkg::relay_registry::RelayRegistered', parsedJson: { miner_id: '0xp', endpoint_url: Array.from(Buffer.from(pUrl, 'utf8')) } },
        { type: '0xpkg::relay_registry::RelayRegistered', parsedJson: { miner_id: '0xs', endpoint_url: Array.from(Buffer.from(sUrl, 'utf8')) } },
      ],
      room_manager: [
        { type: '0xpkg::room_manager::RoomAssigned', parsedJson: { room_id: '0xroomE', relay_ids: ['0xp', '0xs'] } },
      ],
    });
    const cache = new InMemoryRelayEndpointCache();
    const stop = await subscribeRelayEndpoints(client, '0xpkg', cache, mockLogger(), {
      pollIntervalMs: 999_999,
    });
    expect(cache.getAssignedRelays('0xroomE')).toEqual(['0xp', '0xs']);
    expect(cache.getUrl('0xp')).toBe(pUrl);
    expect(cache.getUrl('0xs')).toBe(sUrl);
    await stop();
  });

  it('stop() is idempotent — safe to call twice', async () => {
    const client = makeMockSuiClient({});
    const cache = new InMemoryRelayEndpointCache();
    const stop = await subscribeRelayEndpoints(client, '0xpkg', cache, mockLogger(), {
      pollIntervalMs: 999_999,
    });
    await stop();
    await expect(stop()).resolves.toBeUndefined();
  });

  it('unknown event names are ignored (forward-compat)', async () => {
    const client = makeMockSuiClient({
      relay_registry: [
        { type: '0xpkg::relay_registry::RelayLoadUpdated', parsedJson: { miner_id: '0xr', new_load: '5' } },
      ],
    });
    const cache = new InMemoryRelayEndpointCache();
    const stop = await subscribeRelayEndpoints(client, '0xpkg', cache, mockLogger(), {
      pollIntervalMs: 999_999,
    });
    expect(cache.getUrl('0xr')).toBeUndefined();
    await stop();
  });
});
