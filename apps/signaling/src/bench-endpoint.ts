/**
 * Signaling /bench/event HTTP endpoint — S23.2.C2.
 *
 * Receives `LatencyEvent` JSON payloads from external clients (browser-based
 * RTCStats collector deferred to a later session, Node mediasoup-client harness
 * shipped in S23.2.C1) and forwards them into a `LatencyWriter` with
 * `source = 'client'` so the events land in the same JSONL family the
 * `pnpm bench:replay` aggregator (S23.2.B1) consumes.
 *
 * Hosted on a **separate** HTTP server (default `BENCH_PORT=8081`) so the
 * surface is fully additive vs the existing WebSocket signaling server in
 * `index.ts`. Off-by-default: `ensureBenchHttpServer` returns `null` unless
 * `BENCH_LATENCY=1`.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.2
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.C2
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  isBenchEnabled,
  LatencyWriter,
  LATENCY_EVENT_SCHEMA_VERSION,
  type LatencyEvent,
  type Logger,
} from '@dvconf/shared';

const MAX_BODY_BYTES = 64 * 1024;
const BENCH_PATH = '/bench/event';

function isLatencyEvent(x: unknown): x is LatencyEvent {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    o['schema_version'] === LATENCY_EVENT_SCHEMA_VERSION &&
    typeof o['ts'] === 'number' &&
    typeof o['trace_id'] === 'string' &&
    typeof o['scenario'] === 'string' &&
    typeof o['source'] === 'string' &&
    typeof o['instance'] === 'string' &&
    typeof o['metric'] === 'string' &&
    typeof o['value_ms'] === 'number'
  );
}

function handleRequest(
  writer: Pick<LatencyWriter, 'write'>,
  req: IncomingMessage,
  res: ServerResponse,
  log?: Logger,
): void {
  let sent = false;
  const send = (status: number, body = ''): void => {
    if (sent) return;
    sent = true;
    res.writeHead(status, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  if (req.url !== BENCH_PATH) {
    send(404);
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    send(405);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;

  req.on('data', (chunk: Buffer) => {
    if (sent) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      send(413, 'payload too large');
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on('end', () => {
    if (sent) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      send(400, 'malformed json');
      return;
    }
    if (!isLatencyEvent(parsed)) {
      send(400, 'schema mismatch');
      return;
    }
    try {
      writer.write(parsed.metric, parsed.value_ms, parsed.context);
      send(202);
    } catch (err) {
      log?.error({ err }, 'bench writer failed');
      send(500);
    }
  });

  req.on('error', (err) => {
    log?.warn({ err }, 'bench request error');
  });
}

/** Build a standalone HTTP server for the /bench/event endpoint. */
export function createBenchHttpServer(
  writer: Pick<LatencyWriter, 'write'>,
  log?: Logger,
): Server {
  return createHttpServer((req, res) => {
    handleRequest(writer, req, res, log);
  });
}

export interface BenchHttpHandle {
  server: Server;
  close: () => void;
}

let cachedServer: Server | null = null;
let cachedWriter: LatencyWriter | null = null;
let initialized = false;

/**
 * Module-singleton accessor. Constructs a writer + http.Server the first time
 * it is called when `BENCH_LATENCY=1`; subsequent calls return the same handle.
 * Returns `null` (and stays null) when bench is disabled.
 */
export function ensureBenchHttpServer(log?: Logger): BenchHttpHandle | null {
  if (initialized) {
    if (cachedServer === null) return null;
    return { server: cachedServer, close: closeBenchHttpServer };
  }
  initialized = true;
  if (!isBenchEnabled()) {
    return null;
  }
  cachedWriter = new LatencyWriter({
    source: 'client',
    instance: process.env['SIGNALING_INSTANCE'] ?? 'signaling-default',
  });
  cachedServer = createBenchHttpServer(cachedWriter, log);
  return { server: cachedServer, close: closeBenchHttpServer };
}

export function closeBenchHttpServer(): void {
  if (cachedServer !== null) {
    cachedServer.close();
    cachedServer = null;
  }
  if (cachedWriter !== null) {
    cachedWriter.close();
    cachedWriter = null;
  }
  initialized = false;
}
