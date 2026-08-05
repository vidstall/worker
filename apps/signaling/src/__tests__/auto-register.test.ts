/**
 * Unit tests for signaling daemon auto-registration flow.
 *
 * Mirrors apps/relay/src/__tests__/auto-register.test.ts's structure/coverage
 * (identical ensureRegistered shape, signaling-registry target instead of relay).
 *
 * Requirements: SIG-01
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NetworkConfig } from '@dvconf/shared';

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
    signalingRegistryId: '0x0000000000000000000000000000000000000000000000000000000000000001',
    roleVoteBoxId: '0xvotebox',
    roleVotingPackageId: '0xrolevotingpkg',
    livenessVoteBoxId: '0xlivenessbox',
  };
}

const mockSigner = { toSuiAddress: () => '0xsigner' } as any;

function step1Effects() {
  return {
    digest: 'digest-1',
    objectChanges: [
      { type: 'created', objectId: '0xminer-cap', objectType: '0xpkg::caps::MinerCap' },
      { type: 'created', objectId: '0xstake-pos', objectType: '0xpkg::staking::StakePosition' },
    ],
    effects: { created: [] },
    events: [],
  };
}

function step2Effects() {
  return { digest: 'digest-2', effects: { created: [] }, events: [] };
}

describe('ensureRegistered (signaling)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('refreshes endpoint_url when MINER_CAP_ID set and already in SignalingRegistry', async () => {
    process.env['MINER_CAP_ID'] = '0xexisting-cap';
    const logger = mockLogger();

    const mockClient = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { miner_id: '0x' + '0'.repeat(62) + '02' } } },
      }),
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[new Uint8Array([1])]] }],
      }),
    } as any;

    mockExecuteWithRetry.mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xexisting-cap');
    // No fresh registration TX -- just a best-effort endpoint_url refresh, so
    // a droplet recreate under this same recycled wallet doesn't leave the
    // registry pointing at a dead host (see signaling_registry.move's
    // update_endpoint_url).
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      mockClient, mockSigner, expect.any(Function), 'signaling-endpoint-refresh', logger,
    );
  });

  it('endpoint_url refresh is best-effort -- a failed refresh does not exit the process', async () => {
    process.env['MINER_CAP_ID'] = '0xexisting-cap';
    const logger = mockLogger();

    const mockClient = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { miner_id: '0x' + '0'.repeat(62) + '02' } } },
      }),
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[new Uint8Array([1])]] }],
      }),
    } as any;

    mockExecuteWithRetry.mockResolvedValueOnce(null);
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xexisting-cap');
    expect(mockExit).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerCapId: '0xexisting-cap' }),
      expect.stringContaining('Could not refresh SignalingRegistry endpoint_url'),
    );
    mockExit.mockRestore();
  });

  it('runs step 2 only when MINER_CAP_ID set but NOT in SignalingRegistry', async () => {
    process.env['MINER_CAP_ID'] = '0xexisting-cap';
    const logger = mockLogger();

    const mockClient = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { miner_id: '0x' + '0'.repeat(62) + '02' } } },
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
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xexisting-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    expect(mockExecuteWithRetry).toHaveBeenCalledWith(
      mockClient, mockSigner, expect.any(Function), 'signaling-registration', logger,
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
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xminer-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      1, mockClient, mockSigner, expect.any(Function), 'miner-registration', logger,
    );
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      2, mockClient, mockSigner, expect.any(Function), 'signaling-registration', logger,
    );
  });

  it('falls back to full re-registration when MINER_CAP_ID set but StakePosition is gone (ejected)', async () => {
    process.env['MINER_CAP_ID'] = '0xejected-cap';
    const logger = mockLogger();

    const mockClient = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { miner_id: '0x' + '0'.repeat(62) + '02' } } },
      }),
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[new Uint8Array([0])]] }], // not registered
      }),
      getOwnedObjects: vi.fn().mockResolvedValue({ data: [] }), // no StakePosition owned
    } as any;

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger,
    );

    // Falls all the way through to a FRESH cap, not the orphaned '0xejected-cap'.
    expect(result.minerCapId).toBe('0xminer-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      1, mockClient, mockSigner, expect.any(Function), 'miner-registration', logger,
    );
    expect(mockExecuteWithRetry).toHaveBeenNthCalledWith(
      2, mockClient, mockSigner, expect.any(Function), 'signaling-registration', logger,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ minerCapId: '0xejected-cap' }),
      expect.stringContaining('Falling back to full re-registration'),
    );
  });

  /** Builds a mock GraphQLQueryResult for one page of an address's transaction history. */
  function graphqlObjectChangesPage(objectType: string, objectAddress: string) {
    return {
      data: {
        address: {
          transactions: {
            nodes: [
              {
                digest: 'prior-tx',
                effects: {
                  objectChanges: {
                    nodes: [{ address: objectAddress, idCreated: true, outputState: { asMoveObject: { contents: { type: { repr: objectType } } } } }],
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          },
        },
      },
    };
  }

  it('recovers a prior partial registration attempt instead of re-minting (avoids E_ALREADY_REGISTERED)', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();

    const mockClient = {} as any;
    const mockGraphqlClient = {
      query: vi
        .fn()
        .mockResolvedValueOnce(graphqlObjectChangesPage('0xpkg::caps::MinerCap', '0xprior-cap'))
        .mockResolvedValueOnce(graphqlObjectChangesPage('0xpkg::staking::StakePosition', '0xprior-stake')),
    } as any;

    mockExecuteWithRetry.mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger, mockGraphqlClient,
    );

    expect(result.minerCapId).toBe('0xprior-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { minerCapId: '0xprior-cap', stakePositionId: '0xprior-stake' },
      expect.stringContaining('reusing instead of minting a new identity'),
    );
  });

  it('falls through to a fresh mint when no graphqlClient is available', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();

    const mockClient = {} as any;

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger,
    );

    expect(result.minerCapId).toBe('0xminer-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);
  });

  it('exits with error on registration failure', async () => {
    delete process.env['MINER_CAP_ID'];
    const logger = mockLogger();
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });

    mockExecuteWithRetry.mockResolvedValueOnce(null);

    await expect(
      ensureRegistered({} as any, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger),
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
      ensureRegistered({} as any, mockSigner, mockConfig(), 'ws://127.0.0.1:8080', 'us-east', logger),
    ).rejects.toThrow('process.exit');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});
