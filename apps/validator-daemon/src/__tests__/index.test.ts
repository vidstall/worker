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

vi.mock('@dvconf/shared', () => {
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
  };

  const mockClient = {
    queryEvents: vi.fn().mockResolvedValue({ data: [], hasNextPage: false }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    process.env['VALIDATOR_CAP_ID'] = '0xval-cap';
    process.env['RELAY_MINER_ID'] = 'test-relay';
    process.env['MEASUREMENT_INTERVAL_MS'] = '5000';

    mockGenerateSessionKeypair.mockReturnValue({
      keypair: sessionKeypair,
      address: sessionAddress,
    });

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

    // Initial call happens immediately
    // Wait for the async initial cycle
    await vi.advanceTimersByTimeAsync(0);
    const initialCalls = collectSpy.mock.calls.length;
    expect(initialCalls).toBeGreaterThanOrEqual(1);

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

    // Wait for initial cycle
    await vi.advanceTimersByTimeAsync(0);

    expect(buildProofSpy).toHaveBeenCalled();
    expect(dualKeySignSpy).toHaveBeenCalled();
    expect(logProofSpy).toHaveBeenCalled();
  });

  it('uses ROOM_ID from env when set', async () => {
    process.env['ROOM_ID'] = 'test-room-42';

    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(buildProofSpy.mock.calls[0]?.[0]).toBe('test-room-42');

    delete process.env['ROOM_ID'];
  });

  it('defaults roomId to "unassigned" when ROOM_ID env is not set', async () => {
    delete process.env['ROOM_ID'];

    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(buildProofSpy.mock.calls[0]?.[0]).toBe('unassigned');
  });

  it('proof is logged but NOT submitted (no executeWithRetry for proof submission)', async () => {
    mockExecuteWithRetry.mockClear();

    state = await startDaemon({
      client: mockClient as any,
      mainKeypair,
      config: mockConfig,
    });

    // Wait for initial cycle + one interval
    await vi.advanceTimersByTimeAsync(5000);

    // executeWithRetry should NOT have been called for proof submission
    // (it may be called for registration, but ensureRegistered is mocked out)
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();

    // But logProofSummary should have been called (proof logged, not submitted)
    expect(logProofSpy).toHaveBeenCalled();
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
