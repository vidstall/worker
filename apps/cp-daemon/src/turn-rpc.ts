/**
 * S30.C.2 — TURN RPC HTTP server (cp-daemon side).
 *
 * Single endpoint POST /turn/issue, bearer-token authenticated, returns
 * a fresh coturn `use-auth-secret` credential for a given (targetMinerId,
 * userId) pair. Consumed by relay daemon during a client room-join so the
 * mediasoup transportCreated response can carry the matching iceServers.
 *
 * Wire format: credentialHash (Uint8Array) base64-encoded over the wire.
 * Skipped (slashed) results pass through as `{skipped: true, reason}` JSON.
 *
 * Auth scope: localhost-only deployments today (cp-daemon + relay co-located
 * or VPN-linked). Bearer token from env TURN_RPC_TOKEN gates all access; no
 * IP allowlist, no mTLS — fine for current single-tenant test deployments,
 * tighten when multi-tenant. See [[ADR-0005-turn-credential-distribution]].
 */
import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Logger } from '@dvconf/shared';
import { readTraceId, traceChild } from '@dvconf/shared';
import type {
  CredentialResult,
  IssueResult,
  SkippedResult,
} from './turn-issuer.js';

/**
 * Structural subtype of {@link TurnIssuer} so tests can pass a mock
 * without spinning up a real Sui submitFn. Production wires the real
 * issuer instance built by startTurnIssuer.
 */
export interface TurnIssuerLike {
  issueFor(opts: {
    targetMinerId: string;
    userId: string;
    ttlSec?: number;
  }): Promise<IssueResult>;
}

export interface StartTurnRpcOptions {
  issuer: TurnIssuerLike;
  port: number;
  token: string;
  logger: Logger;
}

export interface StartTurnRpcResult {
  server: Server;
  stop: () => Promise<void>;
}

const MAX_BODY_BYTES = 4096;

function isCredentialResult(r: IssueResult): r is CredentialResult {
  return !('skipped' in r);
}

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.statusCode = status;
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function checkBearer(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  return header.slice(prefix.length) === token;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('body too large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface IssueRequestBody {
  targetMinerId: string;
  userId: string;
  ttlSec?: number;
}

function parseIssueBody(raw: string): IssueRequestBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o['targetMinerId'] !== 'string' || o['targetMinerId'] === '') return null;
  if (typeof o['userId'] !== 'string' || o['userId'] === '') return null;
  if (o['ttlSec'] !== undefined && typeof o['ttlSec'] !== 'number') return null;
  return {
    targetMinerId: o['targetMinerId'],
    userId: o['userId'],
    ...(o['ttlSec'] !== undefined ? { ttlSec: o['ttlSec'] as number } : {}),
  };
}

function serializeResult(r: IssueResult): unknown {
  if (!isCredentialResult(r)) {
    const skipped: SkippedResult = r;
    return { skipped: skipped.skipped, reason: skipped.reason };
  }
  return {
    username: r.username,
    password: r.password,
    expiry: r.expiry,
    credentialHash: Buffer.from(r.credentialHash).toString('base64'),
    secretId: r.secretId,
    txDigest: r.txDigest,
  };
}

export async function startTurnRpc(
  opts: StartTurnRpcOptions,
): Promise<StartTurnRpcResult> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, opts);
  });

  await new Promise<void>((resolve) => server.listen(opts.port, resolve));

  opts.logger.info(
    { port: opts.port === 0 ? (server.address() as { port: number } | null)?.port : opts.port },
    'TURN RPC server listening',
  );

  return {
    server,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartTurnRpcOptions,
): Promise<void> {
  // F63 (DOH-003) edge 3 receiver — correlate the relay's x-trace-id to cp's logs.
  const reqLog = traceChild(opts.logger, readTraceId(req.headers));
  try {
    if (req.url !== '/turn/issue') {
      return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'POST') {
      return send(res, 405, { error: 'method not allowed' });
    }
    if (!checkBearer(req, opts.token)) {
      return send(res, 401, { error: 'unauthorized' });
    }

    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return send(res, 400, { error: 'body read failed' });
    }

    const body = parseIssueBody(raw);
    if (body === null) {
      return send(res, 400, { error: 'malformed request body' });
    }

    let result: IssueResult;
    try {
      result = await opts.issuer.issueFor(body);
    } catch (err) {
      reqLog.error({ err }, 'TURN RPC: issueFor threw');
      return send(res, 500, { error: 'internal' });
    }

    reqLog.info({ targetMinerId: body.targetMinerId }, 'TURN RPC: credential issued');
    return send(res, 200, serializeResult(result));
  } catch (err) {
    reqLog.error({ err }, 'TURN RPC: unhandled error');
    send(res, 500, { error: 'internal' });
  }
}
