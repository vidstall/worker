/**
 * Event poller with cursor-based pagination.
 *
 * Uses SuiGraphQLClient's `events(filter:)` query (NOT the deprecated
 * JSON-RPC `queryEvents` / `subscribeEvent`). devnet's public fullnode
 * returns "Method not found" for `suix_queryEvents` -- see
 * https://docs.sui.io/develop/accessing-data/json-rpc-migration -- so this
 * class was migrated to GraphQL, which is Sui's documented queryEvents
 * replacement. Cursor is persisted to a JSON file for restart recovery;
 * note the cursor is now an OPAQUE STRING (GraphQL relay-style pagination
 * cursor), not the old `{txDigest, eventSeq}` object, so any pre-existing
 * cursor file from before this migration is incompatible and will be
 * discarded (loadCursor falls back to a full from-genesis replay).
 */

import type { SuiGraphQLClient, GraphQLQueryResult } from '@mysten/sui/graphql';
import type { SuiEvent } from '@mysten/sui/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

export interface EventPollerOptions {
  client: SuiGraphQLClient;
  packageId: string;
  module: string;
  pollingIntervalMs: number;
  cursorPath?: string;
  logger: Logger;
}

interface GraphQLEventNode {
  sender: { address: string } | null;
  sequenceNumber: number;
  timestamp: string | null;
  transactionModule: { package: { address: string }; name: string } | null;
  contents: { json: unknown; type: { repr: string } } | null;
}

interface EventsQueryResult {
  events: {
    nodes: GraphQLEventNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const EVENTS_QUERY = `
  query PollEvents($module: String!, $after: String) {
    events(filter: { module: $module }, after: $after, first: 50) {
      nodes {
        sender { address }
        sequenceNumber
        timestamp
        transactionModule { package { address } name }
        contents { json type { repr } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

/**
 * Adapt a GraphQL event node back into the JSON-RPC SuiEvent shape so
 * every existing handler (event-handler.ts and friends) is untouched.
 */
function toSuiEvent(node: GraphQLEventNode, cursor: string): SuiEvent {
  const timestampMs = node.timestamp ? String(Date.parse(node.timestamp)) : '0';
  return {
    id: { txDigest: cursor, eventSeq: String(node.sequenceNumber) },
    packageId: node.transactionModule?.package.address ?? '',
    transactionModule: node.transactionModule?.name ?? '',
    sender: node.sender?.address ?? '',
    type: node.contents?.type.repr ?? '',
    parsedJson: node.contents?.json ?? {},
    bcs: '',
    timestampMs,
  } as unknown as SuiEvent;
}

/**
 * One-shot paginated fetch of ALL historical events for a module (no cursor
 * persistence) -- for bootstrap-replay call sites that used to call
 * `client.queryEvents(...)` directly instead of going through EventPoller.
 */
export async function queryHistoricalEvents(
  client: SuiGraphQLClient,
  packageId: string,
  module: string,
  maxEvents = 100,
): Promise<SuiEvent[]> {
  const events: SuiEvent[] = [];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore && events.length < maxEvents) {
    const result: GraphQLQueryResult<EventsQueryResult> = await client.query<
      EventsQueryResult,
      { module: string; after: string | null }
    >({
      query: EVENTS_QUERY,
      variables: { module: `${packageId}::${module}`, after: cursor },
    });

    if (result.errors && result.errors.length > 0) {
      throw new Error(
        `GraphQL events query failed: ${result.errors.map((e: { message: string }) => e.message).join('; ')}`,
      );
    }

    const page = result.data?.events;
    if (!page) {
      throw new Error('GraphQL events query returned no data');
    }

    for (const node of page.nodes) {
      events.push(toSuiEvent(node, page.pageInfo.endCursor ?? cursor ?? ''));
    }

    cursor = page.pageInfo.endCursor;
    hasMore = page.pageInfo.hasNextPage;
  }

  return events;
}

export class EventPoller {
  private readonly client: SuiGraphQLClient;
  private readonly packageId: string;
  private readonly module: string;
  private readonly pollingIntervalMs: number;
  private readonly cursorPath: string;
  private readonly logger: Logger;

  private cursor: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(options: EventPollerOptions) {
    this.client = options.client;
    this.packageId = options.packageId;
    this.module = options.module;
    this.pollingIntervalMs = options.pollingIntervalMs;
    this.cursorPath = options.cursorPath ?? 'cursor.json';
    this.logger = options.logger;
  }

  /** Start polling. Calls handler for each event in order. */
  async start(handler: (event: SuiEvent) => Promise<void>): Promise<void> {
    this.running = true;
    await this.loadCursor();
    this.logger.info(
      { module: this.module, cursor: this.cursor },
      'EventPoller started',
    );
    this.poll(handler);
  }

  /** Stop polling. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.logger.info({ module: this.module }, 'EventPoller stopped');
  }

  /** Single poll cycle -- exported for testing. */
  async pollOnce(handler: (event: SuiEvent) => Promise<void>): Promise<void> {
    let hasMore = true;

    while (hasMore) {
      const result = await this.client.query<EventsQueryResult, { module: string; after: string | null }>({
        query: EVENTS_QUERY,
        variables: {
          module: `${this.packageId}::${this.module}`,
          after: this.cursor,
        },
      });

      if (result.errors && result.errors.length > 0) {
        throw new Error(`GraphQL events query failed: ${result.errors.map((e) => e.message).join('; ')}`);
      }

      const page = result.data?.events;
      if (!page) {
        throw new Error('GraphQL events query returned no data');
      }

      for (const node of page.nodes) {
        await handler(toSuiEvent(node, page.pageInfo.endCursor ?? this.cursor ?? ''));
      }

      if (page.nodes.length > 0 && page.pageInfo.endCursor) {
        this.cursor = page.pageInfo.endCursor;
        await this.saveCursor();
      }

      hasMore = page.pageInfo.hasNextPage;
    }
  }

  private poll(handler: (event: SuiEvent) => Promise<void>): void {
    if (!this.running) return;

    this.pollOnce(handler)
      .then(() => {
        if (this.running) {
          this.timer = setTimeout(
            () => this.poll(handler),
            this.pollingIntervalMs,
          );
        }
      })
      .catch((err) => {
        this.logger.error({ err }, 'EventPoller error, retrying');
        if (this.running) {
          this.timer = setTimeout(
            () => this.poll(handler),
            this.pollingIntervalMs,
          );
        }
      });
  }

  private async loadCursor(): Promise<void> {
    try {
      const data = await readFile(this.cursorPath, 'utf-8');
      const parsed = JSON.parse(data) as { cursor?: string };
      this.cursor = parsed.cursor ?? null;
    } catch {
      // No cursor file yet -- start from the beginning
      this.cursor = null;
    }
  }

  private async saveCursor(): Promise<void> {
    if (!this.cursor) return;
    try {
      await mkdir(dirname(this.cursorPath), { recursive: true });
      await writeFile(this.cursorPath, JSON.stringify({ cursor: this.cursor }), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist cursor');
    }
  }
}
