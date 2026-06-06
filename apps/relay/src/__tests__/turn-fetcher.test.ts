/**
 * S30.C.3 — Relay-side TURN credential fetcher tests.
 *
 * Relay daemon calls cp-daemon's POST /turn/issue (bearer-token) during
 * a client room-join to obtain a fresh coturn credential. The response
 * is inlined into the mediasoup transportCreated payload as `iceServers`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  fetchTurnCredential,
  type TurnCredentialPayload,
  type FetchTurnOptions,
} from '../turn-fetcher.js';

function makeFetchOk(body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

function makeFetchStatus(status: number, body: unknown = {}): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const baseOpts: Omit<FetchTurnOptions, 'fetchFn'> = {
  cpRpcUrl: 'http://127.0.0.1:8090',
  token: 'test-token-xyz',
  targetMinerId: '0xrelay-miner-self',
  userId: '0xpeer-alice',
};

describe('fetchTurnCredential', () => {
  it('sends x-trace-id when a traceId is provided (DOH-003 edge 3 → cp /turn/issue)', async () => {
    const fetchFn = makeFetchOk({
      username: 'u',
      password: 'p',
      expiry: 1,
      credentialHash: 'h',
      secretId: 1,
      txDigest: '0xd',
    });
    await fetchTurnCredential({ ...baseOpts, fetchFn, traceId: 'relay-trace-9' });
    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['x-trace-id']).toBe('relay-trace-9');
  });

  it('happy path: POSTs JSON body with bearer header + parses credential response', async () => {
    const expected: TurnCredentialPayload = {
      username: '1700001200:0xpeer-alice',
      password: 'abcd==',
      expiry: 1_700_001_200,
      credentialHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      secretId: 2,
      txDigest: '0xdig',
    };
    const fetchFn = makeFetchOk(expected);

    const result = await fetchTurnCredential({ ...baseOpts, fetchFn });

    expect(result).toEqual(expected);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8090/turn/issue');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer test-token-xyz');
    expect(init.headers['Content-Type']).toBe('application/json');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toEqual({
      targetMinerId: '0xrelay-miner-self',
      userId: '0xpeer-alice',
    });
  });

  it('passes ttlSec through to body when supplied', async () => {
    const fetchFn = makeFetchOk({
      username: 'u',
      password: 'p',
      expiry: 0,
      credentialHash: '',
      secretId: 0,
      txDigest: '',
    });

    await fetchTurnCredential({ ...baseOpts, ttlSec: 1500, fetchFn });

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.ttlSec).toBe(1500);
  });

  it('returns null when cp-daemon reports skipped:slashed', async () => {
    const fetchFn = makeFetchOk({ skipped: true, reason: 'slashed' });

    const result = await fetchTurnCredential({ ...baseOpts, fetchFn });

    expect(result).toBeNull();
  });

  it('throws on 401 (auth failure)', async () => {
    const fetchFn = makeFetchStatus(401, { error: 'unauthorized' });
    await expect(fetchTurnCredential({ ...baseOpts, fetchFn })).rejects.toThrow(/401|unauthorized/i);
  });

  it('throws on 500 (issuer failure)', async () => {
    const fetchFn = makeFetchStatus(500, { error: 'internal' });
    await expect(fetchTurnCredential({ ...baseOpts, fetchFn })).rejects.toThrow(/500|internal/i);
  });

  it('throws on network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    await expect(fetchTurnCredential({ ...baseOpts, fetchFn })).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws on malformed JSON response', async () => {
    const fetchFn = vi.fn(async () =>
      new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(fetchTurnCredential({ ...baseOpts, fetchFn })).rejects.toThrow();
  });
});
