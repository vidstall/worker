import { describe, it, expect, vi } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import type { RoomCreated } from '@dvconf/shared';
import { handleEvent, createEventHandler, DEFAULT_WEIGHTS } from '../event-handler.js';
import type { NodeCandidate } from '../scoring.js';
import { PVR_DEFAULT_HISTORY } from '../scoring.js';

/** Create a mock Pino logger. */
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

/** Create a fake SuiEvent. */
function makeSuiEvent(eventName: string, parsedJson: Record<string, unknown>): SuiEvent {
  return {
    id: { txDigest: 'test-digest', eventSeq: '0' },
    packageId: '0xabc',
    transactionModule: 'test_module',
    sender: '0x123',
    type: `0xabc::relay_registry::${eventName}`,
    parsedJson,
    bcs: '',
    timestampMs: '1000',
  } as SuiEvent;
}

/** Create an empty pending rooms map for handleEvent calls. */
function emptyPendingRooms(): Map<string, RoomCreated> {
  return new Map<string, RoomCreated>();
}

/**
 * A 3-validator pool — the recorded room_health_validators ballot must be exactly 3
 * (room-assignment.ts's healthValidatorMinerIds floor, room_health_alerts.move), so any
 * EscrowCreated test that expects to reach the capacity/ballot logic (not defer early) needs
 * at least 3 validators, regardless of what it's actually testing about relays.
 */
function threeValidators(): Map<string, NodeCandidate> {
  return new Map<string, NodeCandidate>([
    ['val-1', { minerId: 'val-1', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
    ['val-2', { minerId: 'val-2', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
    ['val-3', { minerId: 'val-3', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
  ]);
}

describe('handleEvent', () => {
  it('RelayRegistered adds relay to state', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();

    const event = makeSuiEvent('RelayRegistered', {
      miner_id: 'relay-1',
      operator: '0xop1',
      mode: 0,
      region: [1, 2],
      stake_amount: '5000000000',
      endpoint_url: [119, 115], // "ws" as bytes
    });

    handleEvent(event, relayState, emptyPendingRooms(), logger);

    expect(relayState.has('relay-1')).toBe(true);
    const relay = relayState.get('relay-1')!;
    expect(relay.minerId).toBe('relay-1');
    expect(relay.stakeAmount).toBe(5_000_000_000n);
    expect(relay.region).toBe('1,2');
    expect(relay.rtt).toBe(0n);
    expect(relay.load).toBe(0n);
    expect(relay.heartbeatAge).toBe(0n);
    expect(relay.historyScore).toBe(PVR_DEFAULT_HISTORY);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1' }),
      'Relay registered',
    );
  });

  it('RelayLoadUpdated updates existing relay', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    relayState.set('relay-1', {
      minerId: 'relay-1',
      rtt: 50n,
      load: 10n,
      stakeAmount: 1_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });

    const event = makeSuiEvent('RelayLoadUpdated', {
      miner_id: 'relay-1',
      new_load: '42',
    });

    handleEvent(event, relayState, emptyPendingRooms(), logger);

    expect(relayState.get('relay-1')!.load).toBe(42n);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1', newLoad: '42' }),
      'Relay load updated',
    );
  });

  it('RelayRTTUpdated updates existing relay', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    relayState.set('relay-1', {
      minerId: 'relay-1',
      rtt: 0n,
      load: 0n,
      stakeAmount: 1_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });

    const event = makeSuiEvent('RelayRTTUpdated', {
      miner_id: 'relay-1',
      rtt: '25',
    });

    handleEvent(event, relayState, emptyPendingRooms(), logger);

    expect(relayState.get('relay-1')!.rtt).toBe(25n);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1', rtt: '25' }),
      'Relay RTT updated',
    );
  });

  it('RoomCreated stores room in pendingRooms (no immediate assignment)', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const pendingRooms = new Map<string, RoomCreated>();

    relayState.set('relay-good', {
      minerId: 'relay-good',
      rtt: 20n,
      load: 5n,
      stakeAmount: 8_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });

    const event = makeSuiEvent('RoomCreated', {
      room_id: 'room-1',
      creator: '0xcreator',
      relay_mode: 0,
    });

    handleEvent(event, relayState, pendingRooms, logger);

    // Room stored in pending, NOT assigned yet
    expect(pendingRooms.has('room-1')).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-1' }),
      'Room created — waiting for escrow before assignment',
    );
    // No assignment logs
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Room proposal: submitting TX',
    );
  });

  it('EscrowCreated triggers scoring and assignment (no TX context)', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const pendingRooms = new Map<string, RoomCreated>();

    relayState.set('relay-good', {
      minerId: 'relay-good',
      rtt: 20n,
      load: 5n,
      stakeAmount: 8_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });
    // REQ-RMS-002/004 (Task 8): the recorded ballot must be >= MIN_RELAY (3) or
    // submit_pairing_proposal aborts on-chain (E_INVALID_BALLOT=509, room_manager.move:374).
    // A 3-relay pool (1 primary + 2 pre-warmed standby) gives a valid ballot (a smaller
    // fixture would now correctly DEFER under the on-chain floor).
    relayState.set('relay-good-2', {
      minerId: 'relay-good-2',
      rtt: 40n,
      load: 5n,
      stakeAmount: 4_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });
    relayState.set('relay-good-3', {
      minerId: 'relay-good-3',
      rtt: 60n,
      load: 5n,
      stakeAmount: 2_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });

    // Step 1: RoomCreated
    const roomEvent = makeSuiEvent('RoomCreated', {
      room_id: 'room-1',
      creator: '0xcreator',
      relay_mode: 0,
    });
    handleEvent(roomEvent, relayState, pendingRooms, logger);

    // Step 2: EscrowCreated
    const escrowEvent = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-1',
      creator: '0xcreator',
      amount: '50000000',
    });
    handleEvent(escrowEvent, relayState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), threeValidators());

    // Room removed from pending
    expect(pendingRooms.has('room-1')).toBe(false);
    // Assignment triggered
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'room-1',
      }),
      'Room proposal: submitting TX',
    );
    // No TX context — should warn about skipping
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-1' }),
      'No TX context — pairing proposal skipped (test mode)',
    );
  });

  it('EscrowCreated for unknown room warns', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const pendingRooms = new Map<string, RoomCreated>();

    const event = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-unknown',
      creator: '0xcreator',
      amount: '50000000',
    });

    handleEvent(event, relayState, pendingRooms, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-unknown' }),
      'EscrowCreated for unknown room, ignoring',
    );
  });

  it('unknown event type is logged and skipped', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();

    const event = makeSuiEvent('SomeFutureEvent', { data: 'test' });

    handleEvent(event, relayState, emptyPendingRooms(), logger);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'SomeFutureEvent' }),
      'Unknown event type, skipping',
    );
    expect(relayState.size).toBe(0);
  });

  it('events for unknown relays are handled gracefully', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();

    // Load update for a relay not in state
    const loadEvent = makeSuiEvent('RelayLoadUpdated', {
      miner_id: 'unknown-relay',
      new_load: '100',
    });
    handleEvent(loadEvent, relayState, emptyPendingRooms(), logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'unknown-relay' }),
      'RelayLoadUpdated for unknown relay, ignoring',
    );

    // RTT update for a relay not in state
    const rttEvent = makeSuiEvent('RelayRTTUpdated', {
      miner_id: 'unknown-relay-2',
      rtt: '50',
    });
    handleEvent(rttEvent, relayState, emptyPendingRooms(), logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'unknown-relay-2' }),
      'RelayRTTUpdated for unknown relay, ignoring',
    );
  });

  it('EscrowCreated with no relays logs info instead of scoring', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const pendingRooms = new Map<string, RoomCreated>();

    // RoomCreated first
    const roomEvent = makeSuiEvent('RoomCreated', {
      room_id: 'room-empty',
      creator: '0xcreator',
      relay_mode: 0,
    });
    handleEvent(roomEvent, relayState, pendingRooms, logger);

    // EscrowCreated triggers assignment attempt
    const escrowEvent = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-empty',
      creator: '0xcreator',
      amount: '50000000',
    });
    handleEvent(escrowEvent, relayState, pendingRooms, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-empty' }),
      'No relays available — deferring assignment',
    );
  });
});

describe('createEventHandler', () => {
  it('returns handler function and state maps', () => {
    const logger = mockLogger();
    const { handler, relayState, validatorState, pendingRooms, pendingEscrows } = createEventHandler(logger);

    expect(typeof handler).toBe('function');
    expect(relayState).toBeInstanceOf(Map);
    expect(relayState.size).toBe(0);
    expect(validatorState).toBeInstanceOf(Map);
    expect(validatorState.size).toBe(0);
    expect(pendingRooms).toBeInstanceOf(Map);
    expect(pendingRooms.size).toBe(0);
    expect(pendingEscrows).toBeInstanceOf(Map);
    expect(pendingEscrows.size).toBe(0);
  });

  it('handler processes events and updates shared state', async () => {
    const logger = mockLogger();
    const { handler, relayState } = createEventHandler(logger);

    const event = makeSuiEvent('RelayRegistered', {
      miner_id: 'relay-x',
      operator: '0xop',
      mode: 0,
      region: [3],
      stake_amount: '2000000000',
      endpoint_url: [119, 115], // "ws" as bytes
    });

    await handler(event);

    expect(relayState.has('relay-x')).toBe(true);
    expect(relayState.get('relay-x')!.stakeAmount).toBe(2_000_000_000n);
  });
});

describe('REQ-RMS-019 RelayHeartbeat arm refreshes heartbeatAge', () => {
  it('updates an existing relay heartbeatAge from RelayHeartbeat.epoch (no longer stuck at 0n)', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    relayState.set('relay-1', {
      minerId: 'relay-1', rtt: 0n, load: 0n, stakeAmount: 1n,
      heartbeatAge: 5n, region: 'us', historyScore: PVR_DEFAULT_HISTORY,
    });
    // currentEpoch is threaded via the handler; the arm computes age = currentEpoch - hb.epoch.
    const event = makeSuiEvent('RelayHeartbeat', { miner_id: 'relay-1', epoch: '10', region: [1] });
    handleEvent(event, relayState, emptyPendingRooms(), logger);
    // After a fresh heartbeat the age must be refreshed toward 0 (was 5n).
    expect(relayState.get('relay-1')!.heartbeatAge).toBe(0n);
  });
});
