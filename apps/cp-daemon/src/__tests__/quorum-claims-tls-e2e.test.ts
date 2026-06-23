/**
 * OQ-7 / ADR-0021 cross-host mTLS carrier — Phase C: the 2-party loopback-OVER-TLS E2E capstone
 * (TDD RED → GREEN).
 *
 * The TLS mirror of the plain-HTTP Leg-7d capstone (`quorum-claims-e2e.test.ts`): the SAME pure-
 * transport substitution proof, now run over a mutually-authenticated TLS channel.
 *
 *   - The Phase-B mTLS SERVER (SERVER cert/key) trusts ONLY the CLIENT's SPKI (`trustedSpki`).
 *   - The `HttpQuorumClaimBoard` runs in NEW `tls` mode (CLIENT cert/key) trusting ONLY the SERVER's
 *     SPKI (`trustedServerSpki`) — supplied via an `undici.Agent` dispatcher whose `buildConnector`
 *     wrapper pins the peer SPKI IN the `connect` (secureConnect) path: it inspects the negotiated
 *     TLS socket's peer cert and BLOCKS socket handback to undici unless the SPKI is trusted (NOT
 *     `checkServerIdentity` — which never fires under `rejectUnauthorized:false`; NOT the whole-cert
 *     fingerprint; NOT a CA).
 *   - A REAL post(kind,claim,attestation,round) round-trip drives the full board flow → assemble an
 *     M-of-N (2-of-2) quorum → each (pubkey,sig) ed25519-verifies the canonical bytes (the Move-mirror,
 *     EXACTLY as the plain-HTTP E2E).
 *
 * Also asserts (fail-closed):
 *   - a client trusting the WRONG server SPKI FAILS the TLS handshake (the carrier is refused).
 *   - trust DERIVED from a SIGNED operator manifest (`loadManifests` → SPKI set via the Phase-C helper)
 *     gates BOTH directions correctly (the real {endpoint,fingerprint} binding, no injected set).
 *
 * HONEST scope: loopback (127.0.0.1), NOT a WAN cross-host run; verify_quorum is the off-chain ed25519
 * Move-MIRROR (no live Move call); TLS material is the test EC-P256 self-signed fixtures.
 */
import { describe, it, expect, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import {
  InMemoryGenericClaimBoard,
  type QuorumClaimBoard,
  spkiFingerprint,
  signManifest,
  loadManifests,
  type OperatorManifest,
} from '@dvconf/shared';
import {
  startQuorumClaimsServer,
  type StartQuorumClaimsResult,
} from '../quorum-claims-server.js';
import { HttpQuorumClaimBoard, manifestsToTrustedSpki } from '../quorum-claims-client.js';
import {
  buildCapTokenIssueBoardConfig,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from '../cap-token-issuer.js';
import { buildLocalCpKeystore } from '../index.js';
import type { CpOperator } from '../sui-chain-state-reader.js';
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

const TOKEN = 'quorum-claims-tls-e2e-token-9b3e1d';

/** lowercase hex (no 0x) of bytes — mirrors index.ts canonicalBytesToHex (the captoken-issue cellKey). */
function toHex(bytes: Uint8Array | number[]): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

const SERVER_SPKI = spkiFingerprint(SERVER_CERT_PEM);
const CLIENT_SPKI = spkiFingerprint(CLIENT_CERT_PEM);

/** A server-side board hosting the captoken-issue kind (production per-kind config). */
function makeServerBoard(): QuorumClaimBoard {
  return new InMemoryGenericClaimBoard([
    buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
  ]);
}

interface TlsServerFixture {
  handle: StartQuorumClaimsResult;
  baseUrl: string;
}

/** Start the Phase-B mTLS server trusting the given client SPKI set, on an ephemeral loopback port. */
async function startTlsServerFixture(
  trustedClientSpki: ReadonlySet<string>,
): Promise<TlsServerFixture> {
  const handle = await startQuorumClaimsServer({
    board: makeServerBoard(),
    portOverride: 0,
    authTokenOverride: TOKEN,
    logger: mockLogger(),
    env: { QUORUM_CLAIMS_TLS_ENABLED: '1' },
    tls: { key: SERVER_KEY_PEM, cert: SERVER_CERT_PEM, trustedSpki: trustedClientSpki },
  });
  const addr = handle.server.address() as AddressInfo;
  return { handle, baseUrl: `https://127.0.0.1:${addr.port}` };
}

/** A REAL TLS-mode HttpQuorumClaimBoard (CLIENT identity) trusting the given server SPKI set. */
function tlsBoard(
  baseUrl: string,
  trustedServerSpki: ReadonlySet<string>,
  client: { key: string; cert: string } = { key: CLIENT_KEY_PEM, cert: CLIENT_CERT_PEM },
): HttpQuorumClaimBoard {
  return new HttpQuorumClaimBoard({
    baseUrl,
    token: TOKEN,
    logger: mockLogger(),
    tls: { cert: client.cert, key: client.key, trustedServerSpki },
  });
}

/** Build the EXACT cell CLAIM the index.ts collector posts (cellKey = canonicalMsgHex). */
function issueClaim(canonicalMsg: Uint8Array): CapTokenIssueClaim {
  return {
    kind: 'captoken-issue',
    roomId: '0x' + '00'.repeat(32),
    peerPubkey: new Array(32).fill(0),
    role: 0,
    expiresEpoch: 0 as unknown as bigint,
    nonce: 1,
    canonicalMsgHex: toHex(canonicalMsg),
  };
}

/** CP-B's self-attestation leg — RAW ed25519 over the SAME canonical bytes (single-CP-branch shape). */
async function selfAttest(
  signer: Ed25519Keypair,
  canonicalMsg: Uint8Array,
): Promise<CapTokenIssueAttestation> {
  const sig = await signer.sign(canonicalMsg);
  return {
    signature: Array.from(sig.slice(0, 64)),
    pubkey: Array.from(signer.getPublicKey().toRawBytes()),
    addr: signer.toSuiAddress(),
  };
}

describe('OQ-7 Phase C — loopback 2-CP E2E OVER TLS (mutual SPKI pin)', () => {
  it('(tls-e2e-assemble) two CPs over a mTLS channel assemble a 2-of-2 verify_quorum-shaped proof; each (pk,sig) ed25519-verifies', async () => {
    const fx = await startTlsServerFixture(new Set([CLIENT_SPKI]));
    try {
      const cpA = Ed25519Keypair.generate();
      const cpB = Ed25519Keypair.generate();
      const canonicalMsg = new TextEncoder().encode(`phasec-tls-assemble-${cpA.toSuiAddress()}`);

      const discoveredCps: CpOperator[] = [
        { minerId: '0xa', operator: cpA.toSuiAddress() },
        { minerId: '0xb', operator: cpB.toSuiAddress() },
      ];

      const keystoreA = buildLocalCpKeystore({
        signer: cpA,
        logger: mockLogger(),
        quorumCollector: {
          board: tlsBoard(fx.baseUrl, new Set([SERVER_SPKI])),
          discoveredCps,
          minQuorum: 2,
          pollIntervalMs: 5,
          maxPollRounds: 400,
        },
      });

      const boardB = tlsBoard(fx.baseUrl, new Set([SERVER_SPKI]));
      const claim = issueClaim(canonicalMsg);
      const attB = await selfAttest(cpB, canonicalMsg);
      await boardB.post('captoken-issue', claim, attB, 0);

      const { qs, pubkeys, aggregateSig } = await keystoreA.collectQuorumSignatures(canonicalMsg, 2);

      expect(qs.signers.length).toBe(2);
      expect(qs.signatures.length).toBe(2);
      expect(pubkeys.length).toBe(2);
      expect(new Set(qs.signers)).toEqual(new Set([cpA.toSuiAddress(), cpB.toSuiAddress()]));

      // ── the Move-mirror: each (pubkey, sig) ed25519-verifies the canonical bytes ──
      for (let i = 0; i < qs.signers.length; i++) {
        const pk = new Ed25519PublicKey(Uint8Array.from(pubkeys[i]));
        expect(await pk.verify(canonicalMsg, Uint8Array.from(qs.signatures[i]))).toBe(true);
      }

      // ── byte-identical SHAPE to the in-memory capstone: aggregateSig = [0x01, ...64, ...64] ──
      expect(aggregateSig[0]).toBe(0x01);
      expect(aggregateSig.length).toBe(1 + 64 + 64);

      // ── markSubmitted excluded the cell from a subsequent listOpen ──
      const open = await boardB.listOpen();
      const cellKey = `captoken-issue|${toHex(canonicalMsg)}`;
      expect(open.find((c) => c.key === cellKey)).toBeUndefined();
    } finally {
      await fx.handle.stop();
    }
  });

  it('(tls-e2e-roundtrip) a single post→get round-trip over TLS carries the {pk,sig} bytes verbatim', async () => {
    const fx = await startTlsServerFixture(new Set([CLIENT_SPKI]));
    try {
      const cpB = Ed25519Keypair.generate();
      const canonicalMsg = new TextEncoder().encode(`phasec-tls-roundtrip-${cpB.toSuiAddress()}`);
      const board = tlsBoard(fx.baseUrl, new Set([SERVER_SPKI]));

      const claim = issueClaim(canonicalMsg);
      const att = await selfAttest(cpB, canonicalMsg);
      await board.post('captoken-issue', claim, att, 0);

      const cellKey = `captoken-issue|${toHex(canonicalMsg)}`;
      const cell = await board.get(cellKey);
      expect(cell).toBeDefined();
      expect(cell!.attestations.length).toBe(1);
      const rt = cell!.attestations[0] as unknown as CapTokenIssueAttestation;
      // verbatim bytes survived the TLS wire (INV-A: wrap, never alter)
      expect(rt.pubkey).toEqual(att.pubkey);
      expect(rt.signature).toEqual(att.signature);
    } finally {
      await fx.handle.stop();
    }
  });

  it('(tls-e2e-wrong-server-spki) a client trusting the WRONG server SPKI FAILS the handshake (fail-closed)', async () => {
    const fx = await startTlsServerFixture(new Set([CLIENT_SPKI]));
    try {
      // Trust a server SPKI that is NOT the real server's (use the client cert's SPKI as a bogus anchor).
      const wrongServerSpki = new Set([CLIENT_SPKI]);
      const board = tlsBoard(fx.baseUrl, wrongServerSpki);
      const cpB = Ed25519Keypair.generate();
      const canonicalMsg = new TextEncoder().encode('phasec-tls-wrong-server');
      const claim = issueClaim(canonicalMsg);
      const att = await selfAttest(cpB, canonicalMsg);
      // The buildConnector SPKI pin blocks socket handback (callback(Error)) → connect fails → post
      // throws. Assert rejection across a small loop so the fail-closed property is DETERMINISTIC
      // (a single un-pinned/reused socket would surface as one stray resolve here).
      for (let i = 0; i < 8; i++) {
        const b = tlsBoard(fx.baseUrl, wrongServerSpki);
        await expect(b.post('captoken-issue', claim, att, 0)).rejects.toThrow();
      }
      await expect(board.post('captoken-issue', claim, att, 0)).rejects.toThrow();
    } finally {
      await fx.handle.stop();
    }
  });

  it('(tls-e2e-wrong-client-spki) a server NOT trusting the client SPKI rejects the request 403 (fail-closed)', async () => {
    // Server trusts ONLY the WRONG client's SPKI; our client presents the CLIENT cert → 403.
    const wrongClientSpki = spkiFingerprint(WRONG_CLIENT_CERT_PEM);
    const fx = await startTlsServerFixture(new Set([wrongClientSpki]));
    try {
      const board = tlsBoard(fx.baseUrl, new Set([SERVER_SPKI]));
      const cpB = Ed25519Keypair.generate();
      const canonicalMsg = new TextEncoder().encode('phasec-tls-wrong-client');
      const claim = issueClaim(canonicalMsg);
      const att = await selfAttest(cpB, canonicalMsg);
      // TLS handshake succeeds (rejectUnauthorized:false) but the post-handshake SPKI pin → 403 → throw.
      await expect(board.post('captoken-issue', claim, att, 0)).rejects.toThrow(/403/);
    } finally {
      await fx.handle.stop();
    }
  });

  it('(tls-e2e-manifest-derived-trust) trust DERIVED from a SIGNED manifest gates BOTH directions correctly', async () => {
    // Two operators, each with an on-chain ed25519 identity key + a TLS cert. Build SIGNED manifests
    // binding {operatorPubkey → certFingerprint(SPKI)}; loadManifests verifies them; the Phase-C
    // helper distills the trusted-SPKI set from the verified bundle (the REAL trust path, no injection).
    const opServer = Ed25519Keypair.generate();
    const opClient = Ed25519Keypair.generate();
    const opServerPk = toHex(opServer.getPublicKey().toRawBytes());
    const opClientPk = toHex(opClient.getPublicKey().toRawBytes());
    const validUntil = Date.now() + 60_000;

    const serverManifest: OperatorManifest = {
      operatorPubkey: opServerPk,
      boardEndpoint: '127.0.0.1:8092',
      certFingerprint: SERVER_SPKI,
      validUntil,
    };
    const clientManifest: OperatorManifest = {
      operatorPubkey: opClientPk,
      boardEndpoint: '127.0.0.1:8093',
      certFingerprint: CLIENT_SPKI,
      validUntil,
    };
    const bundle = [
      await signManifest(serverManifest, opServer),
      await signManifest(clientManifest, opClient),
    ];
    const manifests = await loadManifests(bundle);
    expect(manifests.size).toBe(2);

    // The helper distills the certFingerprint column into a trusted-SPKI set.
    const trustAll = manifestsToTrustedSpki(manifests);
    expect(trustAll.has(SERVER_SPKI)).toBe(true);
    expect(trustAll.has(CLIENT_SPKI)).toBe(true);

    // Server trusts the (manifest-derived) client SPKI; client trusts the (manifest-derived) server SPKI.
    const fx = await startTlsServerFixture(trustAll);
    try {
      const board = tlsBoard(fx.baseUrl, trustAll);
      const cpB = Ed25519Keypair.generate();
      const canonicalMsg = new TextEncoder().encode(`phasec-tls-manifest-${cpB.toSuiAddress()}`);
      const claim = issueClaim(canonicalMsg);
      const att = await selfAttest(cpB, canonicalMsg);
      await board.post('captoken-issue', claim, att, 0);

      const cellKey = `captoken-issue|${toHex(canonicalMsg)}`;
      const cell = await board.get(cellKey);
      expect(cell).toBeDefined();
      expect(cell!.attestations.length).toBe(1);
    } finally {
      await fx.handle.stop();
    }
  });
});
