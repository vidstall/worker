/**
 * TDD tests for RelayHeartbeatWatcher (REQ-RO-009) — resolveMaxHeartbeatEpochs
 * (Move-constant floor, REQ-RMS-024), structured logging, the
 * startRelayHeartbeatWatcher factory, and pollIntervalMs handling (C2/N4).
 *
 * Mirrors revote-watcher.test.ts structure — all chain reads go through the
 * RelayChainStateReader seam so the decision logic runs fully offline.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  RelayHeartbeatWatcher,
  startRelayHeartbeatWatcher,
  resolveMaxHeartbeatEpochs,
  type RelayChainStateReader,
  type PromoteSubmitter,
} from '../relay-heartbeat-watcher.js';

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

// ── Tests: resolveMaxHeartbeatEpochs — Move-constant floor (REQ-RMS-024) ──────

describe('resolveMaxHeartbeatEpochs (REQ-RMS-024 — Move-constant floor)', () => {
  it('unset env -> the Move constant (3n)', () => {
    expect(resolveMaxHeartbeatEpochs(undefined, mockLogger())).toBe(3n);
  });
  it('valid env >= 3 -> honored', () => {
    expect(resolveMaxHeartbeatEpochs('5', mockLogger())).toBe(5n);
  });
  it('env below the Move floor -> CLAMPED to 3n + warn (promote_relay would abort E_RELAY_NOT_STALE=564)', () => {
    const logger = mockLogger();
    expect(resolveMaxHeartbeatEpochs('1', logger)).toBe(3n);
    expect(logger.warn).toHaveBeenCalled();
  });
  it('malformed env -> the Move constant + warn (never NaN/throw)', () => {
    const logger = mockLogger();
    expect(resolveMaxHeartbeatEpochs('banana', logger)).toBe(3n);
    expect(logger.warn).toHaveBeenCalled();
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
