/**
 * TDD tests for RelayHeartbeatWatcher (REQ-RO-009) — standby-staleness
 * detection (relay_replacement.move vote-in) + the event-handler
 * RelayPromoted observer arm (CONTRACTS.md C8).
 *
 * Mirrors revote-watcher.test.ts structure — all chain reads go through the
 * RelayChainStateReader seam so the decision logic runs fully offline.
 *
 * Test contracts (from CONTRACTS.md C3):
 *   RED test 5: event-handler RelayPromoted arm → observer.onRelayPromoted
 *               called with correct shape.
 *   RED test 6: event-handler RelayPromoted arm with no observer → no throw,
 *               debug log emitted (CONTRACTS C8).
 */

import { describe, it, expect, vi } from 'vitest';
import { RelayHeartbeatWatcher, type RelayChainStateReader, type PromoteSubmitter } from '../relay-heartbeat-watcher.js';
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

// ── Tests: standby-staleness -> propose_relay_replacement (relay_replacement.move) ──

describe('RelayHeartbeatWatcher — standby-staleness detection (relay_replacement.move vote-in)', () => {
  function makeReplacementSubmitter() {
    return vi.fn().mockResolvedValue(undefined);
  }
  function makeCandidateSelector(candidateId: string | null) {
    return vi.fn().mockResolvedValue(candidateId);
  }

  it('a stale standby (primary fresh) triggers propose_relay_replacement, not promote_relay', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 99n /*fresh primary*/, '0xB': 90n /*stale standby*/, '0xC': 99n /*fresh standby*/ },
    }]});
    const logger = mockLogger();
    const promoteSubmitter = makeSubmitter();
    const replacementSubmitter = makeReplacementSubmitter();
    const candidateSelector = makeCandidateSelector('0xNEW');
    const watcher = new RelayHeartbeatWatcher(
      reader, promoteSubmitter, logger, { maxHeartbeatEpochs: 3n }, replacementSubmitter, candidateSelector,
    );
    await watcher.scanOnce();

    expect(replacementSubmitter).toHaveBeenCalledTimes(1);
    expect(replacementSubmitter).toHaveBeenCalledWith('0xroom1', '0xB', '0xNEW', expect.any(String));
    expect(promoteSubmitter).not.toHaveBeenCalled(); // primary is fresh — no promotion
  });

  it('never targets index 0 (primary) even if it happens to be stale — that stays promote_relay-only', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n /*stale primary*/, '0xB': 99n, '0xC': 99n },
    }]});
    const logger = mockLogger();
    const replacementSubmitter = makeReplacementSubmitter();
    const candidateSelector = makeCandidateSelector('0xNEW');
    const watcher = new RelayHeartbeatWatcher(
      reader, makeSubmitter(), logger, { maxHeartbeatEpochs: 3n }, replacementSubmitter, candidateSelector,
    );
    await watcher.scanOnce();

    expect(replacementSubmitter).not.toHaveBeenCalled(); // only the primary is stale, not a standby
  });

  it('is a no-op (skipped, logged) when the candidate selector finds nothing', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB'],
      heartbeats: { '0xA': 99n, '0xB': 90n },
    }]});
    const logger = mockLogger();
    const replacementSubmitter = makeReplacementSubmitter();
    const candidateSelector = makeCandidateSelector(null);
    const watcher = new RelayHeartbeatWatcher(
      reader, makeSubmitter(), logger, { maxHeartbeatEpochs: 3n }, replacementSubmitter, candidateSelector,
    );
    await watcher.scanOnce();

    expect(replacementSubmitter).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ context: expect.objectContaining({ roomId: '0xroom1', deadRelayId: '0xB' }) }),
      expect.stringContaining('no replacement candidate available'),
    );
  });

  it('de-dup: a 2nd scanOnce for the SAME (room, deadRelay) does not re-submit', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB'],
      heartbeats: { '0xA': 99n, '0xB': 90n },
    }]});
    const logger = mockLogger();
    const replacementSubmitter = makeReplacementSubmitter();
    const candidateSelector = makeCandidateSelector('0xNEW');
    const watcher = new RelayHeartbeatWatcher(
      reader, makeSubmitter(), logger, { maxHeartbeatEpochs: 3n }, replacementSubmitter, candidateSelector,
    );
    await watcher.scanOnce();
    await watcher.scanOnce();

    expect(replacementSubmitter).toHaveBeenCalledTimes(1);
  });

  it('is inactive (never called) when the watcher is constructed WITHOUT a replacementSubmitter/candidateSelector — back-compat', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB'],
      heartbeats: { '0xA': 99n, '0xB': 90n },
    }]});
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(reader, makeSubmitter(), logger, { maxHeartbeatEpochs: 3n });
    // No throw, no crash, scanOnce completes fine without the optional deps.
    await expect(watcher.scanOnce()).resolves.toEqual([]);
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
    const pendingRooms = new Map();

    handleEvent(
      makeRelayPromotedEvent(),
      relayState,
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
    const pendingRooms = new Map();

    expect(() =>
      handleEvent(
        makeRelayPromotedEvent(),
        relayState,
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
