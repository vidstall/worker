import { describe, it, expect, vi } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import type { RoomCreated } from '@dvconf/shared';
import { handleEvent, createEventHandler, DEFAULT_WEIGHTS } from '../event-handler.js';
import type { NodeCandidate } from '../scoring.js';
import type { SignalingCandidate } from '../room-assignment.js';
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

/** Create an empty signaling state map for handleEvent calls. */
function emptySignalingState(): Map<string, SignalingCandidate> {
  return new Map<string, SignalingCandidate>();
}

/** Create an empty pending rooms map for handleEvent calls. */
function emptyPendingRooms(): Map<string, RoomCreated> {
  return new Map<string, RoomCreated>();
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

    handleEvent(event, relayState, emptySignalingState(), emptyPendingRooms(), logger);

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

    handleEvent(event, relayState, emptySignalingState(), emptyPendingRooms(), logger);

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

    handleEvent(event, relayState, emptySignalingState(), emptyPendingRooms(), logger);

    expect(relayState.get('relay-1')!.rtt).toBe(25n);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1', rtt: '25' }),
      'Relay RTT updated',
    );
  });

  it('SignalingRegistered adds signaling node to state', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const signalingState = new Map<string, SignalingCandidate>();

    const event = makeSuiEvent('SignalingRegistered', {
      miner_id: 'sig-1',
      operator: '0xop',
      endpoint_url: [119, 115],
      region: [1],
      stake_amount: '1000000000',
    });

    handleEvent(event, relayState, signalingState, emptyPendingRooms(), logger);

    expect(signalingState.has('sig-1')).toBe(true);
    const sig = signalingState.get('sig-1')!;
    expect(sig.minerId).toBe('sig-1');
    expect(sig.load).toBe(0n);
    expect(sig.region).toBe('1');
  });

  it('SignalingLoadUpdated updates existing signaling node', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const signalingState = new Map<string, SignalingCandidate>();
    signalingState.set('sig-1', { minerId: 'sig-1', load: 0n, region: '1' });

    const event = makeSuiEvent('SignalingLoadUpdated', {
      miner_id: 'sig-1',
      new_load: '15',
    });

    handleEvent(event, relayState, signalingState, emptyPendingRooms(), logger);

    expect(signalingState.get('sig-1')!.load).toBe(15n);
  });

  it('RoomCreated stores room in pendingRooms (no immediate assignment)', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const signalingState = new Map<string, SignalingCandidate>();
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
    signalingState.set('sig-1', { minerId: 'sig-1', load: 0n, region: 'us' });

    const event = makeSuiEvent('RoomCreated', {
      room_id: 'room-1',
      creator: '0xcreator',
      relay_mode: 0,
    });

    handleEvent(event, relayState, signalingState, pendingRooms, logger);

    // Room stored in pending, NOT assigned yet
    expect(pendingRooms.has('room-1')).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-1' }),
      'Room created — waiting for escrow before assignment',
    );
    // No assignment logs
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ signalingMinerId: 'sig-1' }),
      'Room proposal: submitting TX',
    );
  });

  it('EscrowCreated triggers scoring and assignment (no TX context)', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const signalingState = new Map<string, SignalingCandidate>();
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
    signalingState.set('sig-1', { minerId: 'sig-1', load: 0n, region: 'us' });

    // Step 1: RoomCreated
    const roomEvent = makeSuiEvent('RoomCreated', {
      room_id: 'room-1',
      creator: '0xcreator',
      relay_mode: 0,
    });
    handleEvent(roomEvent, relayState, signalingState, pendingRooms, logger);

    // Step 2: EscrowCreated
    const escrowEvent = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-1',
      creator: '0xcreator',
      amount: '50000000',
    });
    handleEvent(escrowEvent, relayState, signalingState, pendingRooms, logger);

    // Room removed from pending
    expect(pendingRooms.has('room-1')).toBe(false);
    // Assignment triggered
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'room-1',
        signalingMinerId: 'sig-1',
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
    const signalingState = new Map<string, SignalingCandidate>();
    const pendingRooms = new Map<string, RoomCreated>();

    const event = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-unknown',
      creator: '0xcreator',
      amount: '50000000',
    });

    handleEvent(event, relayState, signalingState, pendingRooms, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-unknown' }),
      'EscrowCreated for unknown room, ignoring',
    );
  });

  it('EscrowCreated with no signaling nodes warns', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const signalingState = new Map<string, SignalingCandidate>();
    const pendingRooms = new Map<string, RoomCreated>();

    relayState.set('relay-1', {
      minerId: 'relay-1',
      rtt: 0n,
      load: 0n,
      stakeAmount: 1_000_000_000n,
      heartbeatAge: 0n,
      region: 'us',
      historyScore: PVR_DEFAULT_HISTORY,
    });

    // RoomCreated first
    const roomEvent = makeSuiEvent('RoomCreated', {
      room_id: 'room-1',
      creator: '0xcreator',
      relay_mode: 0,
    });
    handleEvent(roomEvent, relayState, signalingState, pendingRooms, logger);

    // EscrowCreated triggers assignment attempt
    const escrowEvent = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-1',
      creator: '0xcreator',
      amount: '50000000',
    });
    handleEvent(escrowEvent, relayState, signalingState, pendingRooms, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-1' }),
      'No signaling nodes available — deferring assignment',
    );
  });

  it('unknown event type is logged and skipped', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();

    const event = makeSuiEvent('SomeFutureEvent', { data: 'test' });

    handleEvent(event, relayState, emptySignalingState(), emptyPendingRooms(), logger);

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
    handleEvent(loadEvent, relayState, emptySignalingState(), emptyPendingRooms(), logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'unknown-relay' }),
      'RelayLoadUpdated for unknown relay, ignoring',
    );

    // RTT update for a relay not in state
    const rttEvent = makeSuiEvent('RelayRTTUpdated', {
      miner_id: 'unknown-relay-2',
      rtt: '50',
    });
    handleEvent(rttEvent, relayState, emptySignalingState(), emptyPendingRooms(), logger);
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
    handleEvent(roomEvent, relayState, emptySignalingState(), pendingRooms, logger);

    // EscrowCreated triggers assignment attempt
    const escrowEvent = makeSuiEvent('EscrowCreated', {
      escrow_id: 'escrow-1',
      room_id: 'room-empty',
      creator: '0xcreator',
      amount: '50000000',
    });
    handleEvent(escrowEvent, relayState, emptySignalingState(), pendingRooms, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-empty' }),
      'No relays available — deferring assignment',
    );
  });
});

describe('handleEvent — RelaySlashed → TurnIssuer kill-switch (S30.B.7)', () => {
  function makeEconomicEvent(eventName: string, parsedJson: Record<string, unknown>) {
    return {
      id: { txDigest: 'slash-digest', eventSeq: '0' },
      packageId: '0xabc',
      transactionModule: 'economic_layer',
      sender: '0x123',
      type: `0xabc::economic_layer::${eventName}`,
      parsedJson,
      bcs: '',
      timestampMs: '2000',
    } as any;
  }

  it('forwards RelaySlashed.relay_miner_id to turnIssuer.markSlashed', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    const markSlashedFn = vi.fn();
    const turnIssuer = { markSlashed: markSlashedFn } as any;

    const event = makeEconomicEvent('RelaySlashed', {
      room_id: 'room-1',
      relay_miner_id: 'bad-relay',
      slash_amount: '100000000',
    });

    handleEvent(
      event,
      relayState,
      emptySignalingState(),
      emptyPendingRooms(),
      logger,
      undefined,
      {
        client: undefined as any,
        signer: undefined as any,
        config: undefined as any,
        cpCapId: '0xcap',
        turnIssuer,
      },
    );

    expect(markSlashedFn).toHaveBeenCalledExactlyOnceWith('bad-relay');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ relayMinerId: 'bad-relay', roomId: 'room-1' }),
      'Relay slashed — TURN issuer kill-switch armed for this miner',
    );
  });

  it('logs a warning when RelaySlashed arrives without a turnIssuer in txContext', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();

    const event = makeEconomicEvent('RelaySlashed', {
      room_id: 'room-1',
      relay_miner_id: 'bad-relay',
      slash_amount: '100000000',
    });

    // txContext absent entirely — kill-switch should warn, not throw
    handleEvent(event, relayState, emptySignalingState(), emptyPendingRooms(), logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ relayMinerId: 'bad-relay' }),
      'RelaySlashed observed but no TurnIssuer in txContext — kill-switch not armed',
    );
  });
});

describe('createEventHandler', () => {
  it('returns handler function and state maps', () => {
    const logger = mockLogger();
    const { handler, relayState, signalingState, validatorState, pendingRooms, pendingEscrows } = createEventHandler(logger);

    expect(typeof handler).toBe('function');
    expect(relayState).toBeInstanceOf(Map);
    expect(relayState.size).toBe(0);
    expect(signalingState).toBeInstanceOf(Map);
    expect(signalingState.size).toBe(0);
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

  it('handler with TX context processes signaling events', async () => {
    const logger = mockLogger();
    const mockClient = {} as any;
    const mockSigner = {} as any;
    const mockConfig = { packageId: '0x1', networkRegistryId: '0x2', roomManagerId: '0x3' } as any;

    const { handler, signalingState } = createEventHandler(logger, undefined, {
      client: mockClient,
      signer: mockSigner,
      config: mockConfig,
      cpCapId: '0xcap',
    });

    const event = makeSuiEvent('SignalingRegistered', {
      miner_id: 'sig-1',
      operator: '0xop',
      endpoint_url: [119, 115],
      region: [2],
      stake_amount: '1000000000',
    });

    await handler(event);

    expect(signalingState.has('sig-1')).toBe(true);
    expect(signalingState.get('sig-1')!.load).toBe(0n);
  });
});
