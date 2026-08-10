/**
 * TDD tests for RelayHeartbeatWatcher (REQ-RO-009) — stale/fresh heartbeat
 * detection + N>=3 failover generalization (REQ-RMS-024).
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
 */

import { describe, it, expect, vi } from 'vitest';
import { RelayHeartbeatWatcher, type RelayChainStateReader, type PromoteSubmitter } from '../relay-heartbeat-watcher.js';

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
    // A warn log MUST be emitted for the no-fresh-candidate case. (REQ-RMS-024 unified the
    // 2-relay "both stale" and N>=3 "all standbys stale" paths into one warn; assert on the
    // message-stable "cannot promote" substring rather than the retired word "both".)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'relay-heartbeat-watcher' }),
      expect.stringContaining('cannot promote'),
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

// ── Tests: N>=3 failover generalization (REQ-RMS-024) ────────────────────────

describe('RelayHeartbeatWatcher — N>=3 failover (REQ-RMS-024)', () => {
  it('N=3: primary stale, [1] stale, [2] fresh -> promotes [2] (freshest live standby)', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n /*gap10 stale*/, '0xB': 95n /*gap5 stale*/, '0xC': 99n /*gap1 fresh*/ },
    }]});
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), { maxHeartbeatEpochs: 3n });
    const promotions = await watcher.scanOnce();
    expect(promotions).toEqual([{ roomId: '0xroom1', oldPrimary: '0xA', newPrimary: '0xC' }]);
  });

  it('N=3: freshest wins among MULTIPLE fresh standbys -> promotes the smallest-gap one, not slot [1]', async () => {
    // CONTROLLER-MANDATED freshest-selection discriminator (team-lead Task 9 review).
    // Both standbys are FRESH: [1]=B gap 2, [2]=C gap 1. The N>=3 code must pick the
    // FRESHEST live standby (C) — NOT merely the first fresh slot.
    // Analytic RED proof (the empirical RED window closed once impl landed at 93fd6e6):
    // the pre-change scanOnce hardcoded `standbyId = assignedRelays[1]` and promoted it
    // whenever fresh, never reading slot [2] —
    //   `git show 3a19177:apps/cp-daemon/src/relay-heartbeat-watcher.ts` lines 219-226 —
    // so old code would promote B here, failing this test.
    // (Also empirically re-confirmed RED: ran this file against 3a19177's production file
    // before committing — 3 discriminators fail, incl. this one.)
    // Distinct from test 1 (B is STALE there -> only proves slot-[2] reachability) and the
    // equal-gap tie-break test (a tie, not a strict freshness ordering).
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n /*gap10 stale*/, '0xB': 98n /*gap2 fresh*/, '0xC': 99n /*gap1 fresh*/ },
    }]});
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), { maxHeartbeatEpochs: 3n });
    const promotions = await watcher.scanOnce();
    expect(promotions).toEqual([{ roomId: '0xroom1', oldPrimary: '0xA', newPrimary: '0xC' }]);
  });

  it('N=3: freshest wins among multiple fresh standbys; equal gaps tie-break to the earlier slot', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n, '0xB': 99n, '0xC': 99n }, // B and C tie at gap=1
    }]});
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), { maxHeartbeatEpochs: 3n });
    const promotions = await watcher.scanOnce();
    expect(promotions[0]!.newPrimary).toBe('0xB'); // deterministic: earlier position
  });

  it('post-promotion duplicate vector [C,B,C]: candidates exclude the current primary and dedup ids', async () => {
    // the on-chain shape promote_relay leaves behind (room_manager.move:886-888)
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xC', '0xB', '0xC'],
      heartbeats: { '0xC': 90n /*current primary now stale*/, '0xB': 99n },
    }]});
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), { maxHeartbeatEpochs: 3n });
    const promotions = await watcher.scanOnce();
    expect(promotions).toEqual([{ roomId: '0xroom1', oldPrimary: '0xC', newPrimary: '0xB' }]); // NOT 0xC
  });

  it('second failover fires: dedup is per-(roomId, oldPrimary), not per-room-forever', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n, '0xB': 99n, '0xC': 98n },
    }]});
    const submitter = makeSubmitter();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, mockLogger(), { maxHeartbeatEpochs: 3n });
    await watcher.scanOnce(); // promotes B (gap1 < C gap2)
    // chain state after promotion: B replaced slot 0, B duplicated ([B,B,C]); later B dies too
    reader.state.rooms[0]!.assignedRelays = ['0xB', '0xB', '0xC'];
    reader.state.epoch = 110n;
    reader.state.rooms[0]!.heartbeats = { '0xB': 100n /*gap10 stale*/, '0xC': 109n /*fresh*/ };
    const second = await watcher.scanOnce();
    expect(second).toEqual([{ roomId: '0xroom1', oldPrimary: '0xB', newPrimary: '0xC' }]);
  });

  it('all standbys stale -> warn + no promotion (existing behavior at N=3)', async () => {
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n, '0xB': 90n, '0xC': 90n },
    }]});
    const submitter = makeSubmitter();
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(reader, submitter, logger, { maxHeartbeatEpochs: 3n });
    const promotions = await watcher.scanOnce();
    expect(promotions).toHaveLength(0);
    expect(submitter).not.toHaveBeenCalled();
    // REQ-RMS-024 — the no-fresh-candidate path MUST warn (the title's promise).
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'relay-heartbeat-watcher' }),
      expect.stringContaining('cannot promote'),
    );
  });

  it('N=3: promote_submit log carries the ranked candidate list (freshness ranking, for the live-run assert)', async () => {
    // REQ-RMS-024 (D2, reviewer fold) — the live-run runbook asserts "watcher log shows the
    // freshness ranking"; scanOnce must emit the sorted candidates (freshest first) in the
    // promote_submit log context. Fixture: B gap2, C gap1 -> ranked [C, B].
    const reader = makeReader({ epoch: 100n, rooms: [{
      roomId: '0xroom1',
      assignedRelays: ['0xA', '0xB', '0xC'],
      heartbeats: { '0xA': 90n /*stale*/, '0xB': 98n /*gap2*/, '0xC': 99n /*gap1*/ },
    }]});
    const logger = mockLogger();
    const watcher = new RelayHeartbeatWatcher(reader, makeSubmitter(), logger, { maxHeartbeatEpochs: 3n });
    await watcher.scanOnce();
    const submitCall = (logger.info as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === 'object' && c[0] !== null &&
        (c[0] as Record<string, unknown>)['action'] === 'promote_submit',
    );
    expect(submitCall).toBeDefined();
    expect((submitCall![0] as { context: { candidates: unknown } }).context.candidates).toEqual([
      { id: '0xC', gap: '1' },
      { id: '0xB', gap: '2' },
    ]);
  });
});
