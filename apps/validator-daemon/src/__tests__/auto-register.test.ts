/**
 * Tests for validator auto-registration flow.
 *
 * Verifies:
 * - Returns VALIDATOR_CAP_ID from env when set (skips registration)
 * - Calls registration::register then validator_registry::register_validator when not set
 * - Exits on registration failure
 * - Uses executeWithRetry for all TX calls (DAEMON-07/DAEMON-12)
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

describe('ensureRegistered', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockExecuteWithRetry.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns VALIDATOR_CAP_ID from env when set (skips registration)', async () => {
    process.env['VALIDATOR_CAP_ID'] = '0xexisting-cap';

    const result = await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    expect(result.validatorCapId).toBe('0xexisting-cap');
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });

  it('calls registration::register then validator_registry::register_validator when not set', async () => {
    delete process.env['VALIDATOR_CAP_ID'];

    // First call: miner registration succeeds
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest1',
      effects: {
        created: [{ reference: { objectId: '0xminer-cap-id' } }],
      },
      events: [],
    });

    // Second call: validator registration succeeds
    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest2',
      effects: {
        created: [{ reference: { objectId: '0xvalidator-cap-id' } }],
      },
      events: [],
    });

    const result = await ensureRegistered(
      mockClient() as any,
      new Ed25519Keypair(),
      mockConfig(),
      mockLogger(),
    );

    expect(result.validatorCapId).toBe('0xvalidator-cap-id');
    expect(mockExecuteWithRetry).toHaveBeenCalledTimes(2);

    // First call should be registration::register
    const firstCallLabel = mockExecuteWithRetry.mock.calls[0][3] as string;
    expect(firstCallLabel).toContain('registration::register');

    // Second call should be validator_registry::register_validator
    const secondCallLabel = mockExecuteWithRetry.mock.calls[1][3] as string;
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

    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest1',
      effects: { created: [{ reference: { objectId: '0xcap1' } }] },
      events: [],
    });

    mockExecuteWithRetry.mockResolvedValueOnce({
      digest: 'digest2',
      effects: { created: [{ reference: { objectId: '0xcap2' } }] },
      events: [],
    });

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
});
