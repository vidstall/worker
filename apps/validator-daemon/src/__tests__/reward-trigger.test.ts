/**
 * Tests for reward-trigger functions: waitForProofs and lookupRelayStakeId.
 *
 * Verifies:
 * - waitForProofs returns true when sufficient proofs exist on-chain
 * - waitForProofs returns false on timeout (insufficient proofs)
 * - waitForProofs handles missing proofs field gracefully (no crash)
 * - lookupRelayStakeId resolves operator address via devInspect then finds StakePosition
 * - lookupRelayStakeId returns undefined when no stake found
 *
 * Coverage: ECON-01, ECON-02
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForProofs, lookupRelayStakeId } from '../reward-trigger.js';
import type { Logger } from '@dvconf/shared';

// ── Mock Transaction class ──────────────────────────────────────────────────
// lookupRelayStakeId creates a Transaction internally, so we mock the module.
const mockMoveCall = vi.fn().mockReturnValue('mock-move-call-result');
const mockObject = vi.fn((id: string) => ({ kind: 'object', id }));
const mockPureId = vi.fn((id: string) => ({ kind: 'pure', id }));

vi.mock('@mysten/sui/transactions', () => {
  return {
    Transaction: vi.fn().mockImplementation(() => ({
      moveCall: mockMoveCall,
      object: mockObject,
      pure: { id: mockPureId },
    })),
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock logger (same pattern as auto-register.test.ts). */
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

/** Build a mock SuiClient with configurable method stubs. */
function mockClient(overrides: Record<string, unknown> = {}): any {
  return {
    getObject: vi.fn(),
    devInspectTransactionBlock: vi.fn(),
    getOwnedObjects: vi.fn(),
    ...overrides,
  };
}

// ── waitForProofs ────────────────────────────────────────────────────────────

describe('waitForProofs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns true when sufficient proofs are present', async () => {
    const client = mockClient();
    const logger = mockLogger();

    // Mock getObject returning an escrow with 2 proofs
    client.getObject.mockResolvedValue({
      data: {
        content: {
          dataType: 'moveObject',
          fields: {
            proofs: [{}, {}],
          },
        },
      },
    });

    const result = await waitForProofs(client, '0xescrow1', 2, 10_000, logger);
    expect(result).toBe(true);
    expect(client.getObject).toHaveBeenCalledWith({
      id: '0xescrow1',
      options: { showContent: true },
    });
  });

  it('returns false when insufficient proofs and timeout elapses', async () => {
    const client = mockClient();
    const logger = mockLogger();

    // Mock getObject returning escrow with 0 proofs (always)
    client.getObject.mockResolvedValue({
      data: {
        content: {
          dataType: 'moveObject',
          fields: {
            proofs: [],
          },
        },
      },
    });

    // Start the waitForProofs with a short timeout
    const promise = waitForProofs(client, '0xescrow1', 2, 100, logger);

    // Advance timers past the timeout
    await vi.advanceTimersByTimeAsync(6_000);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('returns false when proofs field is missing (no crash)', async () => {
    const client = mockClient();
    const logger = mockLogger();

    // Mock getObject returning a MoveObject but with NO proofs field
    client.getObject.mockResolvedValue({
      data: {
        content: {
          dataType: 'moveObject',
          fields: {
            // no 'proofs' key at all
            status: 'active',
          },
        },
      },
    });

    // With no proofs field, proofCount = 0, which is < minProofs=1,
    // so it polls until timeout. Use a very short timeout.
    const promise = waitForProofs(client, '0xescrow1', 1, 100, logger);
    await vi.advanceTimersByTimeAsync(6_000);

    const result = await promise;
    expect(result).toBe(false);
  });
});

// ── lookupRelayStakeId ───────────────────────────────────────────────────────

describe('lookupRelayStakeId', () => {
  beforeEach(() => {
    mockMoveCall.mockClear();
    mockObject.mockClear();
    mockPureId.mockClear();
  });

  const config = {
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
  };

  it('returns StakePosition ID when relay operator and stake are found', async () => {
    const logger = mockLogger();

    // Build a 32-byte operator address (all 0x01 bytes)
    const operatorBytes = new Array(32).fill(1);
    const expectedAddress =
      '0x' + operatorBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');

    const client = mockClient({
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [
          // results[0] = borrow_info (we don't use this)
          { returnValues: [] },
          // results[1] = info_operator returns address bytes
          {
            returnValues: [
              [operatorBytes, 'address'],
            ],
          },
        ],
      }),
      getOwnedObjects: vi.fn().mockResolvedValue({
        data: [
          {
            data: {
              objectId: '0xstake-position-abc',
              type: `${config.packageId}::staking::StakePosition`,
            },
          },
        ],
      }),
    });

    const result = await lookupRelayStakeId(client, config, '0xrelay-miner-1', logger);

    expect(result).toBe('0xstake-position-abc');

    // Verify devInspect was called
    expect(client.devInspectTransactionBlock).toHaveBeenCalledTimes(1);

    // Verify getOwnedObjects was called with the resolved operator address
    expect(client.getOwnedObjects).toHaveBeenCalledWith({
      owner: expectedAddress,
      options: { showType: true },
      filter: { StructType: `${config.packageId}::staking::StakePosition` },
    });
  });

  it('returns undefined when operator found but no StakePosition exists', async () => {
    const logger = mockLogger();

    const operatorBytes = new Array(32).fill(0xab);

    const client = mockClient({
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [
          { returnValues: [] },
          {
            returnValues: [
              [operatorBytes, 'address'],
            ],
          },
        ],
      }),
      getOwnedObjects: vi.fn().mockResolvedValue({
        data: [], // empty — no StakePosition owned
      }),
    });

    const result = await lookupRelayStakeId(client, config, '0xrelay-miner-2', logger);

    expect(result).toBeUndefined();
    expect(client.getOwnedObjects).toHaveBeenCalledTimes(1);

    // Should log a warning about missing StakePosition
    expect(logger.warn).toHaveBeenCalled();
  });
});
