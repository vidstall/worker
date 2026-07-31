/**
 * Tests for RoomExpirySweep — auto-closes rooms stuck PENDING (never assigned
 * a relay/CP) past 15 minutes, or READY/ACTIVE (assigned but never manually
 * closed) past 1 hour. Mirrors room-health-sweep.test.ts's structure — all
 * chain reads go through the RoomExpiryChainReader seam so the decision logic
 * runs fully offline.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import {
  RoomExpirySweep,
  recordRoomLifecycleTimestamp,
  ROOM_STATUS_PENDING,
  ROOM_STATUS_READY,
  ROOM_STATUS_ACTIVE,
  DEFAULT_PENDING_EXPIRY_MS,
  DEFAULT_READY_EXPIRY_MS,
  type RoomExpiryChainReader,
  type RoomStatusInfo,
  type RoomLifecycleTimestamps,
  type CloseExpiredRoomSubmitter,
} from '../room-expiry-sweep.js';

// ── Logger stub ──────────────────────────────────────────────────────────────

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

// ── FakeRoomExpiryChainReader ────────────────────────────────────────────────

interface FakeState {
  rooms: Record<string, RoomStatusInfo>;
  createdAtMs: Record<string, number>;
  readyAtMs: Record<string, number>;
}

class FakeRoomExpiryChainReader implements RoomExpiryChainReader {
  constructor(public state: FakeState) {}

  async getActiveRoomIds(): Promise<string[]> {
    return Object.keys(this.state.rooms);
  }

  async getRoomStatusInfo(roomId: string): Promise<RoomStatusInfo> {
    return this.state.rooms[roomId] ?? { status: ROOM_STATUS_PENDING, createdAtEpoch: 0n };
  }

  getRoomCreatedAtMs(roomId: string): number | undefined {
    return this.state.createdAtMs[roomId];
  }

  getRoomReadyAtMs(roomId: string): number | undefined {
    return this.state.readyAtMs[roomId];
  }
}

function makeReader(over: Partial<FakeState> = {}): FakeRoomExpiryChainReader {
  return new FakeRoomExpiryChainReader({
    rooms: {},
    createdAtMs: {},
    readyAtMs: {},
    ...over,
  });
}

function makeSubmitter() {
  return vi.fn().mockResolvedValue(undefined) as CloseExpiredRoomSubmitter;
}

const ROOM = '0xroom1';
const NOW = 1_000_000_000; // arbitrary fixed wall-clock ms for deterministic tests

describe('RoomExpirySweep — PENDING rooms', () => {
  it('past the 15min default → close_expired_room submitted with status=PENDING', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_PENDING, createdAtEpoch: 0n } },
      createdAtMs: { [ROOM]: NOW - DEFAULT_PENDING_EXPIRY_MS - 1 },
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await sweep.scanOnce(NOW);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(ROOM, ROOM_STATUS_PENDING, expect.any(String));
  });

  it('under the 15min default → no action', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_PENDING, createdAtEpoch: 0n } },
      createdAtMs: { [ROOM]: NOW - 1000 },
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await sweep.scanOnce(NOW);

    expect(submit).not.toHaveBeenCalled();
  });

  it('no createdAtMs observed yet → skipped, not crashed', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_PENDING, createdAtEpoch: 0n } },
      // createdAtMs deliberately absent
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await expect(sweep.scanOnce(NOW)).resolves.toEqual([]);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('RoomExpirySweep — READY/ACTIVE rooms', () => {
  it('READY past the 1hr default → close_expired_room submitted with status=READY', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_READY, createdAtEpoch: 0n } },
      readyAtMs: { [ROOM]: NOW - DEFAULT_READY_EXPIRY_MS - 1 },
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await sweep.scanOnce(NOW);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(ROOM, ROOM_STATUS_READY, expect.any(String));
  });

  it('ACTIVE past the 1hr default → treated the same as READY (future-proofing)', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_ACTIVE, createdAtEpoch: 0n } },
      readyAtMs: { [ROOM]: NOW - DEFAULT_READY_EXPIRY_MS - 1 },
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await sweep.scanOnce(NOW);

    expect(submit).toHaveBeenCalledWith(ROOM, ROOM_STATUS_ACTIVE, expect.any(String));
  });

  it('under the 1hr default → no action', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_READY, createdAtEpoch: 0n } },
      readyAtMs: { [ROOM]: NOW - 1000 },
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await sweep.scanOnce(NOW);

    expect(submit).not.toHaveBeenCalled();
  });
});

describe('RoomExpirySweep — de-dup', () => {
  it('a second scanOnce() does not resubmit for an already-acted-on room', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { status: ROOM_STATUS_PENDING, createdAtEpoch: 0n } },
      createdAtMs: { [ROOM]: NOW - DEFAULT_PENDING_EXPIRY_MS - 1 },
    });
    const submit = makeSubmitter();
    const sweep = new RoomExpirySweep(reader, submit, mockLogger());

    await sweep.scanOnce(NOW);
    await sweep.scanOnce(NOW);

    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('recordRoomLifecycleTimestamp', () => {
  const extractEventName = (eventType: string): string => eventType.split('::').pop() ?? eventType;

  function fakeEvent(eventName: string, roomId: string | undefined, timestampMs: string | null): SuiEvent {
    return {
      type: `0xpkg::room_manager_events::${eventName}`,
      parsedJson: roomId === undefined ? {} : { room_id: roomId },
      timestampMs,
    } as unknown as SuiEvent;
  }

  it('RoomCreated sets createdAtMs', () => {
    const map = new Map<string, RoomLifecycleTimestamps>();
    recordRoomLifecycleTimestamp(fakeEvent('RoomCreated', ROOM, '12345'), map, extractEventName);
    expect(map.get(ROOM)).toEqual({ createdAtMs: 12345 });
  });

  it('RoomAssigned sets readyAtMs', () => {
    const map = new Map<string, RoomLifecycleTimestamps>();
    recordRoomLifecycleTimestamp(fakeEvent('RoomAssigned', ROOM, '67890'), map, extractEventName);
    expect(map.get(ROOM)).toEqual({ readyAtMs: 67890 });
  });

  it('unrelated event types are a no-op', () => {
    const map = new Map<string, RoomLifecycleTimestamps>();
    recordRoomLifecycleTimestamp(fakeEvent('RelayRegistered', ROOM, '11111'), map, extractEventName);
    expect(map.size).toBe(0);
  });

  it('missing room_id is a no-op', () => {
    const map = new Map<string, RoomLifecycleTimestamps>();
    recordRoomLifecycleTimestamp(fakeEvent('RoomCreated', undefined, '12345'), map, extractEventName);
    expect(map.size).toBe(0);
  });

  it('missing timestampMs is a no-op', () => {
    const map = new Map<string, RoomLifecycleTimestamps>();
    recordRoomLifecycleTimestamp(fakeEvent('RoomCreated', ROOM, null), map, extractEventName);
    expect(map.size).toBe(0);
  });
});
