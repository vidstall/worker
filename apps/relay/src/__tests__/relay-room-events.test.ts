/**
 * Unit tests for relay-room-events.ts's `RelayPromoted` handling — specifically
 * the surviving-standby re-dial gap (a standby whose primary just changed to
 * someone ELSE never re-targeted its inter-relay pipe/heartbeat, so a second
 * cascading relay death left it connectable but with no media to serve).
 *
 * Runs the REAL createRoomEventHandler factory against mocked deps — mirrors
 * relay-promotion.test.ts's approach. promoteToPrimary / startStandbyHeartbeat /
 * stopStandbyHeartbeat are injected as vi.fn() mocks (their own real behavior is
 * already covered by relay-promotion.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { InMemoryRelayEndpointCache } from '@dvconf/shared';
import { createRoomEventHandler, type RoomEventHandlerDeps } from '../relay-room-events.js';

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

function makeDeps(overrides?: Partial<RoomEventHandlerDeps>): RoomEventHandlerDeps {
  const cache = new InMemoryRelayEndpointCache();
  return {
    myMinerId: 'r1-standby',
    interRelayContext: { role: 'standby' } as any,
    probeLiveness: { role: 'standby' } as any,
    roomTreePosition: new Map(),
    roomAssignedRelays: new Map(),
    relayEndpointCacheRef: { current: cache },
    standbyLink: { primaryUrl: null },
    standbyLinkManager: { connectTo: vi.fn() },
    standbyPrewarmRooms: new Map(),
    prewarmRoom: vi.fn().mockResolvedValue(undefined),
    startStandbyHeartbeat: vi.fn(),
    stopStandbyHeartbeat: vi.fn(),
    promoteToPrimary: vi.fn(),
    logger: mockLogger(),
    ...overrides,
  };
}

function relayPromotedEvent(roomId: string, newPrimary: string) {
  return {
    type: 'pkg::room_manager_events::RelayPromoted',
    parsedJson: { room_id: roomId, new_primary: newPrimary },
  };
}

describe('createRoomEventHandler — RelayPromoted (surviving standby re-dial)', () => {
  it('re-dials and restarts the heartbeat when the primary changes to someone else', async () => {
    const deps = makeDeps({ myMinerId: 'r1-standby' });
    deps.roomAssignedRelays.set('room-1', ['r0-dead-primary', 'r1-standby', 'r2-standby']);
    deps.relayEndpointCacheRef.current!.setUrl('r2-standby', 'wss://r2.example.com');
    deps.interRelayContext.role = 'standby';

    const handler = createRoomEventHandler(deps);
    await handler(relayPromotedEvent('room-1', 'r2-standby'));

    expect(deps.standbyLink.primaryUrl).toBe('wss://r2.example.com');
    expect(deps.standbyLinkManager.connectTo).toHaveBeenCalledWith('wss://r2.example.com');
    expect(deps.startStandbyHeartbeat).toHaveBeenCalledWith('room-1', 'wss://r2.example.com');
    expect(deps.roomAssignedRelays.get('room-1')).toEqual([
      'r2-standby', 'r0-dead-primary', 'r1-standby',
    ]);
    expect(deps.interRelayContext.role).toBe('standby');
    expect(deps.probeLiveness.role).toBe('standby');
    expect(deps.promoteToPrimary).not.toHaveBeenCalled();
  });

  it('leaves the existing "I am the new primary" path unchanged', async () => {
    const deps = makeDeps({ myMinerId: 'r1-standby' });
    deps.roomAssignedRelays.set('room-1', ['r0-dead-primary', 'r1-standby', 'r2-standby']);

    const handler = createRoomEventHandler(deps);
    await handler(relayPromotedEvent('room-1', 'r1-standby'));

    expect(deps.promoteToPrimary).toHaveBeenCalledOnce();
    expect(deps.promoteToPrimary).toHaveBeenCalledWith('room-1');
    // The surviving-standby branch must NOT also fire for the promoted relay itself.
    expect(deps.standbyLinkManager.connectTo).not.toHaveBeenCalled();
    expect(deps.startStandbyHeartbeat).not.toHaveBeenCalled();
    expect(deps.roomAssignedRelays.get('room-1')).toEqual([
      'r0-dead-primary', 'r1-standby', 'r2-standby',
    ]);
  });

  it('is a no-op for a relay not assigned to the room', async () => {
    const deps = makeDeps({ myMinerId: 'r3-unrelated' });
    deps.roomAssignedRelays.set('room-1', ['r0-dead-primary', 'r1-standby', 'r2-standby']);

    const handler = createRoomEventHandler(deps);
    await handler(relayPromotedEvent('room-1', 'r2-standby'));

    expect(deps.standbyLinkManager.connectTo).not.toHaveBeenCalled();
    expect(deps.startStandbyHeartbeat).not.toHaveBeenCalled();
    expect(deps.promoteToPrimary).not.toHaveBeenCalled();
    expect(deps.standbyLink.primaryUrl).toBeNull();
  });

  it('still restarts the heartbeat (with null) when the new primary endpoint is not yet resolvable', async () => {
    const deps = makeDeps({ myMinerId: 'r1-standby' });
    deps.roomAssignedRelays.set('room-1', ['r0-dead-primary', 'r1-standby', 'r2-standby']);
    // Endpoint cache never populated for r2-standby.

    const handler = createRoomEventHandler(deps);
    await handler(relayPromotedEvent('room-1', 'r2-standby'));

    expect(deps.standbyLink.primaryUrl).toBeNull();
    expect(deps.standbyLinkManager.connectTo).not.toHaveBeenCalled();
    expect(deps.startStandbyHeartbeat).toHaveBeenCalledWith('room-1', null);
  });

  it('is a no-op when new_primary is missing from the event payload', async () => {
    const deps = makeDeps({ myMinerId: 'r1-standby' });
    deps.roomAssignedRelays.set('room-1', ['r0-dead-primary', 'r1-standby', 'r2-standby']);

    const handler = createRoomEventHandler(deps);
    await handler({ type: 'pkg::room_manager_events::RelayPromoted', parsedJson: { room_id: 'room-1' } });

    expect(deps.standbyLinkManager.connectTo).not.toHaveBeenCalled();
    expect(deps.startStandbyHeartbeat).not.toHaveBeenCalled();
    expect(deps.promoteToPrimary).not.toHaveBeenCalled();
  });

  it('defensively resets role back to standby if it had drifted to primary', async () => {
    const deps = makeDeps({ myMinerId: 'r1-standby' });
    deps.roomAssignedRelays.set('room-1', ['r0-dead-primary', 'r1-standby', 'r2-standby']);
    deps.relayEndpointCacheRef.current!.setUrl('r2-standby', 'wss://r2.example.com');
    // Simulate this relay's own Layer B heartbeat having already (incorrectly)
    // self-promoted it while it was still pinging the dead original primary.
    deps.interRelayContext.role = 'primary';
    deps.probeLiveness.role = 'primary';

    const handler = createRoomEventHandler(deps);
    await handler(relayPromotedEvent('room-1', 'r2-standby'));

    expect(deps.interRelayContext.role).toBe('standby');
    expect(deps.probeLiveness.role).toBe('standby');
  });
});
