/**
 * Unit tests for validator daemon heartbeat loop.
 *
 * F40 added a dedicated validator_registry::heartbeat entry (mirroring
 * signaling_registry::heartbeat). The validator daemon previously had NO
 * heartbeat path; this test asserts the new heartbeat module emits the
 * correct single-moveCall PTB at the configured cadence.
 *
 * Validator daemon does NOT have an update_load path on-chain (validators
 * have no load concept), so only ONE moveCall is expected in the PTB.
 *
 * Requirements: F40
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
    signalingRegistryId: '0xsig',
    roleVoteBoxId: '0xvotebox',
  };
}

function makeMockTx() {
  const moveCalls: { target: string; arguments: unknown[] }[] = [];
  const tx = {
    object: vi.fn((id: string) => ({ kind: 'object', id })),
    pure: {
      u64: vi.fn((v: number | bigint) => ({ kind: 'pure', type: 'u64', val: v })),
    },
    moveCall: vi.fn((opts: { target: string; arguments: unknown[] }) => {
      moveCalls.push(opts);
    }),
  };
  return { tx, moveCalls };
}

describe('validator heartbeat — F40 new path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buildHeartbeatTx', () => {
    it('targets validator_registry::heartbeat with 3 args (no load)', () => {
      const { tx, moveCalls } = makeMockTx();
      const config = mockConfig();

      buildHeartbeatTx(tx as any, config, '0xminer-cap');

      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0]!.target).toBe('0xpkg::validator_registry::heartbeat');
      expect(moveCalls[0]!.arguments).toHaveLength(3);
      expect(moveCalls[0]!.arguments[0]).toEqual({ kind: 'object', id: '0xreg' });
      expect(moveCalls[0]!.arguments[1]).toEqual({ kind: 'object', id: '0xval' });
      expect(moveCalls[0]!.arguments[2]).toEqual({ kind: 'object', id: '0xminer-cap' });
    });
  });

  describe('startHeartbeat', () => {
    it('first heartbeat emits ONLY heartbeat moveCall (no update_load — validator has no load path)', async () => {
      mockExecuteWithRetry.mockResolvedValue({ digest: 'd1' });

      const stop = startHeartbeat(
        {} as any,
        {} as any,
        mockConfig(),
        '0xminer-cap',
        30000,
        mockLogger(),
      );

      await vi.waitFor(() => {
        expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
      });

      const buildTx = mockExecuteWithRetry.mock.calls[0]![2] as (tx: any) => void;
      const { tx, moveCalls } = makeMockTx();
      buildTx(tx);

      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0]!.target).toBe('0xpkg::validator_registry::heartbeat');

      expect(mockExecuteWithRetry).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.any(Function),
        'validator-heartbeat',
        expect.anything(),
      );

      stop();
    });

    it('returned stop function clears the interval (no further calls after stop)', async () => {
      mockExecuteWithRetry.mockResolvedValue({ digest: 'd1' });

      const stop = startHeartbeat(
        {} as any,
        {} as any,
        mockConfig(),
        '0xminer-cap',
        30000,
        mockLogger(),
      );

      await vi.waitFor(() => {
        expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
      });

      stop();
      const callsAfterStop = mockExecuteWithRetry.mock.calls.length;

      // Advance time well past the interval
      await vi.advanceTimersByTimeAsync(60000);

      expect(mockExecuteWithRetry).toHaveBeenCalledTimes(callsAfterStop);
    });
  });
});
