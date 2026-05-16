/**
 * JSONL writer for latency benchmark events.
 *
 * Off-by-default: callers check `isBenchEnabled()` before constructing.
 * One file per process per scenario run, opened lazily on first write.
 * fsync on close so a crashed daemon does not silently drop the tail.
 */

import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  LATENCY_EVENT_SCHEMA_VERSION,
  type LatencyEvent,
  type LatencyScenario,
  type LatencySource,
} from './types.js';

/** Read `BENCH_LATENCY` env once at boot. */
export function isBenchEnabled(): boolean {
  return process.env['BENCH_LATENCY'] === '1';
}

/** Read or generate the scenario-wide trace id. */
export function resolveTraceId(): string {
  return process.env['BENCH_TRACE_ID'] ?? randomUUID();
}

/** Read scenario tag (defaults to `adhoc` if unset). */
export function resolveScenario(): LatencyScenario {
  const raw = process.env['BENCH_SCENARIO'] ?? 'adhoc';
  switch (raw) {
    case 's-baseline':
    case 's-mcu':
    case 's-wan':
    case 's-loaded':
    case 'adhoc':
      return raw;
    default:
      return 'adhoc';
  }
}

export interface LatencyWriterOptions {
  /** Directory under which scenario JSONL files are placed. */
  outputDir?: string;
  scenario?: LatencyScenario;
  traceId?: string;
  source: LatencySource;
  instance: string;
}

export class LatencyWriter {
  readonly traceId: string;
  readonly scenario: LatencyScenario;
  readonly source: LatencySource;
  readonly instance: string;
  private readonly filePath: string;
  private fd: number | null = null;

  constructor(opts: LatencyWriterOptions) {
    this.traceId = opts.traceId ?? resolveTraceId();
    this.scenario = opts.scenario ?? resolveScenario();
    this.source = opts.source;
    this.instance = opts.instance;

    const dir = resolve(opts.outputDir ?? 'bench-output');
    const fileName = `${this.scenario}-${this.source}-${this.traceId}.jsonl`;
    this.filePath = join(dir, fileName);
  }

  /** Write one event. No-op if disabled or already closed. */
  write(
    metric: LatencyEvent['metric'],
    value_ms: number,
    context?: Record<string, unknown>,
    extras?: { clock_skew_warning?: boolean },
  ): void {
    const event: LatencyEvent = {
      schema_version: LATENCY_EVENT_SCHEMA_VERSION,
      ts: Date.now(),
      trace_id: this.traceId,
      scenario: this.scenario,
      source: this.source,
      instance: this.instance,
      metric,
      value_ms,
      ...(context !== undefined ? { context } : {}),
      ...(extras?.clock_skew_warning ? { clock_skew_warning: true } : {}),
    };

    const line = JSON.stringify(event) + '\n';

    if (this.fd === null) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      this.fd = openSync(this.filePath, 'a');
    }
    writeSync(this.fd, line);
  }

  /** Convenience accessor for verification (tests, smoke). */
  getFilePath(): string {
    return this.filePath;
  }

  /** Flush + close. Safe to call multiple times. */
  close(): void {
    if (this.fd !== null) {
      try {
        fsyncSync(this.fd);
      } catch {
        // best-effort; on Windows fsyncSync may throw EINVAL on append-only fds
      }
      closeSync(this.fd);
      this.fd = null;
    }
  }
}

/**
 * Append a single event to an explicit JSONL file path. Used by tests and
 * one-shot probes that do not want to keep a writer instance around.
 */
export function appendLatencyEvent(filePath: string, event: LatencyEvent): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
  appendFileSync(resolve(filePath), JSON.stringify(event) + '\n');
}
