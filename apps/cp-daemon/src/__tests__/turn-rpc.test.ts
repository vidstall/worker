/**
 * S30.C.1 — TURN RPC HTTP server tests (RED-first → GREEN).
 *
 * cp-daemon exposes POST /turn/issue (bearer-token auth) so relay daemon
 * can fetch a fresh coturn credential during a client room-join. Pivot 1
 * of S30.C: signaling daemon is NOT in the production client path — relay
 * fetches creds and inlines them into the mediasoup transportCreated
 * response. See [[session-30-s30c-signaling-delivery-client-wire]].
 *
 * Dependency injection: tests pass a mock TurnIssuer (TurnIssuerLike) so
 * the RPC server can be tested without spinning up a real Sui submitFn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AddressInfo } from 'node:net';
import {
  startTurnRpc,
  type TurnIssuerLike,
  type StartTurnRpcResult,
} from '../turn-rpc.js';
import type { CredentialResult, IssueResult } from '../turn-issuer.js';

function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

const TOKEN = 'test-token-7f3a9c';

function fakeCredential(): CredentialResult {
  return {
    username: '1700001200:0xpeer',
    password: 'abcdefghij==',
    expiry: 1_700_001_200,
    credentialHash: new Uint8Array(32).fill(7),
    secretId: 1,
    txDigest: '0xfakedigest',
  };
}

interface TestHarness {
  handle: StartTurnRpcResult;
  baseUrl: string;
  issuerCalls: Array<{ targetMinerId: string; userId: string; ttlSec?: number }>;
  setIssuerResult: (result: IssueResult | Error) => void;
}

async function startHarness(): Promise<TestHarness> {
  const issuerCalls: TestHarness['issuerCalls'] = [];
  let pendingResult: IssueResult | Error = fakeCredential();

  const mockIssuer: TurnIssuerLike = {
    issueFor: vi.fn(async (opts) => {
      issuerCalls.push(opts);
      if (pendingResult instanceof Error) throw pendingResult;
      return pendingResult;
    }),
  };

  const handle = await startTurnRpc({
    issuer: mockIssuer,
    port: 0,
    token: TOKEN,
    logger: mockLogger(),
  });

  const addr = handle.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    handle,
    baseUrl,
    issuerCalls,
    setIssuerResult: (r) => {
      pendingResult = r;
    },
  };
}

describe('startTurnRpc — POST /turn/issue', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.handle.stop();
  });

  it('happy path: returns CredentialResult JSON on valid bearer + body', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetMinerId: '0xrelay-miner',
        userId: '0xpeer-alice',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['username']).toBe('1700001200:0xpeer');
    expect(body['password']).toBe('abcdefghij==');
    expect(body['expiry']).toBe(1_700_001_200);
    expect(body['secretId']).toBe(1);
    expect(body['txDigest']).toBe('0xfakedigest');
    // credentialHash serialized as base64 string over the wire
    expect(typeof body['credentialHash']).toBe('string');
    expect(Buffer.from(body['credentialHash'] as string, 'base64')).toHaveLength(32);

    expect(h.issuerCalls).toHaveLength(1);
    expect(h.issuerCalls[0]).toEqual({
      targetMinerId: '0xrelay-miner',
      userId: '0xpeer-alice',
    });
  });

  it('passes optional ttlSec through to issueFor when supplied', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetMinerId: '0xrelay-miner',
        userId: '0xpeer-bob',
        ttlSec: 1500,
      }),
    });

    expect(res.status).toBe(200);
    expect(h.issuerCalls[0]).toEqual({
      targetMinerId: '0xrelay-miner',
      userId: '0xpeer-bob',
      ttlSec: 1500,
    });
  });

  it('returns 200 with skipped:slashed when issuer returns SkippedResult', async () => {
    h.setIssuerResult({ skipped: true, reason: 'slashed' });

    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        targetMinerId: '0xslashed-relay',
        userId: '0xpeer-alice',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ skipped: true, reason: 'slashed' });
  });

  it('returns 401 when Authorization header missing', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetMinerId: '0xr', userId: '0xp' }),
    });

    expect(res.status).toBe(401);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 401 when bearer token wrong', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer wrong-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetMinerId: '0xr', userId: '0xp' }),
    });

    expect(res.status).toBe(401);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 401 when Authorization scheme is not Bearer', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetMinerId: '0xr', userId: '0xp' }),
    });

    expect(res.status).toBe(401);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 400 when JSON body is malformed', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{not valid json',
    });

    expect(res.status).toBe(400);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 400 when targetMinerId is missing', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId: '0xpeer' }),
    });

    expect(res.status).toBe(400);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 400 when userId is missing', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetMinerId: '0xrelay' }),
    });

    expect(res.status).toBe(400);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 405 when method is not POST', async () => {
    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });

    expect(res.status).toBe(405);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 404 on unknown path', async () => {
    const res = await fetch(`${h.baseUrl}/some/other/path`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetMinerId: '0xr', userId: '0xp' }),
    });

    expect(res.status).toBe(404);
    expect(h.issuerCalls).toHaveLength(0);
  });

  it('returns 500 when issuer throws', async () => {
    h.setIssuerResult(new Error('upstream chain rpc died'));

    const res = await fetch(`${h.baseUrl}/turn/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ targetMinerId: '0xr', userId: '0xp' }),
    });

    expect(res.status).toBe(500);
    expect(h.issuerCalls).toHaveLength(1);
  });
});

describe('startTurnRpc — lifecycle', () => {
  it('stop() closes the server cleanly', async () => {
    const h = await startHarness();
    await h.handle.stop();

    // After stop, fetch should fail with connection refused
    await expect(
      fetch(`${h.baseUrl}/turn/issue`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${TOKEN}` },
        body: '{}',
      }),
    ).rejects.toThrow();
  });
});
