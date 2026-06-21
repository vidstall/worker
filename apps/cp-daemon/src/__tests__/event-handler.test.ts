import { describe, it, expect, vi } from 'vitest';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, RoomCreated } from '@dvconf/shared';
import { handleEvent, createEventHandler, DEFAULT_WEIGHTS } from '../event-handler.js';
import type { NodeCandidate } from '../scoring.js';
import type { SignalingCandidate } from '../room-assignment.js';
import * as roomAssignment from '../room-assignment.js';
import { PVR_DEFAULT_HISTORY } from '../scoring.js';
import { getRevoteCandidates, clearRevoteCandidate } from '../role-voter.js';
import type { AttestedLoad } from '../coverage-load-reader.js';

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
    // REQ-RMS-002/004 (Task 8): the recorded ballot must be >= MIN_RELAY (2) or
    // submit_pairing_proposal aborts on-chain (E_INVALID_BALLOT=509, room_manager.move:374).
    // A second relay gives a pool of 2 so a valid ballot is recorded (the old single-relay
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

// F47 RV-010 — re-vote event routing + OQ-PH16 field-name decode lock.
// These fire raw events using the EXACT Move struct field names; if the handler
// were to read a renamed key (e.g. minerId instead of miner_id) the candidate set
// + log context would be wrong, so these tests lock the JSON decode contract.
describe('handleEvent — F47 re-vote routing (RV-010 + OQ-PH16 field-name lock)', () => {
  it('RevoteEligibleMarked queues the miner + decodes miner_id/reason/current_role/marked_at', () => {
    const logger = mockLogger();
    const ev = makeSuiEvent('RevoteEligibleMarked', {
      miner_id: '0xrv-1',
      reason: 1,
      current_role: 2,
      marked_at: '100',
    });

    handleEvent(ev, new Map<string, NodeCandidate>(), emptySignalingState(), emptyPendingRooms(), logger);

    expect(getRevoteCandidates()).toContain('0xrv-1');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: '0xrv-1', reason: 1, currentRole: 2, markedAt: '100' }),
      expect.any(String),
    );
    clearRevoteCandidate('0xrv-1'); // reset module singleton
  });

  it('RoleTransitioned clears the candidate + decodes old_role/new_role', () => {
    const logger = mockLogger();
    handleEvent(
      makeSuiEvent('RevoteEligibleMarked', { miner_id: '0xrv-2', reason: 2, current_role: 1, marked_at: '5' }),
      new Map<string, NodeCandidate>(),
      emptySignalingState(),
      emptyPendingRooms(),
      logger,
    );
    expect(getRevoteCandidates()).toContain('0xrv-2');

    handleEvent(
      makeSuiEvent('RoleTransitioned', { miner_id: '0xrv-2', old_role: 1, new_role: 2 }),
      new Map<string, NodeCandidate>(),
      emptySignalingState(),
      emptyPendingRooms(),
      logger,
    );
    expect(getRevoteCandidates()).not.toContain('0xrv-2');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: '0xrv-2', oldRole: 1, newRole: 2 }),
      expect.any(String),
    );
  });
});

describe('handleEvent — SecretRotated → TurnIssuer emergency kill-switch (F8 REQ-CRR-005)', () => {
  function makeTurnCredentialEvent(eventName: string, parsedJson: Record<string, unknown>) {
    return {
      id: { txDigest: 'rotate-digest', eventSeq: '0' },
      packageId: '0xabc',
      transactionModule: 'turn_credential',
      sender: '0x123',
      type: `0xabc::turn_credential::${eventName}`,
      parsedJson,
      bcs: '',
      timestampMs: '3000',
    } as any;
  }

  it('forwards old_secret_id (u64 string → number) to turnIssuer.emergencyEvictSecret + WARN audit log', () => {
    const logger = mockLogger();
    const evictFn = vi.fn().mockReturnValue(true);
    const turnIssuer = { emergencyEvictSecret: evictFn } as any;

    const event = makeTurnCredentialEvent('SecretRotated', {
      cp_miner_id: '0xcp1',
      old_secret_id: '7',
      new_secret_id: '8',
      reason: 0,
      rotated_at_epoch: '42',
    });

    handleEvent(
      event,
      new Map<string, NodeCandidate>(),
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

    expect(evictFn).toHaveBeenCalledExactlyOnceWith(7, 0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ oldSecretId: '7', newSecretId: '8', reason: 0, evicted: true }),
      'SecretRotated — TURN issuer emergency kill-switch (F8)',
    );
  });

  it('no TurnIssuer in txContext → WARN not-armed, does not throw', () => {
    const logger = mockLogger();
    const event = makeTurnCredentialEvent('SecretRotated', {
      cp_miner_id: '0xcp1',
      old_secret_id: '7',
      new_secret_id: '8',
      reason: 1,
      rotated_at_epoch: '42',
    });

    expect(() =>
      handleEvent(
        event,
        new Map<string, NodeCandidate>(),
        emptySignalingState(),
        emptyPendingRooms(),
        logger,
      ),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ oldSecretId: '7' }),
      expect.stringContaining('no TurnIssuer in txContext'),
    );
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
    handleEvent(event, relayState, emptySignalingState(), emptyPendingRooms(), logger);
    // After a fresh heartbeat the age must be refreshed toward 0 (was 5n).
    expect(relayState.get('relay-1')!.heartbeatAge).toBe(0n);
  });
});

describe('REQ-RMS-002 capacity-aware placement replaces the hardcoded top-2 slice', () => {
  it('selects i* = argmin (l_i + L_r)/C_worker, not just the top PVR score', () => {
    // CONCRETE failing-test-first for REQ-RMS-002's load-bearing selection. This is RED BEFORE
    // 8.4: today the EscrowCreated arm slices the top-2 by PVR score, so the high-stake 'hot'
    // relay (best PVR score) wins even though it is over capacity — the assertion below fails.
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    // 'hot' has high stake (best PVR score) but is near-saturated on attested load; 'cool' is light.
    relayState.set('hot',  { minerId: 'hot',  rtt: 0n, load: 0n, stakeAmount: 5_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('cool', { minerId: 'cool', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    const signalingState = new Map<string, SignalingCandidate>([['sig', { minerId: 'sig', load: 0n, region: '' }]]);
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot',  { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }], // 295 + L_r(12) = 307 > C_worker 300 -> rejected
      ['cool', { attestedLoadPaths: 10,  heartbeatFreshEpochs: 1 }], // 10 + 12 = 22 -> chosen
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });
    // attestedLoad is the 10th positional arg (after event,relayState,signalingState,pendingRooms,
    // logger,weights,txContext,pendingEscrows,validatorState). txContext=undefined => test mode logs topRelays.
    handleEvent(escrow, relayState, signalingState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), new Map(), attested);
    const proposalLog = logger.info.mock.calls.find((c: any[]) => c[1] === 'Room proposal: submitting TX');
    // RED today (PVR-top 'hot' wins the hardcoded slice); GREEN after 8.4 (capacity override picks 'cool').
    expect(proposalLog?.[0].topRelays?.[0]).toBe('cool');
  });

  it('REQ-RMS-002 records a ballot >= MIN_RELAY even when only ONE relay is capacity-eligible', () => {
    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    // 'ok' is the sole capacity-eligible relay; 'full' is over its ceiling (rejected by selection)
    // but MUST still appear in the recorded ballot to satisfy the on-chain min_relay floor.
    relayState.set('ok',   { minerId: 'ok',   rtt: 0n, load: 0n, stakeAmount: 2_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('full', { minerId: 'full', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    const signalingState = new Map<string, SignalingCandidate>([['sig', { minerId: 'sig', load: 0n, region: '' }]]);
    const pendingRooms = new Map<string, RoomCreated>([['room2', { room_id: 'room2', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['ok',   { attestedLoadPaths: 10,  heartbeatFreshEpochs: 1 }], // 10 + 12 = 22 <= 300 -> only eligible
      ['full', { attestedLoadPaths: 299, heartbeatFreshEpochs: 1 }], // 299 + 12 = 311 > 300 -> NOT eligible
    ]);
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e2', room_id: 'room2', amount: '1' });
    handleEvent(escrow, relayState, signalingState, pendingRooms, logger, DEFAULT_WEIGHTS, undefined, new Map(), new Map(), attested);
    const proposalLog = logger.info.mock.calls.find((c: any[]) => c[1] === 'Room proposal: submitting TX');
    const ballot = proposalLog?.[0].topRelays as string[] | undefined;
    expect(ballot?.[0]).toBe('ok');                       // chosen (sole eligible) is index 0
    expect(ballot?.length).toBeGreaterThanOrEqual(2);     // >= MIN_RELAY — back-filled 'full' clears the on-chain floor
  });
});

describe('REQ-RMS-004 capacity-selected N-vector reaches submit_pairing_proposal unchanged', () => {
  it('REQ-RMS-004 records the capacity-selected N-vector via submit_pairing_proposal unchanged', async () => {
    const spy = vi.spyOn(roomAssignment, 'submitProposal').mockResolvedValue(undefined);
    roomAssignment.clearVotedRoom('room1'); // votedRooms is a module Set — clear so the proposal is not skipped as already-voted

    const logger = mockLogger();
    const relayState = new Map<string, NodeCandidate>();
    relayState.set('hot',  { minerId: 'hot',  rtt: 0n, load: 0n, stakeAmount: 5_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    relayState.set('cool', { minerId: 'cool', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY });
    const signalingState = new Map<string, SignalingCandidate>([['sig', { minerId: 'sig', load: 0n, region: '' }]]);
    const validatorState = new Map<string, NodeCandidate>([
      ['val', { minerId: 'val', rtt: 0n, load: 0n, stakeAmount: 1_000_000_000n, heartbeatAge: 0n, region: '', historyScore: PVR_DEFAULT_HISTORY }],
    ]);
    const pendingRooms = new Map<string, RoomCreated>([['room1', { room_id: 'room1', creator: '0xc', relay_mode: 0, room_class_hint: 0 }]]);
    const attested = new Map<string, AttestedLoad>([
      ['hot',  { attestedLoadPaths: 295, heartbeatFreshEpochs: 1 }],
      ['cool', { attestedLoadPaths: 10,  heartbeatFreshEpochs: 1 }],
    ]);
    // Minimal txContext — submitProposal is mocked, so client/signer/config/cpCapId need only satisfy the type.
    const txContext = {
      client: {} as unknown as SuiClient,
      signer: {} as unknown as Ed25519Keypair,
      config: {} as unknown as NetworkConfig,
      cpCapId: '0xcap',
    };
    const escrow = makeSuiEvent('EscrowCreated', { escrow_id: 'e1', room_id: 'room1', amount: '1' });
    // Full positional call: event, relayState, signalingState, pendingRooms, logger, weights, txContext,
    // pendingEscrows, validatorState, attestedLoad.
    handleEvent(escrow, relayState, signalingState, pendingRooms, logger, DEFAULT_WEIGHTS, txContext, new Map(), validatorState, attested);

    expect(spy).toHaveBeenCalled();
    const args = spy.mock.calls[0]!;
    // args[5] = relayMinerIds (capacity-selected, length >= MIN_RELAY); args[8] = submittedScore (bigint, PVR consensus).
    expect(Array.isArray(args[5])).toBe(true);
    expect((args[5] as string[]).length).toBeGreaterThanOrEqual(2);
    expect((args[5] as string[])[0]).toBe('cool'); // capacity-selected relay leads the recorded vector
    expect(typeof args[8]).toBe('bigint');
    spy.mockRestore();
  });
});
