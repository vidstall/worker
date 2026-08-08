/**
 * Tests for validator auto-registration flow.
 *
 * Verifies:
 * - Returns VALIDATOR_CAP_ID from env when set (skips registration)
 * - Calls registration::register then validator_registry::register_validator when not set
 * - Exits on registration failure
 * - Uses executeWithRetry for all TX calls (DAEMON-07/DAEMON-12)
 * - Step 1 TX: exactly 12 args, no MinerRole arg, all strings use vector<u8>
 * - Step 2 TX: exactly 4 args = [networkRegistryId, validatorRegistryId, minerCapId, stakePositionId]
 * - validatorCapId == minerCapId from Step 1 (register_validator creates no new objects)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ensureRegistered } from '../auto-register.js';
import type { NetworkConfig, Logger } from '@dvconf/shared';

// Mock executeWithRetry
const mockExecuteWithRetry = vi.fn();

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return {
    ...actual,
    executeWithRetry: (...args: unknown[]) => mockExecuteWithRetry(...args),
  };
});

/** Minimal mock SuiClient. */
function mockClient(): unknown {
  return {};
}

/** Minimal mock NetworkConfig. */
function mockConfig(): NetworkConfig {
  return {
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
    roleVotingPackageId: '0xrolevotingpkg',
    livenessVoteBoxId: '0xlivenessbox',
  };
}

/** Minimal mock logger. */
function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    silent: vi.fn(),
  } as unknown as Logger;
}

/**
 * Step 1 effects: registration::register creates MinerCap + StakePosition.
 * Uses objectChanges (post-Sui SDK 1.x) so extractCreatedObjectByType() can find them.
 */
function step1Effects() {
  return {
    digest: 'digest1',
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

/**
 * Step 2 effects: register_validator creates no new objects.
 * The validatorCapId is already in hand from Step 1 (minerCapId).
 */
function step2Effects() {
  return {
    digest: 'digest2',
    effects: {
      created: [],
    },
    events: [],
  };
}

describe('ensureRegistered', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockExecuteWithRetry.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // ── Existing tests (kept, mock effects updated) ────────────────────────────

  it('returns VALIDATOR_CAP_ID from env when set (skips registration)', async () => {
    process.env['VALIDATOR_CAP_ID'] = '0xexisting-cap';

    // ensureRegistered's env-cap path now confirms the cap ALREADY carries
    // role=Validator and is ALREADY in ValidatorRegistry (see auto-register.ts's
    // getMinerCapInfo/isRegisteredInValidatorRegistry) before short-circuiting --
    // so "skips registration" here means the client's happy-path reads must
    // be stubbed, not that the client goes unused.
    // tx.pure.id() (inside isRegisteredInValidatorRegistry) requires a real
    // 32-byte hex object id -- an obviously-fake string like "0xminer-id"
    // throws there, which the surrounding try/catch swallows into a silent
    // "assume not registered" false, masking the devInspect mock entirely.
    const minerId = `0x${'1'.repeat(64)}`;
    const client = {
      getObject: vi.fn().mockResolvedValue({
        data: { content: { fields: { miner_id: minerId, role: '1' } } },
      }),
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[[1], 'bool']] }],
      }),
    };

    const result = await ensureRegistered(
      client as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    expect(result.validatorCapId).toBe('0xexisting-cap');
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });

  it('calls registration::register then validator_registry::register_validator when not set', async () => {
    delete process.env['VALIDATOR_CAP_ID'];

    mockExecuteWithRetry.mockResolvedValueOnce(step1Effects());
    mockExecuteWithRetry.mockResolvedValueOnce(step2Effects());

    const result = await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    // validatorCapId == minerCapId from Step 1 — register_validator creates nothing
    expect(result.validatorCapId).toBe('0xminer-cap');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    // First call should be registration::register
    const firstCallLabel = mockExecuteWithRetry.mock.calls[0]![3] as string;
    expect(firstCallLabel).toContain('registration::register');

    // Second call should be validator_registry::register_validator
    const secondCallLabel = mockExecuteWithRetry.mock.calls[1]![3] as string;
    expect(secondCallLabel).toContain('validator_registry::register_validator');
  });

  it('exits with error on registration failure (insufficient funds)', async () => {
    delete process.env['VALIDATOR_CAP_ID'];

    // Mock process.exit to throw instead of exiting
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    // Registration returns null (all retries exhausted)
    mockExecuteWithRetry.mockResolvedValueOnce(null);

    await expect(
      ensureRegistered(
        mockClient() as any,
        new Ed25519Keypair(),
        mockConfig(),
        mockLogger(),
      ),
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('uses executeWithRetry for all TX calls (DAEMON-07/DAEMON-12)', async () => {
    delete process.env['VALIDATOR_CAP_ID'];

    mockExecuteWithRetry.mockResolvedValueOnce(step1Effects());
    mockExecuteWithRetry.mockResolvedValueOnce(step2Effects());

    await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    // All TX calls must go through executeWithRetry
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);
    for (const call of mockExecuteWithRetry.mock.calls) {
      // Each call should pass: client, signer, buildTx, label, logger
      expect(call).toHaveLength(5);
      expect(typeof call[3]).toBe('string'); // label
    }
  });

  // ── Exits when Step 1 effects are missing MinerCap or StakePosition ─────────

  it('exits with error if Step 1 effects are missing MinerCap', async () => {
    delete process.env['VALIDATOR_CAP_ID'];
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    // Step 1 effects only return StakePosition — MinerCap absent
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest1',
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
      ensureRegistered(mockClient() as any, new Ed25519Keypair(), mockConfig(), mockLogger()),
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('exits with error if Step 1 effects are missing StakePosition', async () => {
    delete process.env['VALIDATOR_CAP_ID'];
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    // Step 1 effects only return MinerCap — StakePosition absent
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest1',
      effects: {
        created: [
          {
            reference: { objectId: '0xminer-cap' },
            objectType: '0xpkg::caps::MinerCap',
          },
        ],
      },
      events: [],
    });

    await expect(
      ensureRegistered(mockClient() as any, new Ed25519Keypair(), mockConfig(), mockLogger()),
    ).rejects.toThrow('process.exit(1)');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  // ── Arg-verification tests: capture buildTx and inspect moveCall args ────────

  it('Step 1 (registration::register): exactly 12 args, no MinerRole, strings use vector<u8>', async () => {
    delete process.env['VALIDATOR_CAP_ID'];

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    // Capture the buildTx function from the first executeWithRetry call (Step 1)
    const buildTxStep1 = mockExecuteWithRetry.mock.calls[0]![2] as (tx: any) => void;

    const moveCallArgs: unknown[][] = [];
    const vectorCalls: Array<[string, unknown]> = [];
    const mockTx = {
      gas: 'tx.gas',
      splitCoins: vi.fn().mockReturnValue(['mock-coin']),
      object: vi.fn((id: string) => ({ kind: 'object', id })),
      pure: {
        vector: vi.fn((type: string, val: unknown) => {
          vectorCalls.push([type, val]);
          return { kind: 'pure', type: 'vector', elemType: type, val };
        }),
        u8: vi.fn((val: number) => ({ kind: 'pure', type: 'u8', val })),
        u16: vi.fn((val: number) => ({ kind: 'pure', type: 'u16', val })),
        u64: vi.fn((val: number | bigint) => ({ kind: 'pure', type: 'u64', val })),
        string: vi.fn((val: string) => ({ kind: 'pure', type: 'string', val })),
      },
      moveCall: vi.fn((opts: { target: string; arguments: unknown[] }) => {
        moveCallArgs.push(opts.arguments);
      }),
    };

    buildTxStep1(mockTx);

    expect(mockTx.moveCall).toHaveBeenCalledTimes(1);
    const args = moveCallArgs[0]!;

    // Exactly 12 args (role determined on-chain by determine_role, not passed as arg)
    expect(args).toHaveLength(12);

    // tx.pure.string() must NEVER be called — all string fields use vector<u8>
    expect(mockTx.pure.string).not.toHaveBeenCalled();

    // All vector calls must use 'u8' element type (no other types)
    for (const [elemType] of vectorCalls) {
      expect(elemType).toBe('u8');
    }

    // Must have at least 4 vector<u8> calls: ip, stun_url, turn_url, region, turn_credential_hash
    expect(vectorCalls.length).toBeGreaterThanOrEqual(4);

    // port (arg 4) must use u16
    expect(mockTx.pure.u16).toHaveBeenCalled();
  });

  it('Step 2 (register_validator): exactly 4 args = [networkRegistryId, validatorRegistryId, minerCapId, stakePositionId]', async () => {
    delete process.env['VALIDATOR_CAP_ID'];
    const config = mockConfig();

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects());

    await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      config,
      mockLogger(),
    );

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

    // arg 0: networkRegistryId
    expect(args[0]).toEqual({ kind: 'object', id: config.networkRegistryId });
    // arg 1: validatorRegistryId
    expect(args[1]).toEqual({ kind: 'object', id: config.validatorRegistryId });
    // arg 2: minerCapId (from Step 1 effects — '0xminer-cap')
    expect(args[2]).toEqual({ kind: 'object', id: '0xminer-cap' });
    // arg 3: stakePositionId (from Step 1 effects — '0xstake-pos')
    expect(args[3]).toEqual({ kind: 'object', id: '0xstake-pos' });
  });

  it('validatorCapId equals minerCapId from Step 1 (register_validator creates no new objects)', async () => {
    delete process.env['VALIDATOR_CAP_ID'];

    mockExecuteWithRetry
      .mockResolvedValueOnce(step1Effects())
      .mockResolvedValueOnce(step2Effects()); // Step 2 has empty created array

    const result = await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    // validatorCapId must be the MinerCap from Step 1, not anything from Step 2
    expect(result.validatorCapId).toBe('0xminer-cap');
  });
});
