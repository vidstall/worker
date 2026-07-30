/**
 * Tests for EventPoller — cursor-based event polling via GraphQL
 * (`events(filter:)`). Migrated off the deprecated JSON-RPC `queryEvents`,
 * which devnet's public fullnode no longer supports — see events.ts's
 * module docstring.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventPoller, fetchEventsForDigest } from '../chain/events.js';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { SuiEvent } from '@mysten/sui/client';
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

function makeGraphQLNode(cursor: string, seq: number) {
  return {
    sender: { address: '0xsender' },
    sequenceNumber: seq,
    timestamp: '2026-01-01T00:00:00.000Z',
    transactionModule: { package: { address: '0xpkg' }, name: 'registration' },
    contents: {
      json: { miner_id: '0xm1', owner: '0xo1', role: 0, stake_amount: '1000' },
      type: { repr: '0xpkg::registration::MinerRegistered' },
    },
  };
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
    const nodes = [makeGraphQLNode('c0', 0), makeGraphQLNode('c1', 1), makeGraphQLNode('c2', 2)];
    const mockClient = {
      query: vi.fn(async () => ({
        data: { events: { nodes, pageInfo: { hasNextPage: false, endCursor: 'c2' } } },
      })),
    } as unknown as SuiGraphQLClient;

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
    expect(received[0]!.type).toBe('0xpkg::registration::MinerRegistered');
    expect(received[2]!.id.eventSeq).toBe('2');
  });

  it('handles empty results (no events)', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        data: { events: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      })),
    } as unknown as SuiGraphQLClient;

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
    expect(mockClient.query).toHaveBeenCalledTimes(1);
  });

  it('follows hasNextPage pagination', async () => {
    let callCount = 0;
    const mockClient = {
      query: vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            data: {
              events: {
                nodes: [makeGraphQLNode('page1', 0)],
                pageInfo: { hasNextPage: true, endCursor: 'page1' },
              },
            },
          };
        }
        return {
          data: {
            events: {
              nodes: [makeGraphQLNode('page2', 0)],
              pageInfo: { hasNextPage: false, endCursor: 'page2' },
            },
          },
        };
      }),
    } as unknown as SuiGraphQLClient;

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

    // Should have made 2 query calls (followed hasNextPage)
    expect(mockClient.query).toHaveBeenCalledTimes(2);
    expect(received).toHaveLength(2);
    expect(received[0]!.id.txDigest).toBe('page1');
    expect(received[1]!.id.txDigest).toBe('page2');
  });

  it('persists cursor to file', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        data: {
          events: {
            nodes: [makeGraphQLNode('persist-cursor', 5)],
            pageInfo: { hasNextPage: false, endCursor: 'persist-cursor' },
          },
        },
      })),
    } as unknown as SuiGraphQLClient;

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
    expect(cursorData.cursor).toBe('persist-cursor');
  });
});

describe('fetchEventsForDigest', () => {
  it('maps transactionEffects.events.nodes to SuiEvent[], keyed by the real digest', async () => {
    const mockClient = {
      query: vi.fn(async (opts: { variables: { digest: string } }) => ({
        data: {
          transactionEffects: {
            events: { nodes: [makeGraphQLNode(opts.variables.digest, 0)] },
          },
        },
      })),
    } as unknown as SuiGraphQLClient;

    const events = await fetchEventsForDigest(mockClient, 'ABC123');

    expect(mockClient.query).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('0xpkg::registration::MinerRegistered');
    expect(events[0]!.id.txDigest).toBe('ABC123');
    expect(events[0]!.id.eventSeq).toBe('0');
  });

  it('returns an empty array when the transaction has no events', async () => {
    const mockClient = {
      query: vi.fn(async () => ({
        data: { transactionEffects: { events: { nodes: [] } } },
      })),
    } as unknown as SuiGraphQLClient;

    const events = await fetchEventsForDigest(mockClient, 'EMPTY');
    expect(events).toHaveLength(0);
  });

  it('returns an empty array when transactionEffects is missing', async () => {
    const mockClient = {
      query: vi.fn(async () => ({ data: { transactionEffects: null } })),
    } as unknown as SuiGraphQLClient;

    const events = await fetchEventsForDigest(mockClient, 'MISSING');
    expect(events).toHaveLength(0);
  });

  it('throws when the GraphQL response carries errors', async () => {
    const mockClient = {
      query: vi.fn(async () => ({ errors: [{ message: 'boom' }] })),
    } as unknown as SuiGraphQLClient;

    await expect(fetchEventsForDigest(mockClient, 'ERR')).rejects.toThrow('GraphQL transaction-events query failed');
  });
});
