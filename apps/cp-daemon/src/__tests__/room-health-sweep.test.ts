/**
 * Tests for RoomHealthSweep — closes the room-state gap left by
 * validator-driven liveness ejection (execute_ejection never touches
 * RoomManager). (The standalone signaling node type's failover path was
 * removed along with the node type itself.)
 *
 * Mirrors relay-heartbeat-watcher.test.ts's structure — all chain reads go
 * through the RoomHealthChainReader seam so the decision logic runs fully
 * offline.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  RoomHealthSweep,
  type RoomHealthChainReader,
  type RoomAssignmentSnapshot,
  type RegistryNodeHeartbeat,
  type PromoteAfterEjectionSubmitter,
  type SpillRelaySubmitter,
} from '../room-health-sweep.js';

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

// ── FakeRoomHealthChainReader ────────────────────────────────────────────────

interface FakeState {
  epoch: bigint;
  rooms: Record<string, RoomAssignmentSnapshot>;
  relayPool: RegistryNodeHeartbeat[];
}

class FakeRoomHealthChainReader implements RoomHealthChainReader {
  constructor(public state: FakeState) {}

  async getCurrentEpoch(): Promise<bigint> {
    return this.state.epoch;
  }

  async getActiveRoomIds(): Promise<string[]> {
    return Object.keys(this.state.rooms);
  }

  async getRoomAssignment(roomId: string): Promise<RoomAssignmentSnapshot> {
    return this.state.rooms[roomId] ?? { relays: [] };
  }

  async getActiveRelayPool(): Promise<RegistryNodeHeartbeat[]> {
    return this.state.relayPool;
  }
}

function makeReader(over: Partial<FakeState> = {}): FakeRoomHealthChainReader {
  return new FakeRoomHealthChainReader({
    epoch: 100n,
    rooms: {},
    relayPool: [],
    ...over,
  });
}

function makeSubmitters() {
  return {
    promoteAfterEjection: vi.fn().mockResolvedValue(undefined) as PromoteAfterEjectionSubmitter,
    spillRelay: vi.fn().mockResolvedValue(undefined) as SpillRelaySubmitter,
  };
}

const ROOM = '0xroom1';
const PRIMARY = '0x0000000000000000000000000000000000000000000000000000000000000001';
const STANDBY = '0x0000000000000000000000000000000000000000000000000000000000000002';
const SPILL_CANDIDATE = '0x0000000000000000000000000000000000000000000000000000000000000003';

describe('RoomHealthSweep — relay: fully ejected primary', () => {
  it('with a live standby already assigned → promoteAfterEjection submitted', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { relays: [PRIMARY, STANDBY] } },
      // PRIMARY absent from the pool entirely → fully ejected.
      relayPool: [{ minerId: STANDBY, lastHeartbeat: 100n }],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    await sweep.scanOnce();

    expect(submitters.promoteAfterEjection).toHaveBeenCalledTimes(1);
    expect(submitters.promoteAfterEjection).toHaveBeenCalledWith(ROOM, PRIMARY, STANDBY, expect.any(String));
    expect(submitters.spillRelay).not.toHaveBeenCalled();
  });

  it('with NO live standby → authorize_spill_relay submitted with a fresh external candidate', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { relays: [PRIMARY] } }, // single relay, no standby
      relayPool: [{ minerId: SPILL_CANDIDATE, lastHeartbeat: 100n }],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    await sweep.scanOnce();

    expect(submitters.spillRelay).toHaveBeenCalledTimes(1);
    expect(submitters.spillRelay).toHaveBeenCalledWith(ROOM, SPILL_CANDIDATE, expect.any(String));
    expect(submitters.promoteAfterEjection).not.toHaveBeenCalled();
  });

  it('with a stale (but still registered) standby → treated as no live standby, spill fires', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: { [ROOM]: { relays: [PRIMARY, STANDBY] } },
      relayPool: [
        { minerId: STANDBY, lastHeartbeat: 0n }, // gap = 100 > 3 → stale
        { minerId: SPILL_CANDIDATE, lastHeartbeat: 100n },
      ],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    await sweep.scanOnce();

    expect(submitters.spillRelay).toHaveBeenCalledWith(ROOM, SPILL_CANDIDATE, expect.any(String));
    expect(submitters.promoteAfterEjection).not.toHaveBeenCalled();
  });
});

describe('RoomHealthSweep — relay: stale-but-registered primary defers to relay-heartbeat-watcher', () => {
  it('primary stale (not ejected) with a live standby → neither promoteAfterEjection nor spill fires', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: { [ROOM]: { relays: [PRIMARY, STANDBY] } },
      relayPool: [
        { minerId: PRIMARY, lastHeartbeat: 0n }, // still registered, just stale
        { minerId: STANDBY, lastHeartbeat: 100n }, // live
      ],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    await sweep.scanOnce();

    expect(submitters.promoteAfterEjection).not.toHaveBeenCalled();
    expect(submitters.spillRelay).not.toHaveBeenCalled();
  });

  it('primary fresh → nothing fires', async () => {
    const reader = makeReader({
      epoch: 100n,
      rooms: { [ROOM]: { relays: [PRIMARY, STANDBY] } },
      relayPool: [
        { minerId: PRIMARY, lastHeartbeat: 100n },
        { minerId: STANDBY, lastHeartbeat: 100n },
      ],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    await sweep.scanOnce();

    expect(submitters.promoteAfterEjection).not.toHaveBeenCalled();
    expect(submitters.spillRelay).not.toHaveBeenCalled();
  });
});

describe('RoomHealthSweep — de-dup guard', () => {
  it('scanOnce() called twice without state change → submitter called only once per key', async () => {
    const reader = makeReader({
      rooms: { [ROOM]: { relays: [PRIMARY, STANDBY] } },
      relayPool: [{ minerId: STANDBY, lastHeartbeat: 100n }],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    await sweep.scanOnce();
    await sweep.scanOnce();

    expect(submitters.promoteAfterEjection).toHaveBeenCalledTimes(1);
  });
});

describe('RoomHealthSweep — returned actions', () => {
  it('scanOnce() returns the actions it took, for observability', async () => {
    const reader = makeReader({
      rooms: {
        [ROOM]: { relays: [PRIMARY, STANDBY] },
      },
      relayPool: [{ minerId: STANDBY, lastHeartbeat: 100n }],
    });
    const submitters = makeSubmitters();
    const sweep = new RoomHealthSweep(reader, submitters, mockLogger());

    const actions = await sweep.scanOnce();

    expect(actions).toEqual(
      expect.arrayContaining([
        { roomId: ROOM, kind: 'promote_relay_after_ejection', oldNodeId: PRIMARY, newNodeId: STANDBY },
      ]),
    );
  });
});
