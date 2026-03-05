/**
 * Unit tests for RoomManager — room-based WebSocket routing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { RoomManager } from '../rooms.js';

/** Create a mock WebSocket with a send spy and OPEN state. */
function mockWs(): WebSocket {
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
  } as unknown as WebSocket;
}

describe('RoomManager', () => {
  let rm: RoomManager;

  beforeEach(() => {
    rm = new RoomManager();
  });

  it('join adds peer to room', () => {
    const ws = mockWs();
    rm.join('room-1', ws, 'peer-1');

    expect(rm.getRoomSize('room-1')).toBe(1);
    expect(rm.getPeerId(ws)).toBe('peer-1');
    expect(rm.getRoomId(ws)).toBe('room-1');
  });

  it('broadcast sends to all except sender', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    const ws3 = mockWs();

    rm.join('room-1', ws1, 'peer-1');
    rm.join('room-1', ws2, 'peer-2');
    rm.join('room-1', ws3, 'peer-3');

    rm.broadcast('room-1', ws1, '{"test":"data"}');

    // ws1 (sender) should NOT receive
    expect(ws1.send).not.toHaveBeenCalledWith('{"test":"data"}');
    // ws2 and ws3 should receive
    expect(ws2.send).toHaveBeenCalledWith('{"test":"data"}');
    expect(ws3.send).toHaveBeenCalledWith('{"test":"data"}');
  });

  it('leave removes peer and cleans empty rooms', () => {
    const ws = mockWs();
    rm.join('room-1', ws, 'peer-1');
    expect(rm.getRoomSize('room-1')).toBe(1);

    rm.leave(ws);
    expect(rm.getRoomSize('room-1')).toBe(0);
    expect(rm.getPeerId(ws)).toBeUndefined();
    expect(rm.getStats().rooms).toBe(0);
  });

  it('peer-joined notification sent to existing members', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();

    rm.join('room-1', ws1, 'peer-1');
    rm.join('room-1', ws2, 'peer-2');

    // ws1 should have received a peer-joined notification when ws2 joined
    const calls = (ws1.send as ReturnType<typeof vi.fn>).mock.calls;
    const notifications = calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string) as { type: string; peerId: string },
    );
    expect(notifications).toContainEqual(
      expect.objectContaining({ type: 'peer-joined', peerId: 'peer-2' }),
    );
  });

  it('peer-left notification sent to remaining members', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();

    rm.join('room-1', ws1, 'peer-1');
    rm.join('room-1', ws2, 'peer-2');

    // Clear mocks to isolate the leave notification
    (ws1.send as ReturnType<typeof vi.fn>).mockClear();

    rm.leave(ws2);

    const calls = (ws1.send as ReturnType<typeof vi.fn>).mock.calls;
    const notifications = calls.map(
      (c: unknown[]) => JSON.parse(c[0] as string) as { type: string; peerId: string },
    );
    expect(notifications).toContainEqual(
      expect.objectContaining({ type: 'peer-left', peerId: 'peer-2' }),
    );
  });

  it('multiple rooms are isolated', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();

    rm.join('room-A', ws1, 'peer-1');
    rm.join('room-B', ws2, 'peer-2');

    // Clear any join notifications
    (ws1.send as ReturnType<typeof vi.fn>).mockClear();
    (ws2.send as ReturnType<typeof vi.fn>).mockClear();

    rm.broadcast('room-A', ws1, '{"msg":"for-A"}');

    // ws2 is in room-B, should NOT receive room-A broadcast
    expect(ws2.send).not.toHaveBeenCalled();

    expect(rm.getStats()).toEqual({ rooms: 2, connections: 2 });
  });

  it('joining a new room auto-leaves the previous room', () => {
    const ws = mockWs();

    rm.join('room-A', ws, 'peer-1');
    expect(rm.getRoomSize('room-A')).toBe(1);

    rm.join('room-B', ws, 'peer-1');
    expect(rm.getRoomSize('room-A')).toBe(0);
    expect(rm.getRoomSize('room-B')).toBe(1);
    expect(rm.getRoomId(ws)).toBe('room-B');
  });
});
