import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NetworkConfig } from '@dvconf/shared';

// Use vi.hoisted to create mock before vi.mock hoisting
const { mockExecuteWithRetry } = vi.hoisted(() => ({
  mockExecuteWithRetry: vi.fn(),
}));

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return {
    ...actual,
    executeWithRetry: mockExecuteWithRetry,
  };
});

import { buildHeartbeatTx, startHeartbeat } from '../heartbeat.js';

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

function mockConfig(): NetworkConfig {
  return {
    rpcUrl: 'http://localhost:9000',
    packageId: '0xpkg',
    networkRegistryId: '0xreg',
    minerStoreId: '0xstore',
    cpRegistryId: '0xcp',
    relayRegistryId: '0xrelay',
    validatorRegistryId: '0xval',
    userRegistryId: '0xuser',
    roomManagerId: '0xroom',
  };
}

describe('buildHeartbeatTx', () => {
  it('creates correct moveCall with target and arguments', async () => {
    // Import Transaction dynamically from the shared package's re-export
    const { Transaction } = await import('@mysten/sui/transactions');
    const tx = new Transaction();
    const config = mockConfig();
    const cpCapId = '0xcap-id';

    // Spy on tx.moveCall to verify the call
    const moveCallSpy = vi.spyOn(tx, 'moveCall');

    buildHeartbeatTx(tx, config, cpCapId);

    expect(moveCallSpy).toHaveBeenCalledWith({
      target: '0xpkg::control_plane_registry::heartbeat',
      arguments: [
        expect.anything(), // tx.object(networkRegistryId)
        expect.anything(), // tx.object(cpRegistryId)
        expect.anything(), // tx.object(cpCapId)
      ],
    });

    moveCallSpy.mockRestore();
  });
});

describe('startHeartbeat', () => {
  const mockClient = {} as any;
  const mockSigner = {} as any;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockExecuteWithRetry.mockResolvedValue({
      digest: 'hb-digest',
      effects: {},
      events: [],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls executeWithRetry at configured interval', async () => {
    const logger = mockLogger();
    const config = mockConfig();
    const intervalMs = 5_000;

    const stop = startHeartbeat(mockClient, mockSigner, config, '0xcap', intervalMs, logger);

    // Initial heartbeat (immediate)
    await vi.advanceTimersByTimeAsync(0);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);

    // After one interval
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    // After another interval
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(3);

    stop();
  });

  it('stopHeartbeat clears the interval', async () => {
    const logger = mockLogger();
    const config = mockConfig();

    const stop = startHeartbeat(mockClient, mockSigner, config, '0xcap', 5_000, logger);

    await vi.advanceTimersByTimeAsync(0);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);

    stop();

    // After stopping, no more calls should happen
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith('Heartbeat loop stopped');
  });

  it('delegates retry to executeWithRetry from shared TX wrapper (DAEMON-07)', async () => {
    const logger = mockLogger();
    const config = mockConfig();

    const stop = startHeartbeat(mockClient, mockSigner, config, '0xcap', 5_000, logger);

    await vi.advanceTimersByTimeAsync(0);

    // Verify executeWithRetry receives correct params
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      mockClient,
      mockSigner,
      expect.any(Function),
      'heartbeat',
      logger,
    );

    stop();
  });

  it('handles heartbeat failure gracefully (logs error, continues)', async () => {
    const logger = mockLogger();
    const config = mockConfig();

    // First call fails, second succeeds
    mockExecuteWithRetry
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce({ digest: 'ok', effects: {}, events: [] });

    const stop = startHeartbeat(mockClient, mockSigner, config, '0xcap', 5_000, logger);

    // Initial heartbeat (fails)
    await vi.advanceTimersByTimeAsync(0);
    // Error is caught and logged
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Initial heartbeat failed',
    );

    // Next interval still fires
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    stop();
  });
});
