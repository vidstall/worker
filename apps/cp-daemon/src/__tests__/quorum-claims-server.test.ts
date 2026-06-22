/**
 * Multi-CP quorum Phase 1 — Leg 7a: the LIVE `/quorum/claims` HTTP carrier (RED-first → GREEN).
 *
 * The loopback-127.0.0.1 single-host transport slice for the shared quorum claim board. This is
 * the PURE TRANSPORT layer: it owns NO board state — it delegates every route to an INJECTED
 * `QuorumClaimBoard` port (the hermetic `InMemoryGenericClaimBoard` here; the live HTTP client in
 * Leg 7b). The ONE net-new byte surface is the base64 `{32B pubkey, 64B sig}` wire codec (INV-A):
 * it WRAPS the pre-signed bytes, never alters them.
 *
 * Harness idiom cloned from turn-rpc.test.ts:55-85 — ephemeral port=0, server.address().port,
 * fetch(), afterEach stop(). Auth-rejection idiom from metrics-server-auth.test.ts:149-158
 * (same-length wrong token → 401 proves the constant-time path is reached).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  InMemoryGenericClaimBoard,
  type BoardKindConfig,
  type QuorumClaimBoard,
} from '@dvconf/shared';
import {
  startQuorumClaimsServer,
  type StartQuorumClaimsResult,
} from '../quorum-claims-server.js';

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

const TOKEN = 'quorum-claims-test-token-7f3a9c';

// ── Wire fixtures: a captoken-issue claim + an attestation carrying {32B pk, 64B sig}. ──
const PUBKEY_BYTES = new Uint8Array(32);
for (let i = 0; i < 32; i++) PUBKEY_BYTES[i] = (i * 7 + 3) & 0xff;
const SIG_BYTES = new Uint8Array(64);
for (let i = 0; i < 64; i++) SIG_BYTES[i] = (i * 5 + 11) & 0xff;

const PUBKEY_B64 = Buffer.from(PUBKEY_BYTES).toString('base64');
const SIG_B64 = Buffer.from(SIG_BYTES).toString('base64');

interface WireClaim {
  room: string;
  peer: string;
  nonce: number;
}
interface WireAttestation {
  pubkey: string; // base64 32B
  sig: string; // base64 64B
  operator: string;
}

function captokenIssueConfig(): BoardKindConfig<WireClaim, WireAttestation> {
  return {
    kind: 'captoken-issue',
    cellKey: (c) => `${c.room}|${c.peer}|${c.nonce}`,
    attesterKey: (a) => a.operator,
    distinctCount: (atts) => new Set(atts.map((a) => a.operator)).size,
    minDistinct: 2,
    gcFailMode: 'fail-closed-silent',
    validateWireSchema: () => null,
  };
}

function makeBoard(): QuorumClaimBoard {
  return new InMemoryGenericClaimBoard([captokenIssueConfig()]);
}

interface TestHarness {
  handle: StartQuorumClaimsResult;
  baseUrl: string;
  board: QuorumClaimBoard;
}

async function startHarness(
  overrides?: Partial<Parameters<typeof startQuorumClaimsServer>[0]>,
): Promise<TestHarness> {
  const board = overrides?.board ?? makeBoard();
  const handle = await startQuorumClaimsServer({
    board,
    portOverride: 0,
    authTokenOverride: TOKEN,
    logger: mockLogger(),
    ...overrides,
  });
  const addr = handle.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { handle, baseUrl, board };
}

function postClaim(
  baseUrl: string,
  body: unknown,
  token: string = TOKEN,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/quorum/claims`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Bearer ${token}`,
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const VALID_POST = () => ({
  kind: 'captoken-issue',
  claim: { room: '0xroom', peer: '0xpeer', nonce: 42 } as WireClaim,
  attestation: { pubkey: PUBKEY_B64, sig: SIG_B64, operator: '0xopA' } as WireAttestation,
  round: 1,
});

describe('startQuorumClaimsServer — /quorum/claims carrier', () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.handle.stop();
  });

  it('(1) POST append → 200, then GET /open returns the cell with {pubkey,sig} base64 BYTE-IDENTICAL', async () => {
    const res = await postClaim(h.baseUrl, VALID_POST());
    expect(res.status).toBe(200);

    const openRes = await fetch(`${h.baseUrl}/quorum/claims/open`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(openRes.status).toBe(200);
    const open = (await openRes.json()) as Array<{
      kind: string;
      attestations: WireAttestation[];
    }>;
    expect(open.length).toBe(1);
    expect(open[0]!.kind).toBe('captoken-issue');
    const att = open[0]!.attestations[0]!;
    // base64 strings round-trip identical AND the decoded bytes are byte-identical.
    expect(att.pubkey).toBe(PUBKEY_B64);
    expect(att.sig).toBe(SIG_B64);
    expect([...Buffer.from(att.pubkey, 'base64')]).toEqual([...PUBKEY_BYTES]);
    expect([...Buffer.from(att.sig, 'base64')]).toEqual([...SIG_BYTES]);
  });

  it('(2) wrong token of the SAME LENGTH → 401 (constant-time path reached)', async () => {
    const sameLen = 'X'.repeat(TOKEN.length);
    expect(sameLen.length).toBe(TOKEN.length);
    const res = await postClaim(h.baseUrl, VALID_POST(), sameLen);
    expect(res.status).toBe(401);
  });

  it('(3a) missing Authorization header → 401', async () => {
    const res = await fetch(`${h.baseUrl}/quorum/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_POST()),
    });
    expect(res.status).toBe(401);
  });

  it('(3b) too-short token → 401', async () => {
    const res = await postClaim(h.baseUrl, VALID_POST(), 'short');
    expect(res.status).toBe(401);
  });

  it('(4) body > 4096 bytes → 400 body too large', async () => {
    const huge = { ...VALID_POST(), claim: { room: 'x'.repeat(5000), peer: 'p', nonce: 1 } };
    const res = await postClaim(h.baseUrl, huge);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/too large/i);
  });

  it('(5a) unknown route → 404', async () => {
    const res = await fetch(`${h.baseUrl}/quorum/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it('(5b) wrong method on /quorum/claims (GET) → 405', async () => {
    const res = await fetch(`${h.baseUrl}/quorum/claims`, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });

  it('(5c) a board method that throws → 500', async () => {
    const throwingBoard: QuorumClaimBoard = {
      post: vi.fn(async () => {
        throw new Error('boom');
      }),
      listOpen: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      markSubmitted: vi.fn(async () => {}),
      gc: vi.fn(async () => {}),
    };
    const hh = await startHarness({ board: throwingBoard });
    try {
      const res = await postClaim(hh.baseUrl, VALID_POST());
      expect(res.status).toBe(500);
    } finally {
      await hh.handle.stop();
    }
  });

  it('(6) assertQuorumPortFree throws fail-closed when constructed on an in-use port (8090) BEFORE bind', async () => {
    // 8090 is in DAEMON_PORTS_IN_USE → the pre-flight assert must throw before listen.
    await expect(
      startQuorumClaimsServer({
        board: makeBoard(),
        env: { QUORUM_CLAIMS_PORT: '8090' },
        authTokenOverride: TOKEN,
        logger: mockLogger(),
      }),
    ).rejects.toThrow(/in use|EADDRINUSE|collision/i);
  });

  it('(7a) FAIL-LOUD: factory refuses to start when QUORUM_CLAIMS_AUTH_TOKEN unset + no override', async () => {
    await expect(
      startQuorumClaimsServer({
        board: makeBoard(),
        env: { QUORUM_CLAIMS_PORT: '0' }, // no QUORUM_CLAIMS_AUTH_TOKEN
        logger: mockLogger(),
      }),
    ).rejects.toThrow(/QUORUM_CLAIMS_AUTH_TOKEN/);
  });

  it('(7b) WITH a test-injected token it starts', async () => {
    const hh = await startQuorumClaimsServer({
      board: makeBoard(),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
    });
    try {
      expect((hh.server.address() as AddressInfo).port).toBeGreaterThan(0);
    } finally {
      await hh.stop();
    }
  });

  it('(7c) env token (no override) also starts', async () => {
    const hh = await startQuorumClaimsServer({
      board: makeBoard(),
      portOverride: 0,
      env: { QUORUM_CLAIMS_AUTH_TOKEN: TOKEN },
      logger: mockLogger(),
    });
    try {
      expect((hh.server.address() as AddressInfo).port).toBeGreaterThan(0);
    } finally {
      await hh.stop();
    }
  });

  it('(8) observability: counters reflect opened / quorumed / submitted per kind', async () => {
    // Open a cell (1 attester) → opened ticks; second distinct attester → quorumed.
    await postClaim(h.baseUrl, VALID_POST());
    await postClaim(h.baseUrl, {
      ...VALID_POST(),
      attestation: { pubkey: PUBKEY_B64, sig: SIG_B64, operator: '0xopB' },
    });

    // read /open then mark-submitted via the route.
    const openRes = await fetch(`${h.baseUrl}/quorum/claims/open`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const open = (await openRes.json()) as Array<{ key: string }>;
    const key = open[0]!.key;

    const markRes = await fetch(`${h.baseUrl}/quorum/claims/mark-submitted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ key }),
    });
    expect(markRes.status).toBe(200);

    const snap = h.handle.getMetrics();
    expect(snap.cells.opened['captoken-issue']).toBeGreaterThanOrEqual(1);
    expect(snap.cells.quorumed['captoken-issue']).toBeGreaterThanOrEqual(1);
    expect(snap.cells.submitted['captoken-issue']).toBeGreaterThanOrEqual(1);
  });

  it('(extra) POST /quorum/claims/get returns one cell by key', async () => {
    await postClaim(h.baseUrl, VALID_POST());
    const openRes = await fetch(`${h.baseUrl}/quorum/claims/open`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const open = (await openRes.json()) as Array<{ key: string }>;
    const key = open[0]!.key;
    const getRes = await fetch(`${h.baseUrl}/quorum/claims/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ key }),
    });
    expect(getRes.status).toBe(200);
    const cell = (await getRes.json()) as { key: string } | null;
    expect(cell?.key).toBe(key);
  });

  it('(extra) restricted CORS — Access-Control-Allow-Origin is NEVER "*"', async () => {
    const res = await postClaim(h.baseUrl, VALID_POST());
    const acao = res.headers.get('access-control-allow-origin');
    expect(acao).not.toBe('*');
  });
});
