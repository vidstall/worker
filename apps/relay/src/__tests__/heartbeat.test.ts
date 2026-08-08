/**
 * Unit tests for relay daemon heartbeat + load reporting.
 *
 * After F40 (heartbeat-age miscalc BUG fix), relay daemon must emit a
 * combined PTB containing BOTH:
 *   1. relay_registry::relay_heartbeat (liveness signal, writes last_heartbeat)
 *   2. relay_registry::update_load (current load reporting, unchanged)
 *
 * Previously the daemon called only update_load and (incorrectly) treated
 * it as the liveness signal. The on-chain fix added a dedicated relay_heartbeat
 * entry mirroring signaling_registry::heartbeat.
 *
 * Requirements: RELAY-05, F40
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

import {
  buildHeartbeatTx,
  buildUpdateLoadTx,
  startHeartbeat,
} from '../heartbeat.js';
import type { MetricsTracker } from '../metrics.js';

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
    roleVoteBoxId: '0xvotebox',
    roleVotingPackageId: '0xrolevotingpkg',
    livenessVoteBoxId: '0xlivenessbox',
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

describe('relay heartbeat — F40 combined PTB', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('buildHeartbeatTx', () => {
    it('targets relay_registry::relay_heartbeat with 3 args (no load)', () => {
      const { tx, moveCalls } = makeMockTx();
      const config = mockConfig();

      buildHeartbeatTx(tx as any, config, '0xminer-cap');

      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0]!.target).toBe('0xpkg::relay_registry::relay_heartbeat');
      expect(moveCalls[0]!.arguments).toHaveLength(3);
      expect(moveCalls[0]!.arguments[0]).toEqual({ kind: 'object', id: '0xreg' });
      expect(moveCalls[0]!.arguments[1]).toEqual({ kind: 'object', id: '0xrelay' });
      expect(moveCalls[0]!.arguments[2]).toEqual({ kind: 'object', id: '0xminer-cap' });
    });
  });

  describe('buildUpdateLoadTx (unchanged)', () => {
    it('targets relay_registry::update_load with 4 args (incl load u64)', () => {
      const { tx, moveCalls } = makeMockTx();
      const config = mockConfig();

      buildUpdateLoadTx(tx as any, config, '0xminer-cap', 42);

      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0]!.target).toBe('0xpkg::relay_registry::update_load');
      expect(moveCalls[0]!.arguments).toHaveLength(4);
      expect(moveCalls[0]!.arguments[3]).toEqual({ kind: 'pure', type: 'u64', val: 42 });
    });
  });

  describe('startHeartbeat — combined PTB', () => {
    it('first heartbeat call produces a PTB containing BOTH heartbeat AND update_load moveCalls', async () => {
      mockExecuteWithRetry.mockResolvedValue({ digest: 'd1' });

      const metrics = {
        getActiveSessionCount: () => 3,
      } as unknown as MetricsTracker;

      const stop = startHeartbeat(
        {} as any,
        {} as any,
        mockConfig(),
        '0xminer-cap',
        metrics,
        () => 2, // getRoomCount
        30000,
        mockLogger(),
      );

      // Allow the immediate sendHeartbeat() promise to settle
      await vi.waitFor(() => {
        expect(mockExecuteWithRetry).toHaveBeenCalledTimes(1);
      });

      // Inspect the build callback (3rd arg of executeWithRetry)
      const buildTx = mockExecuteWithRetry.mock.calls[0]![2] as (tx: any) => void;
      const { tx, moveCalls } = makeMockTx();
      buildTx(tx);

      // BOTH calls present: heartbeat + update_load
      expect(moveCalls).toHaveLength(2);

      const targets = moveCalls.map((c) => c.target);
      expect(targets).toContain('0xpkg::relay_registry::relay_heartbeat');
      expect(targets).toContain('0xpkg::relay_registry::update_load');

      // Ensure label is 'relay-heartbeat'
      expect(mockExecuteWithRetry).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.any(Function),
        'relay-heartbeat',
        expect.anything(),
      );

      stop();
    });
  });
});
