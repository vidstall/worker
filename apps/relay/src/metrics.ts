/**
 * In-memory metrics tracker for relay sessions.
 *
 * Tracks per-peer bandwidth and quality metrics for use in heartbeat load
 * reporting and future Phase 13 on-chain session proofs.
 *
 * Requirements: RELAY-05
 */

export interface SessionMetrics {
  roomId: string;
  peerId: string;
  bytesForwarded: bigint;
  packetsLost: number;
  jitter: number;
  startedAt: number;
}

export class MetricsTracker {
  private sessions = new Map<string, SessionMetrics>();

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
  }
}
