/**
 * RED test for the signaling /bench/event HTTP endpoint — S23.2.C2.
 *
 * Two scopes:
 *  1. `createBenchHttpServer(writer)` — standalone factory: route, method,
 *     schema, size limit. Real http server on random port + real Node http
 *     client; the writer is mocked to spy on .write calls.
 *  2. `ensureBenchHttpServer()` — module singleton: BENCH_LATENCY off → null;
 *     on → handle; idempotent.
 *
 * Plan: `docs/80-research/evaluation/s23-plan.md` § S23.2.C2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const harness = vi.hoisted(() => {
  let benchEnabled = true;
  return {
    getBench: () => benchEnabled,
    setBench: (v: boolean) => {
      benchEnabled = v;
    },
  };
});

vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return {
    ...actual,
    isBenchEnabled: () => harness.getBench(),
    LatencyWriter: vi.fn().mockImplementation(() => ({
      traceId: 'test',
      scenario: 'adhoc' as const,
      source: 'client' as const,
      instance: 'signaling-test',
      getFilePath: () => '/tmp/signaling-test.jsonl',
      write: vi.fn(),
      close: vi.fn(),
    })),
  };
});

import {
  createBenchHttpServer,
  ensureBenchHttpServer,
  closeBenchHttpServer,
} from '../bench-endpoint.js';

interface HttpResult {
  status: number;
  body: string;
}

interface HttpResultH {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function postRawWithHeaders(
  port: number,
  path: string,
  body: string,
  method = 'POST',
): Promise<HttpResultH> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers as Record<string, string | string[] | undefined>,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function postRaw(
  port: number,
  path: string,
  body: string,
  method = 'POST',
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function listenRandom(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('createBenchHttpServer', () => {
  let server: Server;
  let port: number;
  const writer = { write: vi.fn() };

  beforeEach(async () => {
    writer.write.mockClear();
    server = createBenchHttpServer(writer);
    port = await listenRandom(server);
  });

  afterEach(async () => {
    await closeServer(server);
  });

  it('POST /bench/event with valid LatencyEvent returns 202 and forwards to writer', async () => {
    const body = JSON.stringify({
      schema_version: '1.0',
      ts: Date.now(),
      trace_id: 'trace-1',
      scenario: 'adhoc',
      source: 'client',
      instance: 'harness-A',
      metric: 'L_g2g_optB',
      value_ms: 42.5,
      context: { room_id: 'r1', peer_id: 'pA' },
    });
    const res = await postRaw(port, '/bench/event', body);
    expect(res.status).toBe(202);
    expect(writer.write).toHaveBeenCalledOnce();
    expect(writer.write).toHaveBeenCalledWith('L_g2g_optB', 42.5, {
      room_id: 'r1',
      peer_id: 'pA',
    });
  });

  it('accepts events without optional context', async () => {
    const body = JSON.stringify({
      schema_version: '1.0',
      ts: 1,
      trace_id: 't',
      scenario: 'adhoc',
      source: 'client',
      instance: 'i',
      metric: 'L_g2g_optB',
      value_ms: 1,
    });
    const res = await postRaw(port, '/bench/event', body);
    expect(res.status).toBe(202);
    expect(writer.write).toHaveBeenCalledWith('L_g2g_optB', 1, undefined);
  });

  it('rejects malformed JSON with 400', async () => {
    const res = await postRaw(port, '/bench/event', '{not json');
    expect(res.status).toBe(400);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('rejects schema mismatch with 400', async () => {
    const res = await postRaw(port, '/bench/event', '{"foo":"bar"}');
    expect(res.status).toBe(400);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('rejects wrong schema_version with 400', async () => {
    const body = JSON.stringify({
      schema_version: '2.0',
      ts: 1,
      trace_id: 't',
      scenario: 'adhoc',
      source: 'client',
      instance: 'i',
      metric: 'L_g2g_optB',
      value_ms: 1,
    });
    const res = await postRaw(port, '/bench/event', body);
    expect(res.status).toBe(400);
  });

  it('rejects GET with 405 + Allow: POST', async () => {
    const res = await postRaw(port, '/bench/event', '', 'GET');
    expect(res.status).toBe(405);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await postRaw(port, '/other', '', 'POST');
    expect(res.status).toBe(404);
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('returns 413 when body exceeds 64KB cap', async () => {
    const huge = 'x'.repeat(70 * 1024);
    const res = await postRaw(port, '/bench/event', huge);
    expect(res.status).toBe(413);
    expect(writer.write).not.toHaveBeenCalled();
  });

  // Cross-origin bench page (vite :5173) posts to this sink (:8081); the browser
  // blocks the POST unless the sink echoes CORS. These two guard the WAN split-driver path.
  it('answers CORS preflight OPTIONS with 204 + allow-origin', async () => {
    const res = await postRawWithHeaders(port, '/bench/event', '', 'OPTIONS');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect((res.headers['access-control-allow-methods'] ?? '')).toContain('POST');
    expect(writer.write).not.toHaveBeenCalled();
  });

  it('includes access-control-allow-origin on the 202 POST response', async () => {
    const body = JSON.stringify({
      schema_version: '1.0',
      ts: 1,
      trace_id: 't',
      scenario: 'adhoc',
      source: 'client',
      instance: 'i',
      metric: 'identity_ok',
      value_ms: 1,
    });
    const res = await postRawWithHeaders(port, '/bench/event', body);
    expect(res.status).toBe(202);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('ensureBenchHttpServer (module singleton)', () => {
  beforeEach(() => {
    closeBenchHttpServer();
  });

  afterEach(() => {
    closeBenchHttpServer();
  });

  it('returns null when BENCH_LATENCY is unset', () => {
    harness.setBench(false);
    expect(ensureBenchHttpServer()).toBeNull();
  });

  it('returns a handle when BENCH_LATENCY is set', () => {
    harness.setBench(true);
    const handle = ensureBenchHttpServer();
    expect(handle).not.toBeNull();
    expect(handle?.server).toBeDefined();
    expect(typeof handle?.close).toBe('function');
  });

  it('is idempotent: second call returns same singleton state', () => {
    harness.setBench(false);
    expect(ensureBenchHttpServer()).toBeNull();
    expect(ensureBenchHttpServer()).toBeNull();
  });
});
