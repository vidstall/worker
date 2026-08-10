import { describe, it, expect, vi } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import type { RoomCreated } from '@dvconf/shared';
import { handleEvent } from '../event-handler.js';
import type { NodeCandidate } from '../scoring.js';
import { getRevoteCandidates, clearRevoteCandidate } from '../role-voter.js';

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
    handleEvent(event, relayState, emptyPendingRooms(), logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ relayMinerId: 'bad-relay' }),
      'RelaySlashed observed but no TurnIssuer in txContext — kill-switch not armed',
    );
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

    handleEvent(ev, new Map<string, NodeCandidate>(), emptyPendingRooms(), logger);

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
      emptyPendingRooms(),
      logger,
    );
    expect(getRevoteCandidates()).toContain('0xrv-2');

    handleEvent(
      makeSuiEvent('RoleTransitioned', { miner_id: '0xrv-2', old_role: 1, new_role: 2 }),
      new Map<string, NodeCandidate>(),
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
