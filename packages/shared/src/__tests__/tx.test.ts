/**
 * Tests for executeWithRetry — TX wrapper with exponential backoff.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeWithRetry } from '../chain/tx.js';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger } from 'pino';

// Mock SuiClient
function createMockClient(
  signResult: { digest: string; effects: object; events: object[] } | Error,
  failCount = 0,
) {
  let callCount = 0;
  return {
    signAndExecuteTransaction: vi.fn(async () => {
      callCount++;
      if (callCount <= failCount) {
        throw new Error('RPC error');
      }
      if (signResult instanceof Error) throw signResult;
      return signResult;
    }),
    waitForTransaction: vi.fn(async () => ({})),
  } as unknown as SuiClient;
}

// Mock signer
const mockSigner = {} as Ed25519Keypair;

// Mock logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Speed up tests by using fake timers for backoff
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe('executeWithRetry', () => {
  it('succeeds on first try', async () => {
    const client = createMockClient({
      digest: 'test-digest-1',
      effects: { status: { status: 'success' } },
      events: [{ type: 'test' }],
    });

    const resultPromise = executeWithRetry(
      client,
      mockSigner,
      (tx) => {
        tx.moveCall({ target: '0x1::test::fn', arguments: [] });
      },
      'test-tx',
      mockLogger,
    );

    // Advance timers to resolve any pending delays
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(result).not.toBeNull();
    expect(result!.digest).toBe('test-digest-1');
    expect(client.signAndExecuteTransaction).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ digest: 'test-digest-1', attempt: 1 }),
      'test-tx succeeded',
    );
  });

  it('fails then succeeds on retry', async () => {
    const client = createMockClient(
      {
        digest: 'retry-digest',
        effects: {},
        events: [],
      },
      2, // fail first 2 attempts
    );

    const resultPromise = executeWithRetry(
      client,
      mockSigner,
      () => {},
      'retry-tx',
      mockLogger,
    );

    // First failure: 1s backoff
    await vi.advanceTimersByTimeAsync(1_000);
    // Second failure: 2s backoff
    await vi.advanceTimersByTimeAsync(2_000);
    // Third attempt succeeds
    await vi.advanceTimersByTimeAsync(0);

    const result = await resultPromise;

    expect(result).not.toBeNull();
    expect(result!.digest).toBe('retry-digest');
    expect(client.signAndExecuteTransaction).toHaveBeenCalledTimes(3);
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries and returns null', async () => {
    const client = createMockClient(new Error('permanent failure'));

    const resultPromise = executeWithRetry(
      client,
      mockSigner,
      () => {},
      'fail-tx',
      mockLogger,
    );

    // Advance through all retry backoffs: 1s, 2s, 4s, 8s
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(0);

    const result = await resultPromise;

    expect(result).toBeNull();
    expect(client.signAndExecuteTransaction).toHaveBeenCalledTimes(5);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'fail-tx exhausted retries, skipping',
    );
  });

  it('backoff delays increase correctly (1s, 2s, 4s, 8s capped at 30s)', async () => {
    // We verify the warn logs contain increasing delays
    const client = createMockClient(new Error('keep failing'));

    const resultPromise = executeWithRetry(
      client,
      mockSigner,
      () => {},
      'backoff-tx',
      mockLogger,
    );

    // Process all retries
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
    }

    await resultPromise;

    // Check warn calls have increasing delays
    // Cast warn to vi.Mock to access .mock.calls (mockLogger is typed as Logger, but warn is a vi.fn()).
    const warnCalls = (mockLogger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ delay: number; attempt: number }, string]
    >;
    const delays = warnCalls
      .filter(
        (call): call is [{ delay: number; attempt: number }, string] =>
          typeof call[0] === 'object' && 'delay' in call[0],
      )
      .map((call) => call[0].delay);

    // Delays should be: 1000, 2000, 4000, 8000 (4 warn calls, 5th is error)
    expect(delays[0]).toBe(1_000);
    expect(delays[1]).toBe(2_000);
    expect(delays[2]).toBe(4_000);
    expect(delays[3]).toBe(8_000);
  });
});
