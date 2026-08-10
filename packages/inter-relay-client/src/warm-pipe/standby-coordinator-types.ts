/**
 * Standalone types + constants for the standby warm-pipe coordinator — split
 * out of standby-coordinator.ts so they can be shared with
 * standby-coordinator-reverse.ts without either module closing over the
 * coordinator class's private state.
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import type { RoomTopology } from '../relay-role-manager.js';

/**
 * Per-room bookkeeping the coordinator needs to drive the not-ready re-run.
 * `producerId` is the id the LAST ensureWarmPipe consumed for the room — either
 * the resolved real id or the `pipe-producer-pending-<roomId>` placeholder.
 */
export interface WarmPipeState {
  topology: RoomTopology;
  router: msTypes.Router;
  pipePort: number;
  /** The producerId consumed by the most recent ensureWarmPipe for this room. */
  consumedProducerId: string;
  /** True while we are still on the placeholder (announce not yet resolved). */
  pending: boolean;
}

/** Mirrors the placeholder ensureWarmPipe falls back to (relay-role-manager). */
export function placeholderProducerId(roomId: string): string {
  return `pipe-producer-pending-${roomId}`;
}

/**
 * REQ-RMS-034 / 026 (part-3 reverse leg) — pushes a standby's local-client
 * producer UP to the primary over the warm pipe. Mirrors the forward announcer's
 * closure shape `(roomId, producer, producerPeerId?, peerRelayId?, rtpParameters?)`:
 * the `producer` is the PIPED consumer (its `.id` is the id the primary consumes,
 * NOT the source producer's id); `rtpParameters` are the pipe-CONSUMER's REMAPPED
 * params (REQ-RMS-026 — the SSRC differs across the pipe), so the primary's
 * produceLocalFromPipe ingests it correctly. Bound by the wiring layer (index.ts)
 * via setReverseAnnouncer; null until wired (forward/keepalive-only rooms never set
 * it → byte-stable).
 */
export type ReverseUpAnnouncer = (
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId?: string,
  peerRelayId?: string,
  rtpParameters?: msTypes.RtpParameters,
  /**
   * REQ-RMS-044 (cascade-tree) — loop-guard hop budget carried UP the reverse leg. Additive
   * trailing (default-omit) so an existing 5-arg reverse announce is byte-identical.
   */
  hopTtl?: number,
  /**
   * REQ-RMS-046 (cascade-tree) — the IMMUTABLE origin producerId, threaded unchanged so an
   * internal node forwarding UP preserves the per-room dedup key. Additive trailing (default-omit).
   */
  originProducerId?: string,
) => void;
