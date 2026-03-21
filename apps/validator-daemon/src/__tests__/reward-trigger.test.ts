/**
 * Tests for reward-trigger functions: waitForProofs.
 *
 * Verifies:
 * - waitForProofs returns true when sufficient proofs exist on-chain
 * - waitForProofs returns false on timeout (insufficient proofs)
 * - waitForProofs handles missing proofs field gracefully (no crash)
 *
 * Coverage: ECON-01, ECON-02
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForProofs } from '../reward-trigger.js';
import type { Logger } from '@dvconf/shared';


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

