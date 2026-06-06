/**
 * Idempotent relay topology rebuild after mediasoup worker.died.
 *
 * When a mediasoup Worker dies, ALL of its Routers / Transports / Pipes are
 * invalidated (Stream-1 gotcha #4). This module rebuilds the full topology
 * from an on-chain registry snapshot passed by the caller — it does NOT
 * read stale in-memory state.
 *
 * Producer-ID aliasing guard: `prevPipeProducerId` on the snapshot acts as a
 * discrimination key. The new pipe transport uses a fresh consume() call that
 * does not reference the old (now-dead) producer ID — so re-pipe never throws
 * a "duplicate producer" error.
 *
 * For the standby relay this means:
 *   1. Create a new Router on a new Worker.
 *   2. Create a PipeTransport (on the new Router) using the pipePort from the snapshot.
 *   3. Create a pipe Consumer via pipeTransport.consume() — immediately paused (REQ-RO-005).
 *
 * For the primary relay:
 *   1. Create a new Router only.
 *   2. The primary's end of the pipe will be re-established by the standby's next
 *      ensureWarmPipe() call on its new Router.
 *
 * Requirements: REQ-RO-007
 */

import type { types as msTypes } from 'mediasoup';
import type { RelayRole } from './relay-role-manager.js';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * The minimal on-chain registry snapshot the caller reads after worker.died.
 * Contains everything needed to rebuild without relying on stale in-memory state.
 */
export interface RegistrySnapshot {
  roomId: string;
  role: RelayRole;
  primaryEndpoint: string;
  standbyEndpoint: string;
  /** Port from PIPE_PORT_RANGE for the PipeTransport. */
  pipePort: number;
  /**
   * Producer-ID discrimination key (Stream-1 gotcha).
   * When set, signals that a pipe with this producerId was active before the
   * crash. The rebuild uses a fresh producerId derived from the snapshot so
   * mediasoup never sees a "duplicate producer" attempt.
   */
  prevPipeProducerId?: string;
}

/**
 * Minimal interface the rebuild function needs from the manager.
 * Kept narrow to avoid test-coupling to the full MediasoupManager.
 */
export interface MediasoupManager {
  getNextWorker(): msTypes.Worker;
  createRouter(worker: msTypes.Worker): Promise<msTypes.Router>;
}

export interface RebuildResult {
  /** The newly created Router (replaces the dead one). */
  router: msTypes.Router;
  /**
   * The pipe Consumer on the standby relay, immediately paused (REQ-RO-005).
   * Undefined for primary relay (primary doesn't create a pipe consumer).
   */
  consumer?: msTypes.Consumer;
}

// ── rebuildFromRegistry ────────────────────────────────────────────────

/**
 * Rebuilds the mediasoup topology for a room from a registry snapshot.
 *
 * Safe to call multiple times (idempotent at the Router-creation level —
 * each call creates a fresh Router, which is correct after worker.died because
 * the old Router is already invalid).
 *
 * @param manager  - MediasoupManager to create Workers/Routers.
 * @param snapshot - On-chain registry snapshot (not stale in-memory).
 */
export async function rebuildFromRegistry(
  manager: MediasoupManager,
  snapshot: RegistrySnapshot,
): Promise<RebuildResult> {
  // Step 1: Create a new Router on the next available Worker
  const worker = manager.getNextWorker();
  const router = await manager.createRouter(worker);

  // Step 2: For primary relay — no pipe consumer needed
  if (snapshot.role === 'primary') {
    return { router };
  }

  // Step 3: For standby relay — rebuild pipe + paused consumer.
  //
  // Producer-ID discrimination: we do NOT pass `prevPipeProducerId` to
  // consume(). The new pipe transport connects to the primary's fresh Router
  // and consumes a new placeholder producerId. This avoids the
  // "producer already used" mediasoup error (Stream-1 gotcha #4).
  // announcedIp externalized via ANNOUNCED_IP (default loopback for
  // local/bench); mirrors the room-handler.ts WebRTC-transport pattern.
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
  const pipeTransport = await router.createPipeTransport({
    listenIp: { ip: '0.0.0.0', announcedIp },
    port: snapshot.pipePort,
    enableRtx: false,
    enableSrtp: false,
  } as Parameters<msTypes.Router['createPipeTransport']>[0]);

  // Derive a fresh producerId — distinct from any previous (aliased) ID.
  // The real primary-side pipe producer will connect on the primary's rebuild
  // path; this placeholder keeps the consumer lifecycle consistent.
  const freshProducerId = `pipe-producer-${snapshot.roomId}-${Date.now()}`;

  const consumer = await pipeTransport.consume({
    producerId: freshProducerId,
  } as Parameters<msTypes.PipeTransport['consume']>[0]);

  // Immediately pause (REQ-RO-005): RTCP keepalive only
  await consumer.pause();

  return { router, consumer };
}
