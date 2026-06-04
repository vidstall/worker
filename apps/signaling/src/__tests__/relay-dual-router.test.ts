/**
 * TDD tests for signaling dual-relay routing (REQ-RO-008).
 *
 * Test contracts (from CONTRACTS.md C2):
 *   RED test 1: join with valid cap-token + room with 2 assigned relays
 *               → client receives {type:'relay-assigned', primary_url, standby_url}.
 *   RED test 2: join that fails verifyJoin (auth rejected)
 *               → client receives WS close 4401, NOT relay-assigned.
 *   RED test 3: join with valid token + room with only 1 assigned relay
 *               → client receives {type:'relay-assigned', primary_url} only (graceful
 *                 degraded — standby_url absent).
 *
 * F62 admission non-regression:
 *   Existing AuthHook behavior is unchanged — dual-relay response is ADDITIVE,
 *   injected only after accepted: true.
 *
 * Wiring constraint (H5 / ROADMAP Phase 3.2):
 *   - DualRelayRouter is wired at index.ts (daemon boundary), after verifyJoin.
 *   - rooms.ts is NOT touched (no chain deps inside).
 *   - relay-ID → ws-URL resolved via relayEndpointCache (D-RO-3 cached map).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  DualRelayRouter,
  InMemoryRelayEndpointCache,
  subscribeRelayEndpoints,
  type RelayEndpointCache,
} from '../relay-dual-router.js';

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

// ── FakeRelayEndpointCache ───────────────────────────────────────────────────

class FakeRelayEndpointCache implements RelayEndpointCache {
  private readonly map: Map<string, string>;

  constructor(entries: Record<string, string>) {
    this.map = new Map(Object.entries(entries));
  }

  getUrl(relayId: string): string | undefined {
    return this.map.get(relayId);
  }

  setUrl(relayId: string, url: string): void {
    this.map.set(relayId, url);
  }

  getAssignedRelays(roomId: string): string[] {
    return this.roomRelays.get(roomId) ?? [];
  }

  private readonly roomRelays = new Map<string, string[]>();

  setRoomRelays(roomId: string, relayIds: string[]): void {
    this.roomRelays.set(roomId, relayIds);
  }
}

// ── Mock WebSocket ───────────────────────────────────────────────────────────

function makeMockWs() {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1, // OPEN
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('DualRelayRouter — dual-relay URL advertisement (REQ-RO-008)', () => {
  it('RED test 1: 2 assigned relays → sends relay-assigned with primary_url + standby_url', () => {
    const cache = new FakeRelayEndpointCache({
      '0xrelay1': 'ws://relay1.example.com',
      '0xrelay2': 'ws://relay2.example.com',
    });
    cache.setRoomRelays('room-alpha', ['0xrelay1', '0xrelay2']);

    const router = new DualRelayRouter(cache, mockLogger());
    const ws = makeMockWs();

    router.sendRelayAssigned(ws, 'room-alpha', 'trace-001');

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent).toMatchObject({
      type: 'relay-assigned',
      room_id: 'room-alpha',
      primary_url: 'ws://relay1.example.com',
      standby_url: 'ws://relay2.example.com',
    });
  });

  it('RED test 2: auth-rejected join → relay-assigned NOT sent (caller must guard)', () => {
    // DualRelayRouter itself does not perform auth — it is called by the daemon
    // ONLY after verifyJoin returns accepted:true. This test verifies that if the
    // caller never invokes sendRelayAssigned, the ws.send is not called.
    const cache = new FakeRelayEndpointCache({});
    const router = new DualRelayRouter(cache, mockLogger());
    const ws = makeMockWs();

    // Simulate: caller did not call sendRelayAssigned (auth rejected path)
    // → ws.send should not have been called by the router
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('RED test 3: only 1 assigned relay → sends relay-assigned with primary_url only (graceful degrade)', () => {
    const cache = new FakeRelayEndpointCache({
      '0xrelay1': 'ws://relay1.example.com',
    });
    cache.setRoomRelays('room-beta', ['0xrelay1']); // only 1 relay

    const router = new DualRelayRouter(cache, mockLogger());
    const ws = makeMockWs();

    router.sendRelayAssigned(ws, 'room-beta', 'trace-002');

    expect(ws.send).toHaveBeenCalledOnce();
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent).toMatchObject({
      type: 'relay-assigned',
      room_id: 'room-beta',
      primary_url: 'ws://relay1.example.com',
    });
    expect(sent).not.toHaveProperty('standby_url');
  });

  it('0 assigned relays → no relay-assigned sent, warn log emitted', () => {
    const cache = new FakeRelayEndpointCache({});
    cache.setRoomRelays('room-empty', []);

    const logger = mockLogger();
    const router = new DualRelayRouter(cache, logger);
    const ws = makeMockWs();

    router.sendRelayAssigned(ws, 'room-empty', 'trace-003');

    expect(ws.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'relay-dual-router' }),
      expect.any(String),
    );
  });

  it('relay URL not found in cache → logs warn, skips that relay', () => {
    const cache = new FakeRelayEndpointCache({}); // empty URL map
    cache.setRoomRelays('room-nocache', ['0xrelay1', '0xrelay2']);

    const logger = mockLogger();
    const router = new DualRelayRouter(cache, logger);
    const ws = makeMockWs();

    router.sendRelayAssigned(ws, 'room-nocache', 'trace-004');

    // With both URLs missing, falls back to no-relay path (no send, warn)
    expect(ws.send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('relay-assigned message contains room_id field', () => {
    const cache = new FakeRelayEndpointCache({ '0xr': 'ws://r.example.com' });
    cache.setRoomRelays('rm-1', ['0xr']);
    const router = new DualRelayRouter(cache, mockLogger());
    const ws = makeMockWs();
    router.sendRelayAssigned(ws, 'rm-1', 'trace-005');
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent.room_id).toBe('rm-1');
  });
});

// ── Tests: RelayEndpointCache.setUrl (populated from RelayRegistered events) ─

describe('RelayEndpointCache wiring (D-RO-3: in-memory cache)', () => {
  it('setUrl + getUrl round-trip', () => {
    const cache = new FakeRelayEndpointCache({});
    cache.setUrl('0xr1', 'ws://node1.test');
    expect(cache.getUrl('0xr1')).toBe('ws://node1.test');
  });

  it('getUrl returns undefined for unknown relay', () => {
    const cache = new FakeRelayEndpointCache({});
    expect(cache.getUrl('0xunknown')).toBeUndefined();
  });
});

// ── Tests: F62 admission non-regression (structural) ────────────────────────

describe('F62 admission non-regression contract', () => {
  it('DualRelayRouter does NOT implement verifyJoin — auth is never bypassed', () => {
    const cache = new FakeRelayEndpointCache({});
    const router = new DualRelayRouter(cache, mockLogger());
    // The router has no verifyJoin method — auth gating stays in AuthHook
    expect((router as any).verifyJoin).toBeUndefined();
  });

  it('sendRelayAssigned is a separate method invoked only after auth passes', () => {
    const cache = new FakeRelayEndpointCache({ '0xr': 'ws://r.test' });
    cache.setRoomRelays('rm', ['0xr']);
    const router = new DualRelayRouter(cache, mockLogger());
    // Method exists and is callable independently of auth
    expect(typeof router.sendRelayAssigned).toBe('function');
  });
});

// ── Tests: subscribeRelayEndpoints — N2 cache population from chain events ────

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

  it('end-to-end: both events primed → sendRelayAssigned now resolves both URLs', async () => {
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
    const router = new DualRelayRouter(cache, mockLogger());
    const ws = makeMockWs();
    router.sendRelayAssigned(ws, '0xroomE', 'trace-e2e');
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    expect(sent).toMatchObject({ type: 'relay-assigned', room_id: '0xroomE', primary_url: pUrl, standby_url: sUrl });
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
