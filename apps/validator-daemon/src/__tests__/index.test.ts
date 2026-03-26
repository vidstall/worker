/**
 * Tests for the Validator daemon entry point.
 *
 * Verifies:
 * - Session wallet is different from main wallet
 * - Measurement loop calls collectMeasurements at configured interval
 * - Each cycle produces a dual-key signed proof
 * - Proof is logged but NOT submitted (no executeWithRetry for proof submission)
 * - Graceful shutdown stops measurement loop
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Mock all @dvconf/shared exports
const mockExecuteWithRetry = vi.fn();
const mockLoadNetworkConfig = vi.fn();
const mockCreateSuiClient = vi.fn();
const mockLoadKeypair = vi.fn();
const mockGenerateSessionKeypair = vi.fn();
const mockEventPollerStart = vi.fn();
const mockEventPollerStop = vi.fn();

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();

  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
  };

  return {
    ...actual,
    executeWithRetry: (...args: unknown[]) => mockExecuteWithRetry(...args),
    loadNetworkConfig: () => mockLoadNetworkConfig(),
    createSuiClient: () => mockCreateSuiClient(),
    loadKeypair: (env: string) => mockLoadKeypair(env),
    generateSessionKeypair: () => mockGenerateSessionKeypair(),
    createLogger: () => mockLogger,
    EventPoller: vi.fn().mockImplementation(() => ({
      start: mockEventPollerStart,
      stop: mockEventPollerStop,
    })),
    MinerRole: { User: 0, Validator: 1, Relay: 2, CP: 3 },
  };
});

// Mock auto-register to return immediately
vi.mock('../auto-register.js', () => ({
  ensureRegistered: vi.fn().mockResolvedValue({ validatorCapId: '0xval-cap' }),
}));

// Spy on measurements and session-proof
import * as measurements from '../measurements.js';
import * as sessionProof from '../session-proof.js';

const collectSpy = vi.spyOn(measurements, 'collectMeasurements');
const buildProofSpy = vi.spyOn(sessionProof, 'buildSessionProof');
const dualKeySignSpy = vi.spyOn(sessionProof, 'dualKeySign');
const logProofSpy = vi.spyOn(sessionProof, 'logProofSummary');

import { startDaemon, stopDaemon, type DaemonState } from '../index.js';

describe('Validator daemon', () => {
  let state: DaemonState | null = null;
  const mainKeypair = new Ed25519Keypair();
  const sessionKeypair = new Ed25519Keypair();
  const sessionAddress = sessionKeypair.getPublicKey().toSuiAddress();

  const mockConfig = {
    rpcUrl: 'http://localhost:9000',
    packageId: '0xpkg',
    networkRegistryId: '0xreg',
    minerStoreId: '0xstore',
    cpRegistryId: '0xcpreg',
    relayRegistryId: '0xrelayreg',
    validatorRegistryId: '0xvalreg',
    userRegistryId: '0xuserreg',
    roomManagerId: '0xroom',
    signalingRegistryId: '0xsigreg',
    roleVoteBoxId: '0xvotebox',
  };

  const mockClient = {
    queryEvents: vi.fn().mockResolvedValue({ data: [], hasNextPage: false }),
    signAndExecuteTransaction: vi.fn().mockResolvedValue({ digest: '0xmockdigest' }),
    waitForTransaction: vi.fn().mockResolvedValue({}),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    process.env['VALIDATOR_CAP_ID'] = '0xval-cap';
    process.env['MEASUREMENT_INTERVAL_MS'] = '5000';

    mockGenerateSessionKeypair.mockReturnValue({
      keypair: sessionKeypair,
      address: sessionAddress,
    });

    mockEventPollerStart.mockClear();
    mockEventPollerStart.mockResolvedValue(undefined);
    mockEventPollerStop.mockReturnValue(undefined);

    collectSpy.mockClear();
    buildProofSpy.mockClear();
    dualKeySignSpy.mockClear();
    logProofSpy.mockClear();
  });

  afterEach(() => {
    if (state) {
      stopDaemon(state);
      state = null;
    }
    vi.useRealTimers();
  });

  it('session wallet generated is different from main wallet', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    const mainAddress = mainKeypair.getPublicKey().toSuiAddress();
    expect(state.sessionAddress).not.toBe(mainAddress);
    expect(state.sessionAddress).toBe(sessionAddress);
  });

  it('measurement loop calls collectMeasurements at configured interval', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // Pre-populate an active room with relay assignment (from RoomAssigned event)
    state.activeRooms.set('test-room', { relayMinerId: '0xrelay123' });

    // Wait for the async initial cycle
    await vi.advanceTimersByTimeAsync(0);
    const initialCalls = collectSpy.mock.calls.length;

    // Advance by one interval (5000ms)
    await vi.advanceTimersByTimeAsync(5000);
    expect(collectSpy.mock.calls.length).toBeGreaterThan(initialCalls);
  });

  it('each measurement cycle produces a dual-key signed proof', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // Pre-populate an active room with relay assignment
    state.activeRooms.set('test-room', { relayMinerId: '0xrelay123' });

    // Advance to trigger a measurement cycle
    await vi.advanceTimersByTimeAsync(5000);

    expect(buildProofSpy).toHaveBeenCalled();
    expect(dualKeySignSpy).toHaveBeenCalled();
    expect(logProofSpy).toHaveBeenCalled();
  });

  it('uses relay ID from room assignment (not env var)', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // Simulate RoomAssigned event populating activeRooms
    state.activeRooms.set('test-room-42', { relayMinerId: '0xrelay456' });

    await vi.advanceTimersByTimeAsync(5000);

    // buildSessionProof should receive the room's relay ID
    expect(buildProofSpy.mock.calls[0]?.[1]).toBe('0xrelay456');
  });

  it('skips measurement when room has no relay assignment', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // Room without relay assignment
    state.activeRooms.set('test-room', {});

    await vi.advanceTimersByTimeAsync(5000);

    // collectMeasurements should NOT be called (no relay to measure)
    expect(collectSpy).not.toHaveBeenCalled();
  });

  it('proof is logged but NOT submitted (no executeWithRetry for proof submission)', async () => {
    mockExecuteWithRetry.mockClear();

    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // Pre-populate an active room with relay assignment
    state.activeRooms.set('test-room', { relayMinerId: '0xrelay123' });

    // Wait for initial cycle + one interval
    await vi.advanceTimersByTimeAsync(5000);

    // executeWithRetry should NOT have been called for proof submission
    // (it may be called for registration, but ensureRegistered is mocked out)
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();

    // But logProofSummary should have been called (proof logged, not submitted)
    expect(logProofSpy).toHaveBeenCalled();
  });

  it('RoomAssigned adds room when own validator ID is in validator_ids', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // The room poller is the 3rd EventPoller started (validator, escrow, room)
    const roomPollerCallback = mockEventPollerStart.mock.calls[2]?.[0];
    expect(roomPollerCallback).toBeDefined();

    const roomId = '0xroom-assigned-1';
    // validatorMinerId === validatorCapId === '0xval-cap'
    await roomPollerCallback({
      type: '0xpkg::room_manager::RoomAssigned',
      parsedJson: {
        room_id: roomId,
        relay_ids: ['0xrelay-abc'],
        signaling_id: '0xsig1',
        relay_mode: 0,
        verified_score: '100',
        consensus_reached: true,
        winning_cp: '0xcp1',
        validator_ids: ['0xval-cap', '0xother-val'],
      },
    });

    expect(state.activeRooms.has(roomId)).toBe(true);
    expect(state.activeRooms.get(roomId)?.relayMinerId).toBe('0xrelay-abc');
  });

  it('RoomAssigned ignores room when own validator ID is NOT in validator_ids', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    const roomPollerCallback = mockEventPollerStart.mock.calls[2]?.[0];
    expect(roomPollerCallback).toBeDefined();

    const roomId = '0xroom-ignored-1';
    await roomPollerCallback({
      type: '0xpkg::room_manager::RoomAssigned',
      parsedJson: {
        room_id: roomId,
        relay_ids: ['0xrelay-abc'],
        signaling_id: '0xsig1',
        relay_mode: 0,
        verified_score: '100',
        consensus_reached: true,
        winning_cp: '0xcp1',
        validator_ids: ['0xother1', '0xother2'],
      },
    });

    expect(state.activeRooms.has(roomId)).toBe(false);
  });

  it('RoomCreated does NOT auto-add rooms', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    const roomPollerCallback = mockEventPollerStart.mock.calls[2]?.[0];
    expect(roomPollerCallback).toBeDefined();

    const roomId = '0xroom-created-no-add';
    await roomPollerCallback({
      type: '0xpkg::room_manager::RoomCreated',
      parsedJson: {
        room_id: roomId,
        creator: '0xcreator1',
        relay_mode: 0,
      },
    });

    expect(state.activeRooms.has(roomId)).toBe(false);
  });

  it('graceful shutdown stops measurement loop', async () => {
    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    expect(state.running).toBe(true);
    expect(state.measurementTimer).not.toBeNull();

    stopDaemon(state);

    expect(state.running).toBe(false);
    expect(state.measurementTimer).toBeNull();
    expect(state.eventPoller).toBeNull();
    expect(mockEventPollerStop).toHaveBeenCalled();

    state = null; // prevent double cleanup
  });
});
