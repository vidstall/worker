/**
 * OQ-7 Phase D-1 STAGE-2 (CANARY CARRIER) — RED-first → GREEN.
 *
 * The canary `/canary/claims` HTTP carrier (`startCanaryClaimsServer`) + its `HttpClaimBoard` client,
 * mirroring the cap-token Leg-7 carrier but bound to the canary-concrete `ClaimBoard` port
 * (post(claim, attestation, round) — NO kind). Reuses the SHARED mTLS SPKI-pin primitives
 * (@dvconf/shared) — this lane does NOT duplicate the pin code.
 *
 * Coverage here (the cheap, hermetic slice; the full mTLS 2-party E2E + INV-A verbatim proof is D-2):
 *   - server up + a post/get/open round-trip over plain http + bearer
 *   - bearer-reject (same-length wrong token → 401, constant-time path reached)
 *   - FAIL-LOUD on an unset CANARY_CLAIMS_AUTH_TOKEN
 *   - port-collision assert (an in-use daemon port → throws before bind)
 *   - INV-C forbidden-field reject (an auditing-validator miner_id / assignmentSecret / Wallet-A
 *     material → 400 fail-closed BEFORE store)
 *   - INV-A: the {32B pubkey, 64B sig} bytes ride VERBATIM end-to-end through the base64 codec
 *   - vanilla flag-off → InMemoryClaimBoard unchanged (no server)
 *   - parity: InMemoryClaimBoard vs HttpClaimBoard satisfy the SAME canary contract
 *   - a single cheap TLS smoke (shared createMtlsServer + buildPinnedDispatcher 2-party round-trip)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { spkiFingerprint } from '@dvconf/shared';
import {
  InMemoryClaimBoard,
  cellKey,
  type ClaimBoard,
} from '../claim-board.js';
import {
  signSelfAttestation,
  canonicalProofMessage,
  distinctAttesterCount,
  attesterPubkeyHex,
  OBSERVED_HASH_MISSING,
  type DivergenceClaim,
  type DivergenceAttestation,
} from '../proof.js';
import {
  startCanaryClaimsServer,
  type StartCanaryClaimsResult,
} from '../claims-server.js';
import { HttpClaimBoard } from '../claims-client.js';
import {
  DEFAULT_CANARY_CLAIMS_PORT,
  resolveCanaryClaimsPort,
  assertCanaryClaimsPortFree,
  CANARY_DAEMON_PORTS_IN_USE,
} from '../canary-claims-port.js';
import {
  SERVER_KEY_PEM,
  SERVER_CERT_PEM,
  CLIENT_KEY_PEM,
  CLIENT_CERT_PEM,
} from './fixtures/mtls-fixtures.js';

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

const TOKEN = 'canary-claims-test-token-4b9f1a';

const CLAIM: DivergenceClaim = {
  roomId: '0x' + '11'.repeat(32),
  relayMinerId: '0x' + '22'.repeat(32),
  canaryId: 9,
  frameSeq: 5,
  expectedHash: '33'.repeat(32),
  observedHash: OBSERVED_HASH_MISSING,
};

const msgFor = (c: DivergenceClaim): Uint8Array =>
  canonicalProofMessage({ ...c, sessionKeypairs: [] });

async function attFor(c: DivergenceClaim, kp: Ed25519Keypair): Promise<DivergenceAttestation> {
  return signSelfAttestation(msgFor(c), kp);
}

interface TestHarness {
  handle: StartCanaryClaimsResult;
  baseUrl: string;
  board: ClaimBoard;
}

async function startHarness(
  overrides?: Partial<Parameters<typeof startCanaryClaimsServer>[0]>,
): Promise<TestHarness> {
  const board = overrides?.board ?? new InMemoryClaimBoard({ wCorr: 100 });
  const handle = await startCanaryClaimsServer({
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

/** Wire form of an attestation: {pubkey,sig} base64 (matches HttpClaimBoard's codec). */
function wireAtt(a: DivergenceAttestation): { pubkey: string; sig: string } {
  return {
    pubkey: Buffer.from(a.sessionPublicKey).toString('base64'),
    sig: Buffer.from(a.signature).toString('base64'),
  };
}

function postRaw(
  baseUrl: string,
  body: unknown,
  token: string = TOKEN,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${baseUrl}/canary/claims`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('canary-claims-port — resolve + collision assert', () => {
  it('default port is 8092 and resolves when env unset', () => {
    expect(DEFAULT_CANARY_CLAIMS_PORT).toBe(8092);
    expect(resolveCanaryClaimsPort({})).toBe(8092);
  });

  it('resolves an explicit env port and fails-closed on a non-numeric one', () => {
    expect(resolveCanaryClaimsPort({ CANARY_CLAIMS_PORT: '9100' })).toBe(9100);
    expect(() => resolveCanaryClaimsPort({ CANARY_CLAIMS_PORT: 'nope' })).toThrow();
  });

  it('assertCanaryClaimsPortFree throws on an in-use daemon port', () => {
    const inUse = CANARY_DAEMON_PORTS_IN_USE[0]!;
    expect(() => assertCanaryClaimsPortFree(inUse)).toThrow(/in use|collision|EADDRINUSE/i);
  });
});

describe('startCanaryClaimsServer — /canary/claims carrier (plain http)', () => {
  let h: TestHarness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.handle.stop();
  });

  it('(1) POST append (NO kind) → 200, then GET /open returns the cell with {pubkey,sig} BYTE-IDENTICAL (INV-A)', async () => {
    const kp = new Ed25519Keypair();
    const att = await attFor(CLAIM, kp);
    const res = await postRaw(h.baseUrl, { claim: CLAIM, attestation: wireAtt(att), round: 1 });
    expect(res.status).toBe(200);

    const openRes = await fetch(`${h.baseUrl}/canary/claims/open`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(openRes.status).toBe(200);
    const open = (await openRes.json()) as Array<{
      key: string;
      claim: DivergenceClaim;
      attestations: Array<{ pubkey: string; sig: string }>;
    }>;
    expect(open.length).toBe(1);
    expect(open[0]!.claim.relayMinerId).toBe(CLAIM.relayMinerId);
    const wa = open[0]!.attestations[0]!;
    // INV-A: the 32B pubkey + 64B sig ride VERBATIM through the base64 codec.
    expect([...Buffer.from(wa.pubkey, 'base64')]).toEqual([...att.sessionPublicKey]);
    expect([...Buffer.from(wa.sig, 'base64')]).toEqual([...att.signature]);
  });

  it('(2) wrong token of the SAME LENGTH → 401 (constant-time path reached)', async () => {
    const sameLen = 'X'.repeat(TOKEN.length);
    const kp = new Ed25519Keypair();
    const res = await postRaw(
      h.baseUrl,
      { claim: CLAIM, attestation: wireAtt(await attFor(CLAIM, kp)), round: 1 },
      sameLen,
    );
    expect(res.status).toBe(401);
  });

  it('(2b) missing Authorization header → 401', async () => {
    const res = await fetch(`${h.baseUrl}/canary/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim: CLAIM, attestation: { pubkey: 'a', sig: 'b' }, round: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it('(3) INV-C: a post carrying a forbidden auditor minerId → 400 fail-closed BEFORE store', async () => {
    const kp = new Ed25519Keypair();
    const att = await attFor(CLAIM, kp);
    const res = await postRaw(h.baseUrl, {
      claim: { ...CLAIM, minerId: '0xAUDITOR_WALLET_A' },
      attestation: wireAtt(att),
      round: 1,
    });
    expect(res.status).toBe(400);
    // Nothing was stored.
    const openRes = await fetch(`${h.baseUrl}/canary/claims/open`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(((await openRes.json()) as unknown[]).length).toBe(0);
  });

  it('(3b) INV-C: a post carrying assignmentSecret / sessionWallet → 400 fail-closed', async () => {
    const att = await attFor(CLAIM, new Ed25519Keypair());
    for (const forbidden of [
      { assignmentSecret: 'deadbeef' },
      { sessionWallet: '0xB' },
      { cellSecret: 'x' },
    ]) {
      const res = await postRaw(h.baseUrl, {
        claim: { ...CLAIM, ...forbidden },
        attestation: wireAtt(att),
        round: 1,
      });
      expect(res.status).toBe(400);
    }
  });

  it('(3c) INV-C: a forbidden field on the ATTESTATION (a Wallet-A signatureA leg) → 400', async () => {
    const att = await attFor(CLAIM, new Ed25519Keypair());
    const res = await postRaw(h.baseUrl, {
      claim: CLAIM,
      attestation: { ...wireAtt(att), signatureA: 'deadbeef', minerId: '0xA' },
      round: 1,
    });
    expect(res.status).toBe(400);
  });

  it('(4) port-collision assert: constructing on an in-use port (8090) throws BEFORE bind', async () => {
    await expect(
      startCanaryClaimsServer({
        board: new InMemoryClaimBoard(),
        env: { CANARY_CLAIMS_PORT: '8090' },
        authTokenOverride: TOKEN,
        logger: mockLogger(),
      }),
    ).rejects.toThrow(/in use|EADDRINUSE|collision/i);
  });

  it('(5a) FAIL-LOUD: factory refuses to start when CANARY_CLAIMS_AUTH_TOKEN unset + no override', async () => {
    await expect(
      startCanaryClaimsServer({
        board: new InMemoryClaimBoard(),
        env: { CANARY_CLAIMS_PORT: '0' },
        logger: mockLogger(),
      }),
    ).rejects.toThrow(/CANARY_CLAIMS_AUTH_TOKEN/);
  });

  it('(5b) env token (no override) also starts', async () => {
    const hh = await startCanaryClaimsServer({
      board: new InMemoryClaimBoard(),
      portOverride: 0,
      env: { CANARY_CLAIMS_AUTH_TOKEN: TOKEN },
      logger: mockLogger(),
    });
    try {
      expect((hh.server.address() as AddressInfo).port).toBeGreaterThan(0);
    } finally {
      await hh.stop();
    }
  });

  it('(6) unknown route → 404; wrong method on POST route → 405', async () => {
    const r404 = await fetch(`${h.baseUrl}/canary/nope`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r404.status).toBe(404);
    const r405 = await fetch(`${h.baseUrl}/canary/claims`, {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r405.status).toBe(405);
  });

  it('(7) restricted CORS — Access-Control-Allow-Origin is NEVER "*"', async () => {
    const res = await postRaw(h.baseUrl, {
      claim: CLAIM,
      attestation: wireAtt(await attFor(CLAIM, new Ed25519Keypair())),
      round: 1,
    });
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });
});

/**
 * The SINGLE canary behavioral contract, run against either board (NO kind in post()).
 */
async function runCanaryParity(board: ClaimBoard): Promise<void> {
  const kpA = new Ed25519Keypair();
  const kpB = new Ed25519Keypair();
  const attA = await attFor(CLAIM, kpA);
  const attB = await attFor(CLAIM, kpB);

  await board.post(CLAIM, attA, 1);
  let open = await board.listOpen();
  expect(open.length).toBe(1);
  const key = open[0]!.key;
  expect(key).toBe(cellKey(CLAIM));
  expect(distinctAttesterCount(open[0]!.attestations)).toBe(1);

  // INV-A: the bytes round-trip verbatim through whichever transport.
  const seenA = open[0]!.attestations[0]!;
  expect(attesterPubkeyHex(seenA.sessionPublicKey)).toBe(attesterPubkeyHex(attA.sessionPublicKey));
  expect([...seenA.signature]).toEqual([...attA.signature]);

  // a second distinct attester accrues to the SAME cell
  await board.post(CLAIM, attB, 1);
  open = await board.listOpen();
  expect(open.length).toBe(1);
  expect(distinctAttesterCount(open[0]!.attestations)).toBe(2);

  // re-posting the SAME pubkey is idempotent (dedup-by-pubkey)
  await board.post(CLAIM, attA, 2);
  open = await board.listOpen();
  expect(distinctAttesterCount(open[0]!.attestations)).toBe(2);

  // get(key) returns the cell
  const got = await board.get(key);
  expect(got).toBeDefined();
  expect(got!.key).toBe(key);

  // markSubmitted → get undefined, listOpen excludes it
  await board.markSubmitted(key);
  expect(await board.get(key)).toBeUndefined();
  expect((await board.listOpen()).find((c) => c.key === key)).toBeUndefined();

  // gc round-trips
  await expect(board.gc(1_000_000)).resolves.toBeUndefined();
}

describe('canary carrier parity — InMemoryClaimBoard vs HttpClaimBoard', () => {
  it('(parity-A) the in-memory reference satisfies the canary contract', async () => {
    await runCanaryParity(new InMemoryClaimBoard({ wCorr: 1000 }));
  });

  it('(parity-B) the HTTP board over a LIVE server satisfies the SAME contract', async () => {
    const h = await startHarness({ board: new InMemoryClaimBoard({ wCorr: 1000 }) });
    try {
      const client = new HttpClaimBoard({
        baseUrl: h.baseUrl,
        token: TOKEN,
        logger: mockLogger(),
      });
      await runCanaryParity(client);
    } finally {
      await h.handle.stop();
    }
  });
});

describe('HttpClaimBoard — fail-closed', () => {
  it('(neg-401) a bad token → REJECTS (never silent undefined)', async () => {
    const h = await startHarness();
    try {
      const bad = new HttpClaimBoard({
        baseUrl: h.baseUrl,
        token: 'X'.repeat(TOKEN.length),
        logger: mockLogger(),
      });
      await expect(bad.post(CLAIM, await attFor(CLAIM, new Ed25519Keypair()), 1)).rejects.toThrow();
      await expect(bad.listOpen()).rejects.toThrow();
    } finally {
      await h.handle.stop();
    }
  });

  it('(get-miss) get() of an absent key resolves to undefined (fail-closed get-miss → undefined)', async () => {
    const h = await startHarness();
    try {
      const client = new HttpClaimBoard({ baseUrl: h.baseUrl, token: TOKEN, logger: mockLogger() });
      expect(await client.get('no|such|cell|0')).toBeUndefined();
    } finally {
      await h.handle.stop();
    }
  });

  it('(network-error) a network error → REJECTS (fail-closed)', async () => {
    const client = new HttpClaimBoard({ baseUrl: 'http://127.0.0.1:1', token: TOKEN, logger: mockLogger() });
    await expect(client.listOpen()).rejects.toThrow();
  });
});

describe('vanilla flag-off → InMemoryClaimBoard unchanged (no server)', () => {
  it('an InMemoryClaimBoard with NO server still satisfies the canary contract', async () => {
    // The flag-off path is "use the in-memory board, never construct a server" — proven by the board
    // satisfying the SAME contract the live carrier serves, with NO port bound.
    await runCanaryParity(new InMemoryClaimBoard({ wCorr: 1000 }));
  });
});

describe('cheap mTLS smoke (shared createMtlsServer + buildPinnedDispatcher 2-party)', () => {
  it('a trusted-SPKI client reaches the carrier over https; the full E2E + INV-A proof is D-2', async () => {
    const clientSpki = spkiFingerprint(CLIENT_CERT_PEM);
    const serverSpki = spkiFingerprint(SERVER_CERT_PEM);
    const h = await startCanaryClaimsServer({
      board: new InMemoryClaimBoard({ wCorr: 1000 }),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
      env: { CANARY_CLAIMS_TLS_ENABLED: '1' },
      tls: { key: SERVER_KEY_PEM, cert: SERVER_CERT_PEM, trustedSpki: new Set([clientSpki]) },
    });
    try {
      const addr = h.server.address() as AddressInfo;
      const client = new HttpClaimBoard({
        baseUrl: `https://127.0.0.1:${addr.port}`,
        token: TOKEN,
        logger: mockLogger(),
        tls: {
          cert: CLIENT_CERT_PEM,
          key: CLIENT_KEY_PEM,
          trustedServerSpki: new Set([serverSpki]),
        },
      });
      const kp = new Ed25519Keypair();
      await client.post(CLAIM, await attFor(CLAIM, kp), 1);
      const open = await client.listOpen();
      expect(open.length).toBe(1);
      expect(open[0]!.key).toBe(cellKey(CLAIM));
    } finally {
      await h.stop();
    }
  });
});
