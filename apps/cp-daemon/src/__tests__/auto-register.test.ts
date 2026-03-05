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

import { ensureRegistered } from '../auto-register.js';

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

const mockClient = {} as any;
const mockSigner = { toSuiAddress: () => '0xsigner' } as any;

describe('ensureRegistered', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns CP_CAP_ID from env when set (skips registration)', async () => {
    process.env['CP_CAP_ID'] = '0xexisting-cap';
    const logger = mockLogger();

    const result = await ensureRegistered(mockClient, mockSigner, mockConfig(), logger);

    expect(result.cpCapId).toBe('0xexisting-cap');
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ cpCapId: '0xexisting-cap' }),
      'CP already registered (from env)',
    );
  });

  it('calls registration::register then control_plane_registry::register_cp when CP_CAP_ID not set', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();

    // First call: miner registration
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest-1',
      effects: {
        created: [{ reference: { objectId: '0xminer-cap' } }],
      },
      events: [],
    });

    // Second call: CP registration
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest-2',
      effects: {
        created: [{ reference: { objectId: '0xcp-cap' } }],
      },
      events: [],
    });

    const result = await ensureRegistered(mockClient, mockSigner, mockConfig(), logger);

    expect(result.cpCapId).toBe('0xcp-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    // Verify first call is miner-registration
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      1,
      mockClient,
      mockSigner,
      expect.any(Function),
      'miner-registration',
      logger,
    );

    // Verify second call is cp-registration
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      2,
      mockClient,
      mockSigner,
      expect.any(Function),
      'cp-registration',
      logger,
    );
  });

  it('exits with error on registration failure (insufficient funds)', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    // executeWithRetry returns null (all retries exhausted)
    mockExecuteWithRetry.mockResolvedValueOnce(null);

    await expect(
      ensureRegistered(mockClient, mockSigner, mockConfig(), logger),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Auto-registration failed'),
    );

    mockExit.mockRestore();
  });

  it('uses executeWithRetry for all TX calls (DAEMON-07/DAEMON-12)', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();

    // Both calls succeed
    mockExecuteWithRetry
      .mockResolvedValueOnce({
        digest: 'd1',
        effects: { created: [{ reference: { objectId: '0xm' } }] },
        events: [],
      })
      .mockResolvedValueOnce({
        digest: 'd2',
        effects: { created: [{ reference: { objectId: '0xc' } }] },
        events: [],
      });

    await ensureRegistered(mockClient, mockSigner, mockConfig(), logger);

    // Verify executeWithRetry (from @dvconf/shared) was used for BOTH TX calls
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);
    // Each call receives the shared TX wrapper signature
    for (const call of mockExecuteWithRetry.mock.calls) {
      expect(call).toHaveLength(5); // client, signer, buildTx, label, logger
      expect(typeof call[2]).toBe('function'); // buildTx is a function
      expect(typeof call[3]).toBe('string'); // label
    }
  });
});
