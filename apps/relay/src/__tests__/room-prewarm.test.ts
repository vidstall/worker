/**
 * Pre-warm standby — `ensureRoomPrewarmed` idempotency.
 *
 * Verifies the actual thesis claim: a standby relay's Router is created
 * exactly once even when a proactive pre-warm call races a real peer's
 * `handleJoin` (either order), and that a repeated re-warm sweep call is a
 * safe no-op once the room already exists.
 */

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { ensureRoomPrewarmed } from '../room-prewarm.js';
import { createSignalingServerState } from '../signaling/state.js';
import type { SignalingConfig, InterRelayContext } from '../signaling/state.js';
import type { MediasoupManager } from '../mediasoup-manager.js';

const logger = pino({ level: 'silent' });

function mockRouter() {
  return {
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    createAudioLevelObserver: vi.fn().mockResolvedValue({
      on: vi.fn(),
      addProducer: vi.fn().mockResolvedValue(undefined),
      removeProducer: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn(),
  };
}

function makeConfig(): SignalingConfig {
  return {
    relayMode: 'sfu',
    audioObserverIntervalMs: 800,
    audioObserverThresholdDb: -60,
    audioLastNK: 0,
    maxIncomingBitrate: 0,
    passwordMaxAttempts: 10,
    passwordWindowMs: 60000,
    interRelayToken: '',
  };
}

describe('ensureRoomPrewarmed', () => {
  it('creates exactly one Router even when two pre-warm calls race for the same roomId', async () => {
    const createRouter = vi.fn().mockResolvedValue(mockRouter());
    const manager = {
      getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
      createRouter,
    } as unknown as MediasoupManager;
    const state = createSignalingServerState();
    const config = makeConfig();

    const [roomA, roomB] = await Promise.all([
      ensureRoomPrewarmed(state, manager, 'room-1', 'sfu', config, undefined, logger),
      ensureRoomPrewarmed(state, manager, 'room-1', 'sfu', config, undefined, logger),
    ]);

    expect(createRouter).toHaveBeenCalledTimes(1);
    expect(roomA).toBe(roomB); // same RoomState instance
    expect(state.rooms.get('room-1')).toBe(roomA);
  });

  it('is a no-op once the room already exists (self-heal re-warm sweep)', async () => {
    const createRouter = vi.fn().mockResolvedValue(mockRouter());
    const manager = {
      getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
      createRouter,
    } as unknown as MediasoupManager;
    const state = createSignalingServerState();
    const config = makeConfig();

    const first = await ensureRoomPrewarmed(state, manager, 'room-2', 'sfu', config, undefined, logger);
    const second = await ensureRoomPrewarmed(state, manager, 'room-2', 'sfu', config, undefined, logger);

    expect(createRouter).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('opens the standby warm pipe (onStandbyRoomReady) when role is standby', async () => {
    const router = mockRouter();
    const manager = {
      getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
      createRouter: vi.fn().mockResolvedValue(router),
    } as unknown as MediasoupManager;
    const state = createSignalingServerState();
    const config = makeConfig();
    const onStandbyRoomReady = vi.fn();
    const interRelay = {
      role: 'standby',
      registry: { listForRoom: vi.fn().mockReturnValue([]) },
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    } as unknown as InterRelayContext;

    await ensureRoomPrewarmed(state, manager, 'room-3', 'sfu', config, interRelay, logger);

    expect(onStandbyRoomReady).toHaveBeenCalledWith('room-3', router);
  });

  it('does NOT open the standby warm pipe when role is primary', async () => {
    const manager = {
      getNextWorker: vi.fn().mockReturnValue({ pid: 1 }),
      createRouter: vi.fn().mockResolvedValue(mockRouter()),
    } as unknown as MediasoupManager;
    const state = createSignalingServerState();
    const config = makeConfig();
    const onStandbyRoomReady = vi.fn();
    const interRelay = {
      role: 'primary',
      registry: { listForRoom: vi.fn().mockReturnValue([]) },
      announceProducer: vi.fn(),
      onStandbyRoomReady,
    } as unknown as InterRelayContext;

    await ensureRoomPrewarmed(state, manager, 'room-4', 'sfu', config, interRelay, logger);

    expect(onStandbyRoomReady).not.toHaveBeenCalled();
  });
});
