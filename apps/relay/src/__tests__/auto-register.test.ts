/**
 * Unit tests for relay daemon auto-registration flow.
 *
 * Mirrors the CP daemon auto-register test pattern: mocks SuiClient,
 * executeWithRetry, and verifies the 2-step registration flow.
 *
 * Requirements: RELAY-05
 */

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
    relayRegistryId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    validatorRegistryId: '0xval',
    userRegistryId: '0xuser',
    roomManagerId: '0xroom',
    signalingRegistryId: '0xsig',
    roleVoteBoxId: '0xvotebox',
    livenessVoteBoxId: '0xlivenessbox',
  };
}

const mockSigner = { toSuiAddress: () => '0xsigner' } as any;

/**
 * Step 1 effects: registration::register creates MinerCap + StakePosition.
 * Uses objectChanges (post-Sui SDK 1.x) so extractCreatedObjectByType() can find them.
 */
function step1Effects() {
  return {
    digest: 'digest-1',
    objectChanges: [
      {
        type: 'created',
        objectId: '0xminer-cap',
        objectType: '0xpkg::caps::MinerCap',
      },
      {
        type: 'created',
        objectId: '0xstake-pos',
        objectType: '0xpkg::staking::StakePosition',
      },
    ],
    effects: { created: [] },
    events: [],
  };
}

/** Step 2 effects: register_relay creates no new objects. */
function step2Effects() {
  return {
    digest: 'digest-2',
    effects: { created: [] },
    events: [],
  };
}

describe('ensureRegistered (relay)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns early when MINER_CAP_ID set and already in RelayRegistry', async () => {
    process.env['MINER_CAP_ID'] = '0xexisting-cap';
    const logger = mockLogger();

    const mockClient = {
      getObject: vi.fn().mockResolvedValue({
        data: {
          content: { fields: { miner_id: '0x' + '0'.repeat(62) + '02' } },
        },
      }),
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[new Uint8Array([1])]] }],
      }),
    } as any;

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:4000', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xexisting-cap');
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });

  it('runs step 2 only when MINER_CAP_ID set but NOT in RelayRegistry', async () => {
    process.env['MINER_CAP_ID'] = '0xexisting-cap';
    const logger = mockLogger();

    const mockClient = {
      getObject: vi.fn().mockResolvedValue({
        data: {
          content: { fields: { miner_id: '0x' + '0'.repeat(62) + '02' } },
        },
      }),
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[new Uint8Array([0])]] }],
      }),
      getOwnedObjects: vi.fn().mockResolvedValue({
        data: [{ data: { objectId: '0xstake-from-chain' } }],
      }),
    } as any;

    mockExecuteWithRetry.mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:4000', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xexisting-cap');
    // Only step 2 called
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      mockClient, mockSigner, expect.any(Function), 'relay-registration', logger,
    );
  });

  it('runs full 2-step registration when MINER_CAP_ID not set', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();
    const mockClient = {} as any;

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:4000', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xminer-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      1, mockClient, mockSigner, expect.any(Function), 'miner-registration', logger,
    );
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      2, mockClient, mockSigner, expect.any(Function), 'relay-registration', logger,
    );
  });

  it('Step 1 TX has correct 12 args for registration::register', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    await ensureRegistered({} as any, mockSigner, mockConfig(), 'ws://127.0.0.1:4000', 'us-east', logger);

    const buildTxStep1 = mockExecuteWithRetry.mock.calls[0]![2] as (tx: any) => void;

    const moveCallArgs: unknown[][] = [];
    const mockTx = {
      gas: 'tx.gas',
      splitCoins: vi.fn().mockReturnValue(['mock-coin']),
      object: vi.fn((id: string) => ({ kind: 'object', id })),
      pure: {
        vector: vi.fn((type: string, val: unknown) => ({ kind: 'pure', type, val })),
        u8: vi.fn((val: number) => ({ kind: 'pure', type: 'u8', val })),
        u16: vi.fn((val: number) => ({ kind: 'pure', type: 'u16', val })),
        u64: vi.fn((val: number | bigint) => ({ kind: 'pure', type: 'u64', val })),
      },
      moveCall: vi.fn((opts: { target: string; arguments: unknown[] }) => {
        moveCallArgs.push(opts.arguments);
      }),
    };

    buildTxStep1(mockTx);

    expect(mockTx.moveCall).toHaveBeenCalledTimes(1);
    const args = moveCallArgs[0]!;
    expect(args).toHaveLength(12);
  });

  it('Step 2 TX has correct 6 args for relay_registry::register_relay', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();
    const config = mockConfig();

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    await ensureRegistered({} as any, mockSigner, config, 'ws://127.0.0.1:4000', 'us-east', logger);

    const buildTxStep2 = mockExecuteWithRetry.mock.calls[1]![2] as (tx: any) => void;

    const moveCallArgs: unknown[][] = [];
    const mockTx = {
      object: vi.fn((id: string) => ({ kind: 'object', id })),
      pure: {
        vector: vi.fn((type: string, val: unknown) => ({ kind: 'pure', type, val })),
        u8: vi.fn(),
        u16: vi.fn(),
        u64: vi.fn(),
      },
      moveCall: vi.fn((opts: { target: string; arguments: unknown[] }) => {
        moveCallArgs.push(opts.arguments);
      }),
    };

    buildTxStep2(mockTx);

    expect(mockTx.moveCall).toHaveBeenCalledTimes(1);
    const args = moveCallArgs[0]!;
    expect(args).toHaveLength(6);

    // Verify arg identities
    expect(args[0]).toEqual({ kind: 'object', id: config.networkRegistryId });
    expect(args[1]).toEqual({ kind: 'object', id: config.relayRegistryId });
    expect(args[2]).toEqual({ kind: 'object', id: '0xminer-cap' });
    expect(args[3]).toEqual({ kind: 'object', id: '0xstake-pos' });
  });

  it('exits with error on registration failure', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    mockExecuteWithRetry.mockResolvedValueOnce(null);

    await expect(
      ensureRegistered({} as any, mockSigner, mockConfig(), 'ws://127.0.0.1:4000', 'us-east', logger),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('exits if Step 1 effects missing MinerCap', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest-1',
      effects: {
        created: [
          { reference: { objectId: '0xstake-pos' }, objectType: '0xpkg::staking::StakePosition' },
        ],
      },
      events: [],
    });

    await expect(
      ensureRegistered({} as any, mockSigner, mockConfig(), 'ws://127.0.0.1:4000', 'us-east', logger),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});
