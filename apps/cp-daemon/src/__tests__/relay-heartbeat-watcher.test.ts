/**
 * TDD tests for RelayHeartbeatWatcher (REQ-RO-009).
 *
 * Mirrors revote-watcher.test.ts structure — all chain reads go through the
 * RelayChainStateReader seam so the decision logic runs fully offline.
 *
 * Test contracts (from CONTRACTS.md C3):
 *   RED test 1: stale heartbeat (epoch - last_heartbeat > maxHeartbeatEpochs)
 *               → submitter called exactly once with correct args.
 *   RED test 2: fresh heartbeat → submitter NOT called.
 *   RED test 3: both primary AND standby stale → submitter NOT called
 *               (no valid new primary; log warning).
 *   RED test 4: scanOnce() called twice without state reset → de-dup guard:
 *               submitter called only once per promotion event.
 *   RED test 5: event-handler RelayPromoted arm → observer.onRelayPromoted
 *               called with correct shape.
 *   RED test 6: event-handler RelayPromoted arm with no observer → no throw,
 *               debug log emitted (CONTRACTS C8).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  RelayHeartbeatWatcher,
  startRelayHeartbeatWatcher,
  type RelayChainStateReader,
  type PromoteSubmitter,
} from '../relay-heartbeat-watcher.js';
import { handleEvent } from '../event-handler.js';
import type { SuiEvent } from '@mysten/sui/client';

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

// ── FakeRelayChainStateReader ────────────────────────────────────────────────

interface FakeState {
  epoch: bigint;
  rooms: Array<{
    roomId: string;
    assignedRelays: string[];                       // [0]=primary, [1]=standby
    heartbeats: Record<string, bigint>;            // relayId → lastHeartbeat epoch
  }>;
}

class FakeRelayChainStateReader implements RelayChainStateReader {
  constructor(public state: FakeState) {}

  async getCurrentEpoch(): Promise<bigint> {
    return this.state.epoch;
  }

  async getRelayLastHeartbeats(
    roomId: string,
  ): Promise<Array<{ relayId: string; lastHeartbeat: bigint }>> {
    const room = this.state.rooms.find((r) => r.roomId === roomId);
    if (!room) return [];
    return room.assignedRelays.map((relayId) => ({
      relayId,
      lastHeartbeat: room.heartbeats[relayId] ?? 0n,
    }));
  }

  async getAssignedRelays(roomId: string): Promise<string[]> {
    return this.state.rooms.find((r) => r.roomId === roomId)?.assignedRelays ?? [];
  }

  async getActiveRoomIds(): Promise<string[]> {
    return this.state.rooms.map((r) => r.roomId);
  }
}

// ── Helper factories ─────────────────────────────────────────────────────────

function makeReader(over: Partial<FakeState> = {}): FakeRelayChainStateReader {
  return new FakeRelayChainStateReader({
    epoch: 100n,
    rooms: [],
    ...over,
  });
}

function makeSubmitter(): PromoteSubmitter {
  return vi.fn().mockResolvedValue(undefined);
}

// ── Tests: stale vs fresh heartbeat detection ────────────────────────────────

describe('RelayHeartbeatWatcher — stale heartbeat detection (REQ-RO-009)', () => {
  it('RED test 1: stale primary (epoch gap > maxHeartbeatEpochs) → submitter called once with correct args', async () => {
    // epoch=100, primary lastHeartbeat=95, gap=5 > maxHeartbeatEpochs(3) → stale
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom1',
          assignedRelays: ['0xprimary', '0xstandby'],
          heartbeats: { '0xprimary': 95n, '0xstandby': 99n }, // standby fresh (gap=1)
        },
      ],
    });
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), {
      maxHeartbeatEpochs: 3n,
    });

    const promotions = await watcher.scanOnce();

    expect(promotions).toHaveLength(1);
    expect(promotions[0]).toMatchObject({
      roomId: '0xroom1',
      oldPrimary: '0xprimary',
      newPrimary: '0xstandby',
    });
    expect(submitter).toHaveBeenCalledOnce();
    expect(submitter).toHaveBeenCalledWith(
      '0xroom1',
      '0xprimary',
      '0xstandby',
      expect.any(String), // traceId
    );
  });

  it('RED test 2: fresh primary heartbeat → submitter NOT called', async () => {
    // epoch=100, primary lastHeartbeat=98, gap=2 <= maxHeartbeatEpochs(3) → fresh
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom2',
          assignedRelays: ['0xprimary', '0xstandby'],
          heartbeats: { '0xprimary': 98n, '0xstandby': 99n },
        },
      ],
    });
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), {
      maxHeartbeatEpochs: 3n,
    });

    const promotions = await watcher.scanOnce();

    expect(promotions).toHaveLength(0);
    expect(submitter).not.toHaveBeenCalled();
  });

  it('RED test 3: both primary AND standby stale → submitter NOT called (no valid new primary)', async () => {
    // both stale: primary gap=6, standby gap=7 → neither can be promoted
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom3',
          assignedRelays: ['0xprimary', '0xstandby'],
          heartbeats: { '0xprimary': 94n, '0xstandby': 93n },
        },
      ],
    });
    const submitter = makeSubmitter();
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, logger, {
      maxHeartbeatEpochs: 3n,
    });

    const promotions = await watcher.scanOnce();

    expect(promotions).toHaveLength(0);
    expect(submitter).not.toHaveBeenCalled();
    // A warn log MUST be emitted for the both-dead case
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'relay-heartbeat-watcher' }),
      expect.stringContaining('both'),
    );
  });

  it('RED test 4: de-dup guard — scanOnce() called twice → submitter called only once', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom4',
          assignedRelays: ['0xprimary', '0xstandby'],
          heartbeats: { '0xprimary': 95n, '0xstandby': 99n },
        },
      ],
    });
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), {
      maxHeartbeatEpochs: 3n,
    });

    await watcher.scanOnce();
    await watcher.scanOnce(); // second call — should be de-duped

    expect(submitter).toHaveBeenCalledOnce();
  });

  it('exact-boundary: gap === maxHeartbeatEpochs → NOT stale (strict > required)', async () => {
    // epoch=100, gap=3 === maxHeartbeatEpochs=3 → NOT stale (strict >)
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom5',
          assignedRelays: ['0xprimary', '0xstandby'],
          heartbeats: { '0xprimary': 97n, '0xstandby': 99n }, // gap=3 exactly
        },
      ],
    });
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), {
      maxHeartbeatEpochs: 3n,
    });

    const promotions = await watcher.scanOnce();

    expect(promotions).toHaveLength(0);
    expect(submitter).not.toHaveBeenCalled();
  });

  it('no assigned relays → no promotion (room with empty relay list)', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        { roomId: '0xroom6', assignedRelays: [], heartbeats: {} },
      ],
    });
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), {
      maxHeartbeatEpochs: 3n,
    });

    const promotions = await watcher.scanOnce();
    expect(promotions).toHaveLength(0);
    expect(submitter).not.toHaveBeenCalled();
  });

  it('default maxHeartbeatEpochs is 3n when options omitted', async () => {
    // gap=4 with default max=3 → stale
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroomD',
          assignedRelays: ['0xp', '0xs'],
          heartbeats: { '0xp': 96n, '0xs': 99n }, // gap=4
        },
      ],
    });
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger());

    const promotions = await watcher.scanOnce();
    expect(promotions).toHaveLength(1);
    expect(submitter).toHaveBeenCalledOnce();
  });
});

// ── Tests: structured logging ────────────────────────────────────────────────

describe('RelayHeartbeatWatcher — structured logging', () => {
  it('scanOnce emits info log with trace_id + module: relay-heartbeat-watcher', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom-log',
          assignedRelays: ['0xp', '0xs'],
          heartbeats: { '0xp': 95n, '0xs': 99n },
        },
      ],
    });
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(reader, makeSubmitter(), logger, {
      maxHeartbeatEpochs: 3n,
    });

    await watcher.scanOnce();

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: expect.any(String),
        module: 'relay-heartbeat-watcher',
      }),
      expect.any(String),
    );
  });

  it('promotion submit logs trace_id + action: promote_submit', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: [
        {
          roomId: '0xroom-submit',
          assignedRelays: ['0xp', '0xs'],
          heartbeats: { '0xp': 95n, '0xs': 99n },
        },
      ],
    });
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(reader, makeSubmitter(), logger, {
      maxHeartbeatEpochs: 3n,
    });

    await watcher.scanOnce();

    const calls = (logger.info as ReturnType<typeof vi.fn>).mock.calls;
    const submitCall = calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        (c[0] as Record<string, unknown>)['action'] === 'promote_submit',
    );
    expect(submitCall).toBeDefined();
  });
});

// ── Tests: startRelayHeartbeatWatcher factory ────────────────────────────────

describe('startRelayHeartbeatWatcher', () => {
  it('returns a watcher instance and stop function does not throw', () => {
    const reader = makeReader();
    const submitter = makeSubmitter();
    const watcher = startRelayHeartbeatWatcher(reader, submitter, mockLogger());
    expect(watcher).toBeInstanceOf(RelayHeartbeatWatcher);
    watcher.stop(); // must not throw
  });
});

// ── C2 / N4: pollIntervalMs is honored, not hardcoded ─────────────────────────

describe('RelayHeartbeatWatcher — pollIntervalMs honored (C2 / N4)', () => {
  it('a custom pollIntervalMs is stored and exposed (not hardcoded 30_000)', () => {
    const watcher = new RelayHeartbeatWatcher(makeReader(), makeSubmitter(), mockLogger(), {
      pollIntervalMs: 3000, // localnet epoch duration — well under the 30s hardcode
    });
    expect(watcher.getPollIntervalMs()).toBe(3000);
  });

  it('defaults to 30_000 when pollIntervalMs is omitted', () => {
    const watcher = new RelayHeartbeatWatcher(makeReader(), makeSubmitter(), mockLogger());
    expect(watcher.getPollIntervalMs()).toBe(30_000);
  });

  it('start() logs the custom interval (proves start() uses the stored value)', () => {
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(makeReader(), makeSubmitter(), logger, {
      pollIntervalMs: 2500,
    });
    watcher.start();
    watcher.stop();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        module: 'relay-heartbeat-watcher',
        context: expect.objectContaining({ intervalMs: 2500 }),
      }),
      expect.stringContaining('Starting'),
    );
  });

  it('startRelayHeartbeatWatcher passes pollIntervalMs through to the instance', () => {
    const watcher = startRelayHeartbeatWatcher(makeReader(), makeSubmitter(), mockLogger(), {
      pollIntervalMs: 1500,
    });
    expect(watcher.getPollIntervalMs()).toBe(1500);
    watcher.stop();
  });
});

// ── Tests: event-handler RelayPromoted arm (CONTRACTS C8) ────────────────────

describe('event-handler — RelayPromoted arm (REQ-RO-009 observer side)', () => {
  const makeRelayPromotedEvent = (overrides: Partial<{
    room_id: string;
    old_primary: string;
    new_primary: string;
    epoch: number;
  }> = {}): SuiEvent => ({
    type: '0xpkg::room_manager::RelayPromoted',
    parsedJson: {
      room_id: '0xroom',
      old_primary: '0xold',
      new_primary: '0xnew',
      epoch: 42,
      ...overrides,
    },
    id: { txDigest: '0xtx', eventSeq: '0' },
    packageId: '0xpkg',
    transactionModule: 'room_manager',
    sender: '0xsender',
    timestampMs: '0',
    bcs: '',
    bcsEncoding: 'base58' as const,
  });

  it('RED test 5: RelayPromoted event → observer.onRelayPromoted called with correct shape', () => {
    const observer = { onRelayPromoted: vi.fn().mockResolvedValue(undefined) };
    const logger = mockLogger();
    const relayState = new Map();
    const signalingState = new Map();
    const pendingRooms = new Map();

    handleEvent(
      makeRelayPromotedEvent(),
      relayState,
      signalingState,
      pendingRooms,
      logger,
      undefined,
      { relayPromotedObserver: observer } as any,
    );

    expect(observer.onRelayPromoted).toHaveBeenCalledWith(
      {
        type: 'RelayPromoted',
        room_id: '0xroom',
        old_primary: '0xold',
        new_primary: '0xnew',
        epoch: 42,
      },
      expect.any(String), // traceId
    );
  });

  it('RED test 6: RelayPromoted with no observer → no throw, debug log emitted', () => {
    const logger = mockLogger();
    const relayState = new Map();
    const signalingState = new Map();
    const pendingRooms = new Map();

    expect(() =>
      handleEvent(
        makeRelayPromotedEvent(),
        relayState,
        signalingState,
        pendingRooms,
        logger,
        undefined,
        {} as any, // no relayPromotedObserver
      ),
    ).not.toThrow();

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'event-handler' }),
      expect.stringContaining('no observer'),
    );
  });
});
