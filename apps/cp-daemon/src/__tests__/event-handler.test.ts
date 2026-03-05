import { describe, it, expect, vi } from 'vitest';
import type { SuiEvent } from '@mysten/sui/client';
import { handleEvent, createEventHandler, DEFAULT_WEIGHTS } from '../event-handler.js';
import type { RelayCandidate } from '../scoring.js';

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

describe('handleEvent', () => {
  it('RelayRegistered adds relay to state', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();

    const event = makeSuiEvent('RelayRegistered', {
      miner_id: 'relay-1',
      operator: '0xop1',
      mode: 0,
      region: [1, 2],
      stake_amount: '5000000000',
    });

    handleEvent(event, relayState, logger);

    expect(relayState.has('relay-1')).toBe(true);
    const relay = relayState.get('relay-1')!;
    expect(relay.minerId).toBe('relay-1');
    expect(relay.stakeAmount).toBe(5_000_000_000n);
    expect(relay.region).toBe('1,2');
    expect(relay.rtt).toBe(0n);
    expect(relay.load).toBe(0n);
    expect(relay.reputation).toBe(5_000n); // Default 50%
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1' }),
      'Relay registered',
    );
  });

  it('RelayLoadUpdated updates existing relay', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();
    relayState.set('relay-1', {
      minerId: 'relay-1',
      reputation: 5_000n,
      rtt: 50n,
      load: 10n,
      stakeAmount: 1_000_000_000n,
      region: 'us',
    });

    const event = makeSuiEvent('RelayLoadUpdated', {
      miner_id: 'relay-1',
      new_load: '42',
    });

    handleEvent(event, relayState, logger);

    expect(relayState.get('relay-1')!.load).toBe(42n);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1', newLoad: '42' }),
      'Relay load updated',
    );
  });

  it('RelayRTTUpdated updates existing relay', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();
    relayState.set('relay-1', {
      minerId: 'relay-1',
      reputation: 5_000n,
      rtt: 0n,
      load: 0n,
      stakeAmount: 1_000_000_000n,
      region: 'us',
    });

    const event = makeSuiEvent('RelayRTTUpdated', {
      miner_id: 'relay-1',
      rtt: '25',
    });

    handleEvent(event, relayState, logger);

    expect(relayState.get('relay-1')!.rtt).toBe(25n);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'relay-1', rtt: '25' }),
      'Relay RTT updated',
    );
  });

  it('RoomCreated triggers scoring and logs results', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();

    // Add two relays with different qualities
    relayState.set('relay-good', {
      minerId: 'relay-good',
      reputation: 9_000n,
      rtt: 20n,
      load: 5n,
      stakeAmount: 8_000_000_000n,
      region: 'us',
    });
    relayState.set('relay-bad', {
      minerId: 'relay-bad',
      reputation: 1_000n,
      rtt: 400n,
      load: 800n,
      stakeAmount: 500_000_000n,
      region: 'eu',
    });

    const event = makeSuiEvent('RoomCreated', {
      room_id: 'room-1',
      creator: '0xcreator',
      relay_mode: 0,
    });

    handleEvent(event, relayState, logger);

    // Should log room created
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-1' }),
      'Room created',
    );
    // Should log scoring results
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: 'room-1',
        relayCount: 2,
        topRelays: expect.any(Array),
      }),
      expect.stringContaining('Relay scoring complete'),
    );
  });

  it('unknown event type is logged and skipped', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();

    const event = makeSuiEvent('SomeFutureEvent', { data: 'test' });

    handleEvent(event, relayState, logger);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: 'SomeFutureEvent' }),
      'Unknown event type, skipping',
    );
    expect(relayState.size).toBe(0);
  });

  it('events for unknown relays are handled gracefully', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();

    // Load update for a relay not in state
    const loadEvent = makeSuiEvent('RelayLoadUpdated', {
      miner_id: 'unknown-relay',
      new_load: '100',
    });
    handleEvent(loadEvent, relayState, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'unknown-relay' }),
      'RelayLoadUpdated for unknown relay, ignoring',
    );

    // RTT update for a relay not in state
    const rttEvent = makeSuiEvent('RelayRTTUpdated', {
      miner_id: 'unknown-relay-2',
      rtt: '50',
    });
    handleEvent(rttEvent, relayState, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerId: 'unknown-relay-2' }),
      'RelayRTTUpdated for unknown relay, ignoring',
    );
  });

  it('RoomCreated with no relays logs info instead of scoring', () => {
    const logger = mockLogger();
    const relayState = new Map<string, RelayCandidate>();

    const event = makeSuiEvent('RoomCreated', {
      room_id: 'room-empty',
      creator: '0xcreator',
      relay_mode: 0,
    });

    handleEvent(event, relayState, logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: 'room-empty' }),
      'No relays available for scoring',
    );
  });
});

describe('createEventHandler', () => {
  it('returns handler function and relay state map', () => {
    const logger = mockLogger();
    const { handler, relayState } = createEventHandler(logger);

    expect(typeof handler).toBe('function');
    expect(relayState).toBeInstanceOf(Map);
    expect(relayState.size).toBe(0);
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
    });

    await handler(event);

    expect(relayState.has('relay-x')).toBe(true);
    expect(relayState.get('relay-x')!.stakeAmount).toBe(2_000_000_000n);
  });
});
