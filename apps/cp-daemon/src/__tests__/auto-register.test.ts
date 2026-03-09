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

/**
 * Step 1 effects: registration::register creates ControlPlaneCap + StakePosition.
 * Both entries include objectType so extractCreatedObjectByType() can find them.
 */
function step1Effects() {
  return {
    digest: 'digest-1',
    effects: {
      created: [
        {
          reference: { objectId: '0xcp-cap' },
          objectType: '0xpkg::caps::ControlPlaneCap',
        },
        {
          reference: { objectId: '0xstake-pos' },
          objectType: '0xpkg::staking::StakePosition',
        },
      ],
    },
    events: [],
  };
}

/**
 * Step 2 effects: register_cp creates no new objects.
 * The cpCapId is already in hand from Step 1.
 */
function step2Effects() {
  return {
    digest: 'digest-2',
    effects: {
      created: [],
    },
    events: [],
  };
}

describe('ensureRegistered', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── Existing tests (kept, mock effects updated) ────────────────────────────

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

    mockExecuteWithRetry.mockResolvedValueOnce(step1Effects());
    mockExecuteWithRetry.mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(mockClient, mockSigner, mockConfig(), logger);

    // cpCapId comes from Step 1 ControlPlaneCap — NOT from Step 2 effects
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

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

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

  // ── Exits when Step 1 effects are missing ControlPlaneCap or StakePosition ─

  it('exits with error if Step 1 effects are missing ControlPlaneCap', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    // Step 1 effects only return StakePosition — ControlPlaneCap absent
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest-1',
      effects: {
        created: [
          {
            reference: { objectId: '0xstake-pos' },
            objectType: '0xpkg::staking::StakePosition',
          },
        ],
      },
      events: [],
    });

    await expect(
      ensureRegistered(mockClient, mockSigner, mockConfig(), logger),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('exits with error if Step 1 effects are missing StakePosition', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    // Step 1 effects only return ControlPlaneCap — StakePosition absent
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest-1',
      effects: {
        created: [
          {
            reference: { objectId: '0xcp-cap' },
            objectType: '0xpkg::caps::ControlPlaneCap',
          },
        ],
      },
      events: [],
    });

    await expect(
      ensureRegistered(mockClient, mockSigner, mockConfig(), logger),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  // ── Arg-verification tests: capture buildTx and inspect moveCall calls ──────

  it('Step 1 (registration::register): passes exactly 13 args, region is vector<u8>, cpu_cores is u64', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    await ensureRegistered(mockClient, mockSigner, mockConfig(), logger);

    // Capture the buildTx function from the first executeWithRetry call (Step 1)
    const buildTxStep1 = mockExecuteWithRetry.mock.calls[0]![2] as (tx: any) => void;

    // Build a mock Transaction to capture moveCall args
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

    // Should have exactly one moveCall
    expect(mockTx.moveCall).toHaveBeenCalledTimes(1);
    const args = moveCallArgs[0]!;

    // Exactly 13 args
    expect(args).toHaveLength(13);

    // Arg 7 (region) must use pure.vector('u8', ...) — not pure.u8
    const regionArg = args[7] as { kind: string; type: string };
    expect(regionArg.kind).toBe('pure');
    expect(regionArg.type).toBe('u8'); // vector('u8', ...) records type as 'u8'
    expect(mockTx.pure.vector).toHaveBeenCalledWith('u8', expect.any(Array));

    // Arg 10 (cpu_cores) must use pure.u64, NOT pure.u8
    expect(mockTx.pure.u64).toHaveBeenCalledWith(1);
    // pure.u8 must NOT have been called with 1 (only with MinerRole.CP value which is numeric)
    const u8Calls = (mockTx.pure.u8 as ReturnType<typeof vi.fn>).mock.calls;
    // cpu_cores (value 1) must not appear in u8 calls — it must be in u64 calls
    const u64Calls = (mockTx.pure.u64 as ReturnType<typeof vi.fn>).mock.calls;
    expect(u64Calls.some((c) => c[0] === 1)).toBe(true); // cpu_cores = 1 via u64
    // region must not appear as pure.u8() (it's a vector)
    expect(mockTx.pure.vector).toHaveBeenCalledWith('u8', expect.any(Array));
  });

  it('Step 2 (register_cp): passes exactly 4 args = [networkRegistryId, cpRegistryId, cpCapId, stakePositionId]', async () => {
    delete process.env['CP_CAP_ID'];
    const logger = mockLogger();
    const config = mockConfig();

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    await ensureRegistered(mockClient, mockSigner, config, logger);

    // Capture the buildTx function from the second executeWithRetry call (Step 2)
    const buildTxStep2 = mockExecuteWithRetry.mock.calls[1]![2] as (tx: any) => void;

    const moveCallArgs: unknown[][] = [];
    const mockTx = {
      object: vi.fn((id: string) => ({ kind: 'object', id })),
      pure: {
        vector: vi.fn(),
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

    // Exactly 4 args
    expect(args).toHaveLength(4);

    // Verify arg identities: networkRegistryId, cpRegistryId, cpCapId (from Step 1), stakePositionId (from Step 1)
    expect(args[0]).toEqual({ kind: 'object', id: config.networkRegistryId });
    expect(args[1]).toEqual({ kind: 'object', id: config.cpRegistryId });
    expect(args[2]).toEqual({ kind: 'object', id: '0xcp-cap' });      // ControlPlaneCap from Step 1 effects
    expect(args[3]).toEqual({ kind: 'object', id: '0xstake-pos' });   // StakePosition from Step 1 effects
  });
});
