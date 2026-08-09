/**
 * Unit tests for relay-promotion.ts (REQ-RO-006).
 *
 * Runs the REAL createPromotionHandlers factory against mocked deps — mirrors
 * reverse-announce-handler.test.ts's approach, and is exactly the coverage
 * flagged as missing when relay-heartbeat.ts / the RelayPromoted resume gap
 * were wired into index.ts (index.ts itself has no exports and is never
 * unit-tested directly in this codebase).
 *
 * Covers:
 *   1. promoteToPrimary resumes a paused consumer + flips both role fields +
 *      clears standbyPrewarmRooms/standbyHeartbeats for the room.
 *   2. promoteToPrimary is idempotent: calling it twice for the same room
 *      resumes the consumer exactly once (pins the contract the on-chain
 *      RelayPromoted handler depends on when the fast local path already fired).
 *   3. startStandbyHeartbeat: after missThreshold failed /healthz pings,
 *      promoteToPrimary fires through the SAME real relay-heartbeat.ts module.
 *   4. stopStandbyHeartbeat: stops + removes the controller; safe no-op
 *      when no entry exists for the room.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { types as msTypes } from 'mediasoup';
import { createPromotionHandlers, type PromotionDeps } from '../relay-promotion.js';
import { setTestPingFn, type RelayHeartbeatController } from '../relay-heartbeat.js';

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

/** Stateful fake Consumer — resume() flips `paused` to false, mirroring
 *  mediasoup's real Consumer, so idempotency is asserted against real state
 *  transitions rather than just a call count. */
function fakePausedConsumer(): msTypes.Consumer & { resume: ReturnType<typeof vi.fn> } {
  const state = { closed: false, paused: true };
  return {
    get closed() { return state.closed; },
    get paused() { return state.paused; },
    resume: vi.fn().mockImplementation(async () => {
      state.paused = false;
    }),
  } as unknown as msTypes.Consumer & { resume: ReturnType<typeof vi.fn> };
}

function makeDeps(consumer: msTypes.Consumer | null): PromotionDeps & {
  interRelayContext: { role: 'primary' | 'standby' };
  probeLiveness: { role: 'primary' | 'standby' | 'unknown' };
} {
  return {
    standbyWarmPipe: { currentPipeConsumer: vi.fn().mockReturnValue(consumer) },
    interRelayContext: { role: 'standby' },
    probeLiveness: { role: 'standby' },
    standbyPrewarmRooms: new Map(),
    standbyHeartbeats: new Map<string, RelayHeartbeatController>(),
    logger: mockLogger(),
  };
}

describe('createPromotionHandlers — promoteToPrimary (REQ-RO-006)', () => {
  it('resumes a paused consumer and flips both role fields', async () => {
    const consumer = fakePausedConsumer();
    const deps = makeDeps(consumer);
    deps.standbyPrewarmRooms.set('room-1', 'sfu');
    const { promoteToPrimary } = createPromotionHandlers(deps);

    promoteToPrimary('room-1');
    await vi.waitFor(() => expect(consumer.resume).toHaveBeenCalledOnce());

    expect(deps.interRelayContext.role).toBe('primary');
    expect(deps.probeLiveness.role).toBe('primary');
    expect(deps.standbyPrewarmRooms.has('room-1')).toBe(false);
  });

  it('does not call resume() when there is no pipe consumer for the room', () => {
    const deps = makeDeps(null);
    const { promoteToPrimary } = createPromotionHandlers(deps);

    expect(() => promoteToPrimary('room-2')).not.toThrow();
    expect(deps.interRelayContext.role).toBe('primary');
  });

  it('does not call resume() on an already-closed consumer', () => {
    const consumer = { closed: true, paused: true, resume: vi.fn() } as unknown as msTypes.Consumer & {
      resume: ReturnType<typeof vi.fn>;
    };
    const deps = makeDeps(consumer);
    const { promoteToPrimary } = createPromotionHandlers(deps);

    promoteToPrimary('room-3');
    expect(consumer.resume).not.toHaveBeenCalled();
    expect(deps.interRelayContext.role).toBe('primary'); // role still flips
  });

  it('is idempotent: a second call for the same room resumes the consumer exactly once', async () => {
    const consumer = fakePausedConsumer();
    const deps = makeDeps(consumer);
    const { promoteToPrimary } = createPromotionHandlers(deps);

    // First call (e.g. the fast local ping-based path).
    promoteToPrimary('room-4');
    await vi.waitFor(() => expect(consumer.resume).toHaveBeenCalledOnce());

    // Second call for the SAME room (e.g. the on-chain RelayPromoted event,
    // confirming moments later) — consumer.paused is now false, so resume()
    // must NOT be invoked again.
    promoteToPrimary('room-4');

    expect(consumer.resume).toHaveBeenCalledOnce();
  });

  it('stops and removes this room\'s heartbeat controller', () => {
    const deps = makeDeps(null);
    const controller: RelayHeartbeatController = { start: vi.fn(), stop: vi.fn() };
    deps.standbyHeartbeats.set('room-5', controller);
    const { promoteToPrimary } = createPromotionHandlers(deps);

    promoteToPrimary('room-5');

    expect(controller.stop).toHaveBeenCalledOnce();
    expect(deps.standbyHeartbeats.has('room-5')).toBe(false);
  });
});

describe('createPromotionHandlers — startStandbyHeartbeat / stopStandbyHeartbeat (REQ-RO-006)', () => {
  const INTERVAL_MS = 1000;
  const MISS_THRESHOLD = 3;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    setTestPingFn(null);
    vi.useRealTimers();
  });

  it('fires promoteToPrimary after missThreshold consecutive failed pings', async () => {
    setTestPingFn(async () => false); // every ping fails
    const consumer = fakePausedConsumer();
    const deps = makeDeps(consumer);
    const { startStandbyHeartbeat } = createPromotionHandlers(deps);

    startStandbyHeartbeat('room-6', 'wss://primary.example.com:4000');
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * MISS_THRESHOLD + 100);

    expect(consumer.resume).toHaveBeenCalledOnce();
    expect(deps.interRelayContext.role).toBe('primary');
    // promoteToPrimary itself stops/removes the room's own heartbeat entry.
    expect(deps.standbyHeartbeats.has('room-6')).toBe(false);
  });

  it('does not start a ping loop when primaryUrl is null (endpoint not yet resolvable)', async () => {
    setTestPingFn(async () => false);
    const deps = makeDeps(null);
    const { startStandbyHeartbeat } = createPromotionHandlers(deps);

    startStandbyHeartbeat('room-7', null);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 10);

    expect(deps.standbyHeartbeats.has('room-7')).toBe(false);
    expect(deps.interRelayContext.role).toBe('standby'); // never promoted
  });

  it('restarts fresh on a re-pairing — stops the prior controller for the room', () => {
    const deps = makeDeps(null);
    const priorController: RelayHeartbeatController = { start: vi.fn(), stop: vi.fn() };
    deps.standbyHeartbeats.set('room-8', priorController);
    const { startStandbyHeartbeat } = createPromotionHandlers(deps);

    startStandbyHeartbeat('room-8', 'wss://new-primary.example.com:4000');

    expect(priorController.stop).toHaveBeenCalledOnce();
    // A fresh controller now owns the room's map entry (not the stale one).
    expect(deps.standbyHeartbeats.get('room-8')).not.toBe(priorController);
  });
});

describe('createPromotionHandlers — stopStandbyHeartbeat (REQ-RO-006)', () => {
  it('stops and removes an existing controller', () => {
    const deps = makeDeps(null);
    const controller: RelayHeartbeatController = { start: vi.fn(), stop: vi.fn() };
    deps.standbyHeartbeats.set('room-9', controller);
    const { stopStandbyHeartbeat } = createPromotionHandlers(deps);

    stopStandbyHeartbeat('room-9');

    expect(controller.stop).toHaveBeenCalledOnce();
    expect(deps.standbyHeartbeats.has('room-9')).toBe(false);
  });

  it('is a safe no-op when no controller exists for the room', () => {
    const deps = makeDeps(null);
    const { stopStandbyHeartbeat } = createPromotionHandlers(deps);

    expect(() => stopStandbyHeartbeat('room-nonexistent')).not.toThrow();
  });
});
