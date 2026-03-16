/**
 * In-memory metrics tracker for relay sessions.
 *
 * Tracks per-peer bandwidth and quality metrics for use in heartbeat load
 * reporting and on-chain session proofs. Exposes per-room and global
 * aggregation for the metrics HTTP endpoint (Phase 14 IC-5).
 *
 * Requirements: RELAY-05, Phase 14 IC-5
 */

export interface SessionMetrics {
  roomId: string;
  peerId: string;
  bytesForwarded: bigint;
  packetsLost: number;
  jitter: number;
  startedAt: number;
}

/** Per-room metrics response shape matching IC-5 spec. */
export interface RoomMetricsResponse {
  bytesForwarded: string;   // bigint serialized as string
  uniquePeers: number;
  packetsLost: number;
  jitter: number;
  duration: number;         // seconds since first peer joined
  activePeers: number;
}

/** Global health metrics response shape matching IC-5 spec. */
export interface GlobalMetricsResponse {
  totalBytesForwarded: string;  // bigint serialized as string
  activeSessions: number;
  roomCount: number;
}

export class MetricsTracker {
  private sessions = new Map<string, SessionMetrics>();

  /**
   * Tracks all-time unique peer IDs per room.
   * Peers are added on join and never removed (captures full session history).
   */
  private uniquePeersPerRoom = new Map<string, Set<string>>();

  /**
   * Tracks the set of room IDs that have active sessions.
   * Used by getGlobalMetrics() for room count.
   */
  private activeRooms = new Set<string>();

  private key(roomId: string, peerId: string): string {
    return `${roomId}:${peerId}`;
  }

  trackBytes(roomId: string, peerId: string, bytes: number): void {
    const k = this.key(roomId, peerId);
    const existing = this.sessions.get(k);
    if (existing) {
      existing.bytesForwarded += BigInt(bytes);
    } else {
      this.sessions.set(k, {
        roomId,
        peerId,
        bytesForwarded: BigInt(bytes),
        packetsLost: 0,
        jitter: 0,
        startedAt: Date.now(),
      });
    }

    // Track unique peers and active rooms
    this.activeRooms.add(roomId);
    let peers = this.uniquePeersPerRoom.get(roomId);
    if (!peers) {
      peers = new Set<string>();
      this.uniquePeersPerRoom.set(roomId, peers);
    }
    peers.add(peerId);
  }

  updateQuality(roomId: string, peerId: string, packetsLost: number, jitter: number): void {
    const k = this.key(roomId, peerId);
    const existing = this.sessions.get(k);
    if (existing) {
      existing.packetsLost = packetsLost;
      existing.jitter = jitter;
    }
  }

  getSessionMetrics(roomId: string, peerId: string): SessionMetrics | undefined {
    return this.sessions.get(this.key(roomId, peerId));
  }

  getTotalBytesForwarded(): bigint {
    let total = 0n;
    for (const session of this.sessions.values()) {
      total += session.bytesForwarded;
    }
    return total;
  }

  getActiveSessionCount(): number {
    return this.sessions.size;
  }

  clearSession(roomId: string, peerId: string): void {
    this.sessions.delete(this.key(roomId, peerId));
  }

  /** Clear all sessions for a given room (used on room teardown). */
  clearRoom(roomId: string): void {
    for (const [key] of this.sessions) {
      if (key.startsWith(`${roomId}:`)) {
        this.sessions.delete(key);
      }
    }
    this.activeRooms.delete(roomId);
    // Note: uniquePeersPerRoom is NOT cleared -- preserves all-time history
    // until the room data is explicitly purged.
  }

  /**
   * Get aggregated metrics for a specific room.
   * Returns null if the room has no session data.
   */
  getRoomMetrics(roomId: string): RoomMetricsResponse | null {
    // Collect all sessions for this room
    const roomSessions: SessionMetrics[] = [];
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${roomId}:`)) {
        roomSessions.push(session);
      }
    }

    // Also check uniquePeers -- room may have had peers that already left
    const uniquePeers = this.uniquePeersPerRoom.get(roomId);
    if (roomSessions.length === 0 && !uniquePeers) {
      return null;
    }

    // Aggregate metrics across all peers in the room
    let totalBytes = 0n;
    let totalPacketsLost = 0;
    let maxJitter = 0;
    let earliestStart = Infinity;

    for (const session of roomSessions) {
      totalBytes += session.bytesForwarded;
      totalPacketsLost += session.packetsLost;
      if (session.jitter > maxJitter) {
        maxJitter = session.jitter;
      }
      if (session.startedAt < earliestStart) {
        earliestStart = session.startedAt;
      }
    }

    const durationMs = earliestStart === Infinity ? 0 : Date.now() - earliestStart;
    const durationSec = Math.floor(durationMs / 1000);

    return {
      bytesForwarded: totalBytes.toString(),
      uniquePeers: uniquePeers?.size ?? 0,
      packetsLost: totalPacketsLost,
      jitter: maxJitter,
      duration: durationSec,
      activePeers: roomSessions.length,
    };
  }

  /**
   * Get global health metrics across all rooms.
   */
  getGlobalMetrics(): GlobalMetricsResponse {
    return {
      totalBytesForwarded: this.getTotalBytesForwarded().toString(),
      activeSessions: this.getActiveSessionCount(),
      roomCount: this.activeRooms.size,
    };
  }
}
