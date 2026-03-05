/**
 * Tests for EventPoller — cursor-based event polling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventPoller } from '../chain/events.js';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Logger } from 'pino';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function makeSuiEvent(id: string, seq: string): SuiEvent {
  return {
    id: { txDigest: id, eventSeq: seq },
    packageId: '0xpkg',
    transactionModule: 'registration',
    sender: '0xsender',
    type: '0xpkg::registration::MinerRegistered',
    parsedJson: { miner_id: '0xm1', owner: '0xo1', role: 0, stake_amount: '1000' },
    bcs: '',
    timestampMs: '1000',
  } as unknown as SuiEvent;
}

describe('EventPoller', () => {
  let cursorPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cursorPath = join(tmpdir(), `cursor-test-${Date.now()}.json`);
  });

  afterEach(async () => {
    try {
      await unlink(cursorPath);
    } catch {
      // ignore
    }
  });

  it('processes events in order', async () => {
    const events = [
      makeSuiEvent('tx1', '0'),
      makeSuiEvent('tx1', '1'),
      makeSuiEvent('tx2', '0'),
    ];

    const mockClient = {
      queryEvents: vi.fn(async () => ({
        data: events,
        nextCursor: { txDigest: 'tx2', eventSeq: '0' },
        hasNextPage: false,
      })),
    } as unknown as SuiClient;

    const poller = new EventPoller({
      client: mockClient,
      packageId: '0xpkg',
      module: 'registration',
      pollingIntervalMs: 1000,
      cursorPath,
      logger: mockLogger,
    });

    const received: SuiEvent[] = [];
    await poller.pollOnce(async (event) => {
      received.push(event);
    });

    expect(received).toHaveLength(3);
    expect(received[0]!.id.txDigest).toBe('tx1');
    expect(received[0]!.id.eventSeq).toBe('0');
    expect(received[2]!.id.txDigest).toBe('tx2');
  });

  it('handles empty results (no events)', async () => {
    const mockClient = {
      queryEvents: vi.fn(async () => ({
        data: [],
        nextCursor: null,
        hasNextPage: false,
      })),
    } as unknown as SuiClient;

    const poller = new EventPoller({
      client: mockClient,
      packageId: '0xpkg',
      module: 'registration',
      pollingIntervalMs: 1000,
      cursorPath,
      logger: mockLogger,
    });

    const received: SuiEvent[] = [];
    await poller.pollOnce(async (event) => {
      received.push(event);
    });

    expect(received).toHaveLength(0);
    expect(mockClient.queryEvents).toHaveBeenCalledTimes(1);
  });

  it('follows hasNextPage pagination', async () => {
    let callCount = 0;
    const mockClient = {
      queryEvents: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            data: [makeSuiEvent('page1', '0')],
            nextCursor: { txDigest: 'page1', eventSeq: '0' },
            hasNextPage: true,
          };
        }
        return {
          data: [makeSuiEvent('page2', '0')],
          nextCursor: { txDigest: 'page2', eventSeq: '0' },
          hasNextPage: false,
        };
      }),
    } as unknown as SuiClient;

    const poller = new EventPoller({
      client: mockClient,
      packageId: '0xpkg',
      module: 'registration',
      pollingIntervalMs: 1000,
      cursorPath,
      logger: mockLogger,
    });

    const received: SuiEvent[] = [];
    await poller.pollOnce(async (event) => {
      received.push(event);
    });

    // Should have made 2 queryEvents calls (followed hasNextPage)
    expect(mockClient.queryEvents).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);
    expect(received[0]!.id.txDigest).toBe('page1');
    expect(received[1]!.id.txDigest).toBe('page2');
  });

  it('persists cursor to file', async () => {
    const mockClient = {
      queryEvents: vi.fn(async () => ({
        data: [makeSuiEvent('persist-tx', '5')],
        nextCursor: { txDigest: 'persist-tx', eventSeq: '5' },
        hasNextPage: false,
      })),
    } as unknown as SuiClient;

    const poller = new EventPoller({
      client: mockClient,
      packageId: '0xpkg',
      module: 'registration',
      pollingIntervalMs: 1000,
      cursorPath,
      logger: mockLogger,
    });

    await poller.pollOnce(async () => {});

    // Read the cursor file and verify
    const cursorData = JSON.parse(await readFile(cursorPath, 'utf-8'));
    expect(cursorData.txDigest).toBe('persist-tx');
    expect(cursorData.eventSeq).toBe('5');
  });
});
