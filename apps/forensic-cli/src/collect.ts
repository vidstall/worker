/**
 * Forensic CLI — `collect` stage.
 *
 * Queries Sui RPC for events from specified modules and writes a canonical
 * JSONL transcript. One-shot mode: drains all available events then exits.
 *
 * Spec: docs/70-operations/forensic-cli.md § 5–6.
 */

import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SuiClient, SuiEvent, EventId } from '@mysten/sui/client';
import type { ForensicLine } from './types.js';

export interface CollectOptions {
  client: SuiClient;
  packageId: string;
  modules: string[];
  outPath: string;
  pageLimit?: number;
}

export interface CollectResult {
  modules: string[];
  totalEvents: number;
  perModule: Record<string, number>;
  outPath: string;
}

/** Convert a raw SuiEvent to a canonical ForensicLine. */
export function suiEventToForensicLine(ev: SuiEvent): ForensicLine {
  const tsMs = ev.timestampMs ? Number(ev.timestampMs) : 0;
  const ts = tsMs > 0 ? new Date(tsMs).toISOString() : '1970-01-01T00:00:00.000Z';

  const typeParts = ev.type.split('::');
  const module = typeParts[1] ?? 'unknown';
  const event = typeParts[typeParts.length - 1] ?? 'Unknown';

  return {
    schema: 'forensic-cli/1.0',
    ts,
    tx: ev.id.txDigest,
    seq: ev.id.eventSeq,
    module,
    event,
    payload: (ev.parsedJson ?? {}) as Record<string, unknown>,
  };
}

/**
 * Drain all events from one module, appending JSONL lines to outPath.
 * Returns count emitted.
 */
async function drainModule(
  client: SuiClient,
  packageId: string,
  module: string,
  outPath: string,
  pageLimit: number,
): Promise<number> {
  let count = 0;
  let cursor: EventId | null = null;
  let hasMore = true;

  while (hasMore) {
    const page = await client.queryEvents({
      query: { MoveEventModule: { package: packageId, module } },
      cursor: cursor ?? undefined,
      limit: pageLimit,
      order: 'ascending',
    });

    if (page.data.length > 0) {
      const lines = page.data.map((ev) => JSON.stringify(suiEventToForensicLine(ev))).join('\n') + '\n';
      await appendFile(outPath, lines, 'utf-8');
      count += page.data.length;
      cursor = page.nextCursor ?? cursor;
    }
    hasMore = page.hasNextPage;
  }

  return count;
}

/** Run the collect stage end-to-end. */
export async function collect(opts: CollectOptions): Promise<CollectResult> {
  const pageLimit = opts.pageLimit ?? 50;
  await mkdir(dirname(opts.outPath), { recursive: true });
  await writeFile(opts.outPath, '', 'utf-8'); // truncate

  const perModule: Record<string, number> = {};
  let total = 0;

  for (const m of opts.modules) {
    const n = await drainModule(opts.client, opts.packageId, m, opts.outPath, pageLimit);
    perModule[m] = n;
    total += n;
  }

  return {
    modules: opts.modules,
    totalEvents: total,
    perModule,
    outPath: opts.outPath,
  };
}
