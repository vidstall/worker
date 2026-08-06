/**
 * Pre-warm standby — idempotent room/router creation, factored out of
 * `signaling/join-handler.ts::handleJoin`'s inline get-or-create block so a
 * standby relay can pre-create a room's mediasoup Router (and open the warm
 * pipe) BEFORE any real peer ever joins, instead of only on first `join`.
 *
 * Two entry points share `createRoomCore` (the actual Router/MCU/standby-wiring
 * work, no locking):
 *   - `ensureRoomPrewarmed` — acquires `state.roomCreationLocks` itself. Used by
 *     `index.ts`'s `RoomAssigned` event poller (`role === 'standby'` branch) to
 *     pre-warm ahead of any real usage, and by the periodic standby re-warm
 *     sweep (idempotent no-op once already warm).
 *   - `signaling/join-handler.ts::handleJoin` — already holds
 *     `state.roomCreationLocks` for its whole admission critical section (the
 *     password-gate race, CI-18/REQ-MCS-012), so it calls `createRoomCore`
 *     directly rather than through `ensureRoomPrewarmed` (which would try to
 *     re-acquire the same lock the caller already holds and self-deadlock).
 *
 * Either creation path can run first; the `roomCreationLocks` + `state.rooms`
 * get-or-create check makes both idempotent regardless of order.
 */

import type { Logger } from '@dvconf/shared';
import type { MediasoupManager } from './mediasoup-manager.js';
import type { RoomState } from './room-handler.js';
import { McuPipeline } from './mcu-pipeline.js';
import type { SignalingServerState, SignalingConfig, InterRelayContext } from './signaling/state.js';
import { attachAudioLevelObserver } from './signaling/media-handler.js';

/**
 * Create a room's mediasoup Router, MCU pipeline (if applicable), audio-level
 * observer, and wire the standby warm-pipe callback. NO locking — the caller
 * is responsible for holding `state.roomCreationLocks` (see file header) and
 * for having already confirmed `state.rooms.get(roomId)` is absent.
 */
async function createRoomCore(
  state: SignalingServerState,
  manager: MediasoupManager,
  roomId: string,
  roomMode: 'sfu' | 'mcu',
  config: SignalingConfig,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
  logAction: 'created' | 'pre-warmed',
): Promise<RoomState> {
  const worker = manager.getNextWorker();
  const router = await manager.createRouter(worker);
  const room: RoomState = {
    roomId,
    router,
    mode: roomMode,
    peers: new Map(),
  };

  if (roomMode === 'mcu') {
    const roomE2ee = state.roomConfigs.get(roomId)?.e2ee ?? false;
    room.mcuPipeline = new McuPipeline(router, logger, roomE2ee);
    logger.info({ roomId, e2ee: roomE2ee }, 'MCU pipeline initialized for room');
  }

  state.rooms.set(roomId, room);
  logger.info(
    { roomId, mode: roomMode },
    logAction === 'pre-warmed' ? 'Room pre-warmed (Router created ahead of first peer join)' : 'Room created',
  );

  // W5 M1 P5 (REQ-MCS-003): one AudioLevelObserver per router. Best-effort —
  // a creation failure must not break room setup.
  await attachAudioLevelObserver(room, config, logger);

  // G3.2b: hand the room's router to the wiring layer so it builds the
  // RoomTopology + opens the paused warm pipe (StandbyWarmPipeCoordinator
  // .ensure) for a relay that is STANDBY for this room. Previously fired only
  // on the first real peer join; now also fires on proactive pre-warm, so the
  // warm pipe is open well before any failover.
  if (interRelay?.role === 'standby') {
    interRelay.onStandbyRoomReady?.(roomId, room.router);
  }

  return room;
}

/**
 * Get-or-create a room's mediasoup Router, idempotently. Acquires
 * `state.roomCreationLocks` itself — do NOT call this from a caller that
 * already holds that lock for `roomId` (use `createRoomCoreLocked` via
 * `handleJoin`'s own lock scope instead; see file header).
 */
export async function ensureRoomPrewarmed(
  state: SignalingServerState,
  manager: MediasoupManager,
  roomId: string,
  roomMode: 'sfu' | 'mcu',
  config: SignalingConfig,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
): Promise<RoomState> {
  const pending = state.roomCreationLocks.get(roomId);
  if (pending) await pending;

  const already = state.rooms.get(roomId);
  if (already) return already;

  let release!: () => void;
  const creation = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.roomCreationLocks.set(roomId, creation);

  try {
    // Re-check inside the lock — another caller may have created it while we awaited above.
    const existing = state.rooms.get(roomId);
    if (existing) return existing;

    return await createRoomCore(state, manager, roomId, roomMode, config, interRelay, logger, 'pre-warmed');
  } finally {
    release();
    state.roomCreationLocks.delete(roomId);
  }
}

/**
 * Lock-free variant for callers (`handleJoin`) that already hold
 * `state.roomCreationLocks` for `roomId` around a wider critical section and
 * have already confirmed `state.rooms.get(roomId)` is absent.
 */
export async function createRoomCoreLocked(
  state: SignalingServerState,
  manager: MediasoupManager,
  roomId: string,
  roomMode: 'sfu' | 'mcu',
  config: SignalingConfig,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
): Promise<RoomState> {
  return createRoomCore(state, manager, roomId, roomMode, config, interRelay, logger, 'created');
}
