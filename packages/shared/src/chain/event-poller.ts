/**
 * Event poller with cursor-based pagination.
 *
 * Pure extraction from chain/events.ts. See that file's barrel doc for the
 * GraphQL-vs-JSON-RPC migration background. Cursor is persisted to a JSON
 * file for restart recovery; note the cursor is an OPAQUE STRING (GraphQL
 * relay-style pagination cursor), not the old `{txDigest, eventSeq}` object,
 * so any pre-existing cursor file from before that migration is incompatible
 * and will be discarded (loadCursor falls back to a full from-genesis replay).
 */

import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { SuiEvent } from '@mysten/sui/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';
import type { Histogram, Counter } from 'prom-client';
import type { Registry } from '../metrics-prom.js';
import { createDurationHistogram, createCounter } from '../metrics-prom.js';
import { EVENTS_QUERY, toSuiEvent, type EventsQueryResult } from './event-poller-graphql.js';

// Same opt-in, module-level pattern as chain/tx.ts's registerTxMetrics --
// every EventPoller instance in a process shares this one registration
// (one call per daemon at startup), labeled per-instance by its own
// `module` (e.g. "registration", "room_manager") rather than needing a
// registry threaded through the constructor.
let pollerMetrics: { duration: Histogram<string>; processed: Counter<string>; service: string } | null = null;

/**
 * Wire `dvconf_chain_poll_duration_seconds{service,module}` and
 * `dvconf_chain_events_processed_total{service,module}` into `registry` --
 * called once per daemon process, not per EventPoller instance.
 */
export function registerEventPollerMetrics(registry: Registry, service: string): void {
  pollerMetrics = {
    service,
    duration: createDurationHistogram(
      registry,
      'dvconf_chain_poll_duration_seconds',
      'Wall-clock duration of one EventPoller.pollOnce() cycle (all pages)',
      ['service', 'module'],
    ),
    processed: createCounter(
      registry,
      'dvconf_chain_events_processed_total',
      'Events handled across all EventPoller.pollOnce() cycles',
      ['service', 'module'],
    ),
  };
}

export interface EventPollerOptions {
  client: SuiGraphQLClient;
  /**
   * The package that ORIGINALLY defined the event struct(s) emitted by
   * `module` -- i.e. NetworkConfig.originalPackageId, NOT the latest
   * upgraded packageId. See the comment on EVENTS_QUERY for why: the
   * query filters on the event's stable type, which is pinned to this
   * package forever, not on which package version was executing.
   */
  packageId: string;
  module: string;
  pollingIntervalMs: number;
  cursorPath?: string;
  logger: Logger;
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
  // Tracks the in-flight poll cycle (including its cursor-save write) so
  // `stop()` can be awaited to completion -- without this, a caller that
  // stops the poller as part of a self-shutdown/process.exit sequence can
  // race an in-flight saveCursor() write, truncating the cursor file (a
  // truncated/unparseable cursor reads back as "no cursor" on next boot,
  // forcing a full replay from genesis -- for a self-shutdown arm gated on
  // `meta.replayed` this becomes a re-trigger, not a one-time recovery).
  private inFlight: Promise<void> = Promise.resolve();

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

  /**
   * Stop polling. Awaits the in-flight poll cycle (if any) so a caller that
   * immediately exits the process afterward can't race an in-progress
   * cursor-save write (see the `inFlight` field doc above).
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.inFlight;
    this.logger.info({ module: this.module }, 'EventPoller stopped');
  }

  /** Single poll cycle -- exported for testing. */
  async pollOnce(handler: (event: SuiEvent) => Promise<void>): Promise<void> {
    const t0 = Date.now();
    let eventsProcessed = 0;
    let hasMore = true;

    try {
      while (hasMore) {
        const result = await this.client.query<EventsQueryResult, { eventType: string; after: string | null }>({
          query: EVENTS_QUERY,
          variables: {
            eventType: `${this.packageId}::${this.module}`,
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
          eventsProcessed++;
        }

        if (page.nodes.length > 0 && page.pageInfo.endCursor) {
          this.cursor = page.pageInfo.endCursor;
          await this.saveCursor();
        }

        hasMore = page.pageInfo.hasNextPage;
      }
    } finally {
      if (pollerMetrics) {
        pollerMetrics.duration.observe({ service: pollerMetrics.service, module: this.module }, (Date.now() - t0) / 1000);
        if (eventsProcessed > 0) {
          pollerMetrics.processed.inc({ service: pollerMetrics.service, module: this.module }, eventsProcessed);
        }
      }
    }
  }

  private poll(handler: (event: SuiEvent) => Promise<void>): void {
    if (!this.running) return;

    this.inFlight = this.pollOnce(handler)
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
