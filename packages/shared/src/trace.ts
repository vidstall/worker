/**
 * Cross-daemon trace primitive (P17 M1 / F63, DOH-001/003/004).
 *
 * Single source of truth for the `x-trace-id` header name, the honor-or-generate
 * read at server entry, outbound header injection, and the pino `trace_id` child
 * binding. All 4 daemons + the 5 cross-daemon edges funnel through this so the
 * header spelling and the log field can never drift.
 *
 * NOTE (D-DOH-M1-4): the chain leg is log-correlation-only — a Sui tx cannot carry
 * an app header, so chain submitters log `{trace_id, digest}` rather than embedding it.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/** Canonical HTTP/WS header name carrying the trace id across daemons. */
export const TRACE_HEADER = 'x-trace-id';

/** Header bag as seen at a server entry point (Node IncomingHttpHeaders-compatible). */
export type IncomingHeaders = Record<string, string | string[] | undefined>;

/** Generate a fresh UUID-v4 trace id. */
export function genTraceId(): string {
  return randomUUID();
}

/**
 * Read the inbound trace id, honoring it if present, else generating a fresh one
 * so no entry point is ever trace-less. Array-valued headers take the first entry.
 */
export function readTraceId(headers: IncomingHeaders): string {
  const raw = headers[TRACE_HEADER];
  const id = Array.isArray(raw) ? raw[0] : raw;
  return id ?? genTraceId();
}

/** Return a new header bag with `x-trace-id` set, preserving existing headers. */
export function withTraceHeader<T extends Record<string, string>>(
  headers: T,
  traceId: string,
): T & Record<string, string> {
  return { ...headers, [TRACE_HEADER]: traceId };
}

/** Bind `trace_id` onto a child logger so every line under it is correlated. */
export function traceChild(logger: Logger, traceId: string): Logger {
  return logger.child({ trace_id: traceId });
}
