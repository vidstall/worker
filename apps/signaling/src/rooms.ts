/**
 * Room-based WebSocket message routing for signaling.
 *
 * Manages peer membership in rooms and broadcasts messages to room peers.
 * This module has NO chain dependencies -- it is pure WebSocket routing.
 */

import type { WebSocket } from 'ws';
import { createGauge, createDurationHistogram, type Registry } from '@dvconf/shared';

// ── Economic tracking (off-chain only) ──────────────────────────────
// Tracks completed room sessions for reward eligibility reporting.
// On-chain reward claims are deferred to Phase 14+.

/** Number of room sessions that have completed (all peers left). */
let sessionsRouted = 0;

/** Get the total number of completed room sessions. */
export function getSessionsRouted(): number {
  return sessionsRouted;
}

// Monitoring-redesign gap #3: dvconf_rooms_active (index.ts) only exposes the
// aggregate open-room count -- there was no per-room detail at all, needed
// for the new Rooms dashboard. Same opt-in module-level registration pattern
// as role-voter.ts/role-assignment.ts; RoomManager owns these since join/
// leave (where per-room participant count and lifetime are known) live here.
let roomParticipantsGauge: ReturnType<typeof createGauge> | null = null;
let roomDurationHistogram: ReturnType<typeof createDurationHistogram> | null = null;

/** Wire `dvconf_room_participants{roomId}` and `dvconf_room_duration_seconds` into `registry` -- call once at signaling startup. */
export function registerRoomMetrics(registry: Registry): void {
  roomParticipantsGauge = createGauge(
    registry,
    'dvconf_room_participants',
    'Current participant count for this room',
    ['roomId'],
  );
  roomDurationHistogram = createDurationHistogram(
    registry,
    'dvconf_room_duration_seconds',
    'Duration a room stayed open, from first join to the last peer leaving',
    [],
  );
}

/** Message sent to peers when another peer joins or leaves. */
export interface PeerNotification {
  type: 'peer-joined' | 'peer-left';
  peerId: string;
  roomId: string;
}

/** Peer metadata stored alongside the WebSocket connection. */
interface PeerInfo {
  peerId: string;
  roomId: string;
}

export class RoomManager {
  /** roomId -> Set of WebSocket connections in that room. */
  private rooms = new Map<string, Set<WebSocket>>();

  /** ws -> peer info (for reverse lookup on disconnect). */
  private peers = new Map<WebSocket, PeerInfo>();

  /** roomId -> first-join timestamp (ms), for dvconf_room_duration_seconds. */
  private roomCreatedAt = new Map<string, number>();

  /**
   * Add a peer to a room. Broadcasts 'peer-joined' to existing room members.
   */
  join(roomId: string, ws: WebSocket, peerId: string): void {
    // Leave any existing room first
    if (this.peers.has(ws)) {
      this.leave(ws);
    }

    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Set());
      this.roomCreatedAt.set(roomId, Date.now());
    }

    const room = this.rooms.get(roomId)!;

    // Notify existing peers
    const notification: PeerNotification = {
      type: 'peer-joined',
      peerId,
      roomId,
    };
    this.broadcastToRoom(roomId, ws, JSON.stringify(notification));

    // Add the new peer
    room.add(ws);
    this.peers.set(ws, { peerId, roomId });
    roomParticipantsGauge?.set({ roomId }, room.size);
  }

  /**
   * Remove a peer from its current room. Broadcasts 'peer-left' to remaining members.
   * Cleans up empty rooms.
   */
  leave(ws: WebSocket): void {
    const info = this.peers.get(ws);
    if (!info) return;

    const { peerId, roomId } = info;
    const room = this.rooms.get(roomId);

    if (room) {
      room.delete(ws);

      // Notify remaining peers
      const notification: PeerNotification = {
        type: 'peer-left',
        peerId,
        roomId,
      };
      this.broadcastToRoom(roomId, ws, JSON.stringify(notification));

      // Clean up empty rooms -- counts as a completed session
      if (room.size === 0) {
        this.rooms.delete(roomId);
        sessionsRouted++;
        roomParticipantsGauge?.remove({ roomId });
        const createdAt = this.roomCreatedAt.get(roomId);
        if (createdAt !== undefined) {
          roomDurationHistogram?.observe((Date.now() - createdAt) / 1000);
          this.roomCreatedAt.delete(roomId);
        }
      } else {
        roomParticipantsGauge?.set({ roomId }, room.size);
      }
    }

    this.peers.delete(ws);
  }

  /**
   * Broadcast a message to all peers in a room except the sender.
   */
  broadcast(roomId: string, sender: WebSocket, message: string): void {
    this.broadcastToRoom(roomId, sender, message);
  }

  /**
   * Get the number of peers in a room.
   */
  getRoomSize(roomId: string): number {
    return this.rooms.get(roomId)?.size ?? 0;
  }

  /**
   * Get aggregate stats.
   */
  getStats(): { rooms: number; connections: number } {
    let connections = 0;
    for (const room of this.rooms.values()) {
      connections += room.size;
    }
    return { rooms: this.rooms.size, connections };
  }

  /**
   * Get the peer ID for a given WebSocket connection.
   */
  getPeerId(ws: WebSocket): string | undefined {
    return this.peers.get(ws)?.peerId;
  }

  /**
   * Get the room ID for a given WebSocket connection.
   */
  getRoomId(ws: WebSocket): string | undefined {
    return this.peers.get(ws)?.roomId;
  }

  private broadcastToRoom(
    roomId: string,
    exclude: WebSocket,
    message: string,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const peer of room) {
      if (peer !== exclude && peer.readyState === 1 /* WebSocket.OPEN */) {
        peer.send(message);
      }
    }
  }
}
