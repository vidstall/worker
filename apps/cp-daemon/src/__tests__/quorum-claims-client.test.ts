/**
 * Multi-CP quorum Phase 1 — Leg 7b: the `HttpQuorumClaimBoard` client (RED-first → GREEN).
 *
 * The HTTP-backed board CLIENT for the live `/quorum/claims` loopback carrier (Leg 7a). The
 * CENTERPIECE is a PARITY suite: ONE set of behavioral assertions is defined once and run against
 * BOTH boards behind the same `QuorumClaimBoard` port —
 *   (a) a fresh hermetic `InMemoryGenericClaimBoard` (the BEHAVIORAL reference), and
 *   (b) a `HttpQuorumClaimBoard` wired to a LIVE Leg-7a `startQuorumClaimsServer` on an ephemeral
 *       port (portOverride=0 + a test-injected auth token), pointed at 127.0.0.1:<port>.
 * Both must pass IDENTICALLY — the "pure transport substitution" proof: swapping the in-memory board
 * for the HTTP transport changes nothing observable (including the {32B pk, 64B sig} bytes, which are
 * byte-identical end-to-end through the base64 wire codec).
 *
 * Plus HTTP-only negative assertions: a 401 (bad token) and a server-500 (board throws) BOTH surface
 * as a thrown/rejected promise (fail-closed), NEVER a silent `undefined`.
 *
 * Harness idiom cloned from quorum-claims-server.test.ts:83-97 (ephemeral port=0 + injected token).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  InMemoryGenericClaimBoard,
  type BoardKindConfig,
  type QuorumClaimBoard,
  type OpenGenericCell,
} from '@dvconf/shared';
import {
  startQuorumClaimsServer,
  type StartQuorumClaimsResult,
} from '../quorum-claims-server.js';
import { HttpQuorumClaimBoard } from '../quorum-claims-client.js';

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

const TOKEN = 'quorum-claims-client-test-token-91be4d';

// ── Wire fixtures: a captoken-issue claim + attestations carrying {32B pk, 64B sig}. ──
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

const CLAIM = (): WireClaim => ({ room: '0xroom', peer: '0xpeer', nonce: 42 });
const ATT_A = (): WireAttestation => ({ pubkey: PUBKEY_B64, sig: SIG_B64, operator: '0xopA' });
const ATT_B = (): WireAttestation => ({ pubkey: PUBKEY_B64, sig: SIG_B64, operator: '0xopB' });

/**
 * The SINGLE behavioral contract, run against either board. EVERY assertion here must hold for the
 * in-memory reference AND the HTTP transport — that equivalence IS the proof.
 */
async function runParityContract(board: QuorumClaimBoard): Promise<void> {
  // ── post → listOpen shows the cell ──
  await board.post('captoken-issue', CLAIM(), ATT_A(), 1);
  let open = await board.listOpen();
  expect(open.length).toBe(1);
  expect(open[0]!.kind).toBe('captoken-issue');
  const key = open[0]!.key;
  expect(open[0]!.attestations.length).toBe(1);

  // {32B pk, 64B sig} byte-identical end-to-end (the pure-transport-substitution byte proof).
  const att0 = open[0]!.attestations[0]! as WireAttestation;
  expect(att0.pubkey).toBe(PUBKEY_B64);
  expect(att0.sig).toBe(SIG_B64);
  expect([...Buffer.from(att0.pubkey, 'base64')]).toEqual([...PUBKEY_BYTES]);
  expect([...Buffer.from(att0.sig, 'base64')]).toEqual([...SIG_BYTES]);

  // ── a SECOND distinct attester accrues to the SAME cell ──
  await board.post('captoken-issue', CLAIM(), ATT_B(), 1);
  open = await board.listOpen();
  expect(open.length).toBe(1);
  expect(open[0]!.key).toBe(key);
  const operators = (open[0]!.attestations as WireAttestation[]).map((a) => a.operator).sort();
  expect(operators).toEqual(['0xopA', '0xopB']);

  // ── get(key) returns the cell ──
  const got = await board.get(key);
  expect(got).toBeDefined();
  expect(got!.key).toBe(key);
  expect((got!.attestations as WireAttestation[]).length).toBe(2);

  // ── markSubmitted(key) → get returns undefined, listOpen EXCLUDES it ──
  await board.markSubmitted(key);
  const afterMark = await board.get(key);
  expect(afterMark).toBeUndefined();
  open = await board.listOpen();
  expect(open.find((c) => c.key === key)).toBeUndefined();

  // ── gc(round) round-trips (server-side state-GC for the HTTP path) ──
  await expect(board.gc(1_000_000)).resolves.toBeUndefined();
}

interface HttpFixture {
  handle: StartQuorumClaimsResult;
  board: HttpQuorumClaimBoard;
}

async function startHttpFixture(serverBoard?: QuorumClaimBoard): Promise<HttpFixture> {
  const handle = await startQuorumClaimsServer({
    board: serverBoard ?? new InMemoryGenericClaimBoard([captokenIssueConfig()]),
    portOverride: 0,
    authTokenOverride: TOKEN,
    logger: mockLogger(),
  });
  const addr = handle.server.address() as AddressInfo;
  const board = new HttpQuorumClaimBoard({
    baseUrl: `http://127.0.0.1:${addr.port}`,
    token: TOKEN,
    logger: mockLogger(),
  });
  return { handle, board };
}

describe('Leg 7b parity — InMemoryGenericClaimBoard vs HttpQuorumClaimBoard', () => {
  it('(parity-A) the in-memory reference board satisfies the contract', async () => {
    const board = new InMemoryGenericClaimBoard([captokenIssueConfig()]);
    await runParityContract(board);
  });

  it('(parity-B) the HTTP board over a LIVE 7a server satisfies the SAME contract', async () => {
    const fx = await startHttpFixture();
    try {
      await runParityContract(fx.board);
    } finally {
      await fx.handle.stop();
    }
  });
});

describe('HttpQuorumClaimBoard — HTTP-only negative + observability', () => {
  let fx: HttpFixture;

  afterEach(async () => {
    if (fx) await fx.handle.stop();
  });

  it('(neg-401) a bad token → REJECTS (fail-closed, never silent undefined)', async () => {
    fx = await startHttpFixture();
    const badBoard = new HttpQuorumClaimBoard({
      baseUrl: fx.board.baseUrl,
      token: 'X'.repeat(TOKEN.length), // same length, wrong → constant-time 401
      logger: mockLogger(),
    });
    await expect(badBoard.post('captoken-issue', CLAIM(), ATT_A(), 1)).rejects.toThrow();
    await expect(badBoard.listOpen()).rejects.toThrow();
  });

  it('(neg-500) a server-side board throw → REJECTS (fail-closed, never silent undefined)', async () => {
    const throwingBoard: QuorumClaimBoard = {
      post: vi.fn(async () => {
        throw new Error('boom');
      }),
      listOpen: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      markSubmitted: vi.fn(async () => {}),
      gc: vi.fn(async () => {}),
    };
    fx = await startHttpFixture(throwingBoard);
    await expect(fx.board.post('captoken-issue', CLAIM(), ATT_A(), 1)).rejects.toThrow();
  });

  it('(counters) additive client metrics tick by method + record latency', async () => {
    fx = await startHttpFixture();
    await fx.board.post('captoken-issue', CLAIM(), ATT_A(), 1);
    await fx.board.listOpen();
    const snap = fx.board.getMetrics();
    expect(snap.requests.post).toBeGreaterThanOrEqual(1);
    expect(snap.requests.listOpen).toBeGreaterThanOrEqual(1);
    expect(snap.non2xx).toBe(0);
    expect(snap.latency.count).toBeGreaterThanOrEqual(2);
    expect(snap.latency.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('(counters-non2xx) a non-2xx response increments the non2xx counter', async () => {
    fx = await startHttpFixture();
    const badBoard = new HttpQuorumClaimBoard({
      baseUrl: fx.board.baseUrl,
      token: 'X'.repeat(TOKEN.length),
      logger: mockLogger(),
    });
    await expect(badBoard.listOpen()).rejects.toThrow();
    expect(badBoard.getMetrics().non2xx).toBeGreaterThanOrEqual(1);
  });

  it('(get-miss) get() of an absent key resolves to undefined (contract null→undefined map)', async () => {
    fx = await startHttpFixture();
    const missing = await fx.board.get('captoken-issue|nope|nope|0');
    expect(missing).toBeUndefined();
  });

  it('(inject-fetch) a custom fetch is used when injected', async () => {
    const real = globalThis.fetch.bind(globalThis);
    const spy = vi.fn(real);
    fx = await startHttpFixture();
    const board = new HttpQuorumClaimBoard({
      baseUrl: fx.board.baseUrl,
      token: TOKEN,
      fetch: spy as unknown as typeof fetch,
      logger: mockLogger(),
    });
    await board.listOpen();
    expect(spy).toHaveBeenCalled();
  });

  it('(network-error) a network error → REJECTS (fail-closed)', async () => {
    fx = await startHttpFixture();
    const board = new HttpQuorumClaimBoard({
      // an unroutable port that nothing is bound to
      baseUrl: 'http://127.0.0.1:1',
      token: TOKEN,
      logger: mockLogger(),
    });
    await expect(board.listOpen()).rejects.toThrow();
  });
});

// A compile-time assertion that HttpQuorumClaimBoard satisfies the EXACT port (never widened).
const _portCheck: QuorumClaimBoard = new HttpQuorumClaimBoard({
  baseUrl: 'http://127.0.0.1:0',
  token: 't',
  logger: mockLogger(),
});
void _portCheck;
void (null as unknown as OpenGenericCell<unknown, unknown>);
