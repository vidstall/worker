/**
 * Event poller with cursor-based pagination.
 *
 * Uses SuiClient.queryEvents (NOT the deprecated subscribeEvent).
 * Cursor is persisted to a JSON file for restart recovery.
 */

import type { SuiClient, SuiEvent, EventId } from '@mysten/sui/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Logger } from 'pino';

export interface EventPollerOptions {
  client: SuiClient;
  packageId: string;
  module: string;
  pollingIntervalMs: number;
  cursorPath?: string;
  logger: Logger;
}

export class EventPoller {
  private readonly client: SuiClient;
  private readonly packageId: string;
  private readonly module: string;
  private readonly pollingIntervalMs: number;
  private readonly cursorPath: string;
  private readonly logger: Logger;

  private cursor: EventId | null = null;
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
      const page = await this.client.queryEvents({
        query: {
          MoveEventModule: {
            package: this.packageId,
            module: this.module,
          },
        },
        cursor: this.cursor ?? undefined,
        limit: 50,
        order: 'ascending',
      });

      for (const event of page.data) {
        await handler(event);
      }

      if (page.data.length > 0 && page.nextCursor) {
        this.cursor = page.nextCursor;
        await this.saveCursor();
      }

      hasMore = page.hasNextPage;
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
      const parsed = JSON.parse(data) as { txDigest: string; eventSeq: string };
      if (parsed.txDigest && parsed.eventSeq) {
        this.cursor = parsed;
      }
    } catch {
      // No cursor file yet -- start from the beginning
      this.cursor = null;
    }
  }

  private async saveCursor(): Promise<void> {
    if (!this.cursor) return;
    try {
      await mkdir(dirname(this.cursorPath), { recursive: true });
      await writeFile(this.cursorPath, JSON.stringify(this.cursor), 'utf-8');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist cursor');
    }
  }
}
