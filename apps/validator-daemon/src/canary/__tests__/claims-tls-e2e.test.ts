/**
 * OQ-7 Phase D-2 (CANARY CARRIER) — the 2-party mTLS END-TO-END integration proof.
 *
 * D-1 SHIPPED the TLS plumbing (the server `createMtlsServer` fork behind `CANARY_CLAIMS_TLS_ENABLED`
 * + the `HttpClaimBoard` client `buildPinnedDispatcher` path) and ONE cheap https smoke. D-2 is the
 * FULL integration proof: a REAL https carrier (SERVER cert, trusted-CLIENT-SPKI pin) + a REAL
 * `HttpClaimBoard` client (CLIENT cert, trusted-SERVER-SPKI pin) over a mutually-authenticated TLS
 * channel, asserting every cross-cutting invariant of the canary claim board END-TO-END over TLS:
 *
 *   (1) INV-A verbatim over TLS    — the 145-byte canonical proof message + the 64-byte signature ride
 *                                    the mTLS carrier BYTE-IDENTICAL and re-verify against the pubkey.
 *   (2) >=2 distinct-attester quorum over TLS — two distinct Wallet-B self-attestations accrue to the
 *                                    same cell; `assembleProofFromAttestations` yields a 2-attester proof.
 *   (3) INV-C fail-closed over TLS  — a forbidden-field post (auditor minerId / Wallet-A signatureA)
 *                                    rides the SAME pinned dispatcher → 400, the cell is NOT stored.
 *   (4) SPKI pin fail-closed over TLS — a client trusting the WRONG server SPKI REJECTS every request
 *                                    (looped to catch the Phase-C nondeterministic-handback flake).
 *   (5) bearer over TLS            — a correct-mTLS but WRONG-bearer client gets 401 (defense-in-depth).
 *   (6) vanilla flag-off unchanged — the plain node:http carrier round-trip is byte-identical (no regression).
 *
 * This file ADDS NO production code: it is a green-on-first-run integration assertion over the
 * already-shipped D-1 plumbing (the RED state is the no-impl-file / import-resolution state — see the
 * phase-d2 RED log). The FROZEN surfaces (proof.ts 145-byte `canonicalProofMessage`, claim-board.ts)
 * are imported, NEVER edited (INV-A). node:* / undici ride FRESH or transitively via @dvconf/shared
 * (INV-B); ZERO apps/relay/ import.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { spkiFingerprint, buildPinnedDispatcher } from '@dvconf/shared';
import {
  InMemoryClaimBoard,
  cellKey,
  type ClaimBoard,
} from '../claim-board.js';
import {
  signSelfAttestation,
  canonicalProofMessage,
  assembleProofFromAttestations,
  distinctAttesterCount,
  CANARY_PROOF_MSG_LEN,
  MIN_ATTESTERS,
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
  SERVER_KEY_PEM,
  SERVER_CERT_PEM,
  CLIENT_KEY_PEM,
  CLIENT_CERT_PEM,
  WRONG_CLIENT_KEY_PEM,
  WRONG_CLIENT_CERT_PEM,
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

const TOKEN = 'canary-claims-e2e-token-7f3c2d';

/** The trust anchors derived from the fixture certs (the same derivation the D-1 carrier test uses). */
const CLIENT_SPKI = spkiFingerprint(CLIENT_CERT_PEM);
const SERVER_SPKI = spkiFingerprint(SERVER_CERT_PEM);
const WRONG_SPKI = spkiFingerprint(WRONG_CLIENT_CERT_PEM);

const CLAIM: DivergenceClaim = {
  roomId: '0x' + 'ab'.repeat(32),
  relayMinerId: '0x' + 'cd'.repeat(32),
  canaryId: 42,
  frameSeq: 7,
  expectedHash: 'ef'.repeat(32),
  observedHash: '12'.repeat(32),
};

/** A second DISTINCT claim (for cells we want isolated from CLAIM). */
const CLAIM_DROP: DivergenceClaim = {
  roomId: '0x' + '99'.repeat(32),
  relayMinerId: '0x' + '88'.repeat(32),
  canaryId: 3,
  frameSeq: 11,
  expectedHash: '77'.repeat(32),
  observedHash: OBSERVED_HASH_MISSING,
};

const msgFor = (c: DivergenceClaim): Uint8Array =>
  canonicalProofMessage({ ...c, sessionKeypairs: [] });

async function attFor(c: DivergenceClaim, kp: Ed25519Keypair): Promise<DivergenceAttestation> {
  return signSelfAttestation(msgFor(c), kp);
}

/** Wire form of an attestation: {pubkey,sig} base64 (matches HttpClaimBoard's codec). */
function wireAtt(a: DivergenceAttestation): { pubkey: string; sig: string } {
  return {
    pubkey: Buffer.from(a.sessionPublicKey).toString('base64'),
    sig: Buffer.from(a.signature).toString('base64'),
  };
}

interface TlsHarness {
  handle: StartCanaryClaimsResult;
  baseUrl: string;
  boundPort: number;
  board: ClaimBoard;
}

/**
 * Start a REAL https mTLS carrier: SERVER key/cert, trusting only the CLIENT SPKI; OS-assigned port.
 * The matching TLS client below pins the SERVER SPKI and presents the CLIENT cert.
 */
async function startTlsHarness(board?: ClaimBoard): Promise<TlsHarness> {
  const b = board ?? new InMemoryClaimBoard({ wCorr: 1000 });
  const handle = await startCanaryClaimsServer({
    board: b,
    portOverride: 0,
    authTokenOverride: TOKEN,
    logger: mockLogger(),
    env: { CANARY_CLAIMS_TLS_ENABLED: '1' },
    tls: { key: SERVER_KEY_PEM, cert: SERVER_CERT_PEM, trustedSpki: new Set([CLIENT_SPKI]) },
  });
  const boundPort = (handle.server.address() as AddressInfo).port;
  return { handle, baseUrl: `https://127.0.0.1:${boundPort}`, boundPort, board: b };
}

/** Build a correctly-pinned mTLS HttpClaimBoard client against a live TLS harness. */
function tlsClient(baseUrl: string, opts?: { token?: string; trustedServerSpki?: Set<string> }): HttpClaimBoard {
  return new HttpClaimBoard({
    baseUrl,
    token: opts?.token ?? TOKEN,
    logger: mockLogger(),
    tls: {
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      trustedServerSpki: opts?.trustedServerSpki ?? new Set([SERVER_SPKI]),
    },
  });
}

// Track the live harness so afterEach always tears it down even on an assertion throw.
let active: StartCanaryClaimsResult | undefined;
afterEach(async () => {
  if (active) {
    await active.stop();
    active = undefined;
  }
});

describe('OQ-7 D-2 — canary 2-party mTLS E2E (1) INV-A verbatim over TLS', () => {
  it('the 145-byte msg + signature ride the mTLS carrier BYTE-IDENTICAL and re-verify', async () => {
    const h = await startTlsHarness();
    active = h.handle;

    const msg = msgFor(CLAIM);
    // The signed bytes are EXACTLY the FROZEN 145-byte canonical proof message.
    expect(msg.length).toBe(145);
    expect(msg.length).toBe(CANARY_PROOF_MSG_LEN);

    const kp1 = new Ed25519Keypair();
    const att = await signSelfAttestation(msg, kp1);

    const client = tlsClient(h.baseUrl);
    await client.post(CLAIM, att, 1);

    // Retrieve over the SAME mTLS channel via get(key).
    const got = await client.get(cellKey(CLAIM));
    expect(got).toBeDefined();
    expect(got!.attestations.length).toBe(1);
    const retrieved = got!.attestations[0]!;

    // INV-A: the 32-byte pubkey + 64-byte signature are BYTE-IDENTICAL after the TLS round-trip.
    expect(Buffer.compare(Buffer.from(retrieved.sessionPublicKey), Buffer.from(att.sessionPublicKey))).toBe(0);
    expect(Buffer.compare(Buffer.from(retrieved.signature), Buffer.from(att.signature))).toBe(0);
    expect([...retrieved.sessionPublicKey]).toEqual([...att.sessionPublicKey]);
    expect([...retrieved.signature]).toEqual([...att.signature]);

    // The 145-byte message + the retrieved signature still verify against the retrieved pubkey:
    // the carrier did not alter a single byte of the signed material.
    const verified = await new Ed25519PublicKey(retrieved.sessionPublicKey).verify(msg, retrieved.signature);
    expect(verified).toBe(true);

    // listOpen path returns the same verbatim bytes too.
    const open = await client.listOpen();
    expect(open.length).toBe(1);
    const fromOpen = open[0]!.attestations[0]!;
    expect(Buffer.compare(Buffer.from(fromOpen.signature), Buffer.from(att.signature))).toBe(0);
    expect(await new Ed25519PublicKey(fromOpen.sessionPublicKey).verify(msg, fromOpen.signature)).toBe(true);
  });
});

describe('OQ-7 D-2 — canary 2-party mTLS E2E (2) >=2 distinct-attester quorum over TLS', () => {
  it('two distinct Wallet-B attestations accrue over TLS → a 2-attester DivergenceProof', async () => {
    const h = await startTlsHarness();
    active = h.handle;

    const msg = msgFor(CLAIM);
    const kp1 = new Ed25519Keypair();
    const kp2 = new Ed25519Keypair();
    const att1 = await signSelfAttestation(msg, kp1);
    const att2 = await signSelfAttestation(msg, kp2);

    const client = tlsClient(h.baseUrl);
    await client.post(CLAIM, att1, 1);
    await client.post(CLAIM, att2, 1);

    const open = await client.listOpen();
    expect(open.length).toBe(1);
    const cell = open[0]!;
    expect(cell.key).toBe(cellKey(CLAIM));
    expect(distinctAttesterCount(cell.attestations)).toBe(2);

    // The cosign-collection assembler yields a proof with exactly 2 distinct attestations.
    const proof = assembleProofFromAttestations(cell.claim, cell.attestations);
    expect(proof.attestations.length).toBe(MIN_ATTESTERS);
    expect(distinctAttesterCount(proof.attestations)).toBe(2);

    // Each assembled attestation re-verifies against the SAME 145-byte canonical message.
    for (const a of proof.attestations) {
      expect(await new Ed25519PublicKey(a.sessionPublicKey).verify(msg, a.signature)).toBe(true);
    }
  });
});

describe('OQ-7 D-2 — canary 2-party mTLS E2E (3) INV-C fail-closed over TLS', () => {
  it('a forbidden-field post over the SAME pinned dispatcher → 4xx; the cell is NOT stored', async () => {
    const h = await startTlsHarness();
    active = h.handle;

    // A clean client to read state back (and to confirm a forbidden post DID ride the mTLS channel
    // via the same SPKI pin — a build-it-yourself raw request would otherwise be untested for the pin).
    const reader = tlsClient(h.baseUrl);

    const att = await attFor(CLAIM, new Ed25519Keypair());

    // The forbidden body: an auditor `minerId` on the claim + a Wallet-A `signatureA` leg on the
    // attestation. HttpClaimBoard.post only sends clean fields, so drive a RAW request through the
    // SAME shared pinned dispatcher (client cert presented + server SPKI pinned) — the forbidden body
    // still travels the mTLS channel and must be fail-closed by the server's INV-C allow-list. The
    // dispatcher rides on the non-standard `dispatcher` fetch init field EXACTLY as HttpClaimBoard
    // does (globalThis.fetch is undici and honours it; INV-B: undici stays transitive via @dvconf/shared).
    const dispatcher = buildPinnedDispatcher({
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      trustedServerSpki: new Set([SERVER_SPKI]),
    });
    try {
      const forbiddenBody = JSON.stringify({
        claim: { ...CLAIM, minerId: '0xAUDITOR_WALLET_A', assignmentSecret: 'deadbeef' },
        attestation: { ...wireAtt(att), signatureA: 'cafef00d', minerId: '0xA' },
        round: 1,
      });
      const res = await fetch(`${h.baseUrl}/canary/claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: forbiddenBody,
        dispatcher,
      } as RequestInit);
      // INV-C fail-closed: a 4xx (the server rejects BEFORE store).
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    } finally {
      await dispatcher.close();
    }

    // The cell was NEVER stored — the forbidden post never reached the board.
    const open = await reader.listOpen();
    expect(open.length).toBe(0);
    expect(await reader.get(cellKey(CLAIM))).toBeUndefined();
  });
});

describe('OQ-7 D-2 — canary 2-party mTLS E2E (4) SPKI pin fail-closed over TLS', () => {
  it('a client trusting the WRONG server SPKI REJECTS every request (looped for the Phase-C flake)', async () => {
    const h = await startTlsHarness();
    active = h.handle;

    // The ONLY trusted server fp is the WRONG cert's — the real server SPKI is NOT in the set, so the
    // pin must fail-closed on EVERY connection. Loop to catch any nondeterministic handback (the
    // Phase-C wrong-server-spki flake where a not-yet-pinned socket could leak through).
    const ITERATIONS = 10; // >=8 required; 10 for margin.
    for (let i = 0; i < ITERATIONS; i++) {
      const badPinClient = tlsClient(h.baseUrl, { trustedServerSpki: new Set([WRONG_SPKI]) });
      await expect(
        badPinClient.post(CLAIM, await attFor(CLAIM, new Ed25519Keypair()), 1),
        `post must reject on iteration ${i}`,
      ).rejects.toThrow();
      await expect(badPinClient.listOpen(), `listOpen must reject on iteration ${i}`).rejects.toThrow();
    }

    // And nothing leaked through: a correctly-pinned reader sees an EMPTY board.
    const reader = tlsClient(h.baseUrl);
    expect((await reader.listOpen()).length).toBe(0);
  });
});

describe('OQ-7 D-2 — canary 2-party mTLS E2E (5) bearer enforced over TLS', () => {
  it('a correct-mTLS client with a WRONG bearer token → 401 (post rejects; defense-in-depth)', async () => {
    const h = await startTlsHarness();
    active = h.handle;

    // Correct mTLS material (handshake + SPKI pin BOTH pass) but a same-length WRONG bearer token.
    // The bearer must still be enforced on the mutually-authenticated channel.
    const wrongTokenClient = tlsClient(h.baseUrl, { token: 'X'.repeat(TOKEN.length) });
    await expect(
      wrongTokenClient.post(CLAIM, await attFor(CLAIM, new Ed25519Keypair()), 1),
    ).rejects.toThrow(/401/);
    await expect(wrongTokenClient.listOpen()).rejects.toThrow(/401/);

    // A correct-token client over the same TLS material still works (the channel itself is fine).
    const goodClient = tlsClient(h.baseUrl);
    await goodClient.post(CLAIM, await attFor(CLAIM, new Ed25519Keypair()), 1);
    expect((await goodClient.listOpen()).length).toBe(1);
  });
});

describe('OQ-7 D-2 — canary 2-party mTLS E2E (6) vanilla flag-off unchanged', () => {
  it('with NO tls config (plain node:http carrier) the post/get round-trip is byte-identical', async () => {
    // Flag OFF (no env, no tls) → the byte-identical node:http carrier. NO regression to the plain path.
    const handle = await startCanaryClaimsServer({
      board: new InMemoryClaimBoard({ wCorr: 1000 }),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
    });
    active = handle;
    const port = (handle.server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    const client = new HttpClaimBoard({ baseUrl, token: TOKEN, logger: mockLogger() });

    const msg = msgFor(CLAIM_DROP);
    const kp = new Ed25519Keypair();
    const att = await signSelfAttestation(msg, kp);
    await client.post(CLAIM_DROP, att, 1);

    const got = await client.get(cellKey(CLAIM_DROP));
    expect(got).toBeDefined();
    const retrieved = got!.attestations[0]!;
    // Byte-identical over the plain carrier too — the signed bytes survive verbatim.
    expect(Buffer.compare(Buffer.from(retrieved.signature), Buffer.from(att.signature))).toBe(0);
    expect(Buffer.compare(Buffer.from(retrieved.sessionPublicKey), Buffer.from(att.sessionPublicKey))).toBe(0);
    expect(await new Ed25519PublicKey(retrieved.sessionPublicKey).verify(msg, retrieved.signature)).toBe(true);
  });
});
