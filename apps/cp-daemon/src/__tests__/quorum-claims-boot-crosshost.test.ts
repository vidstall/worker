/**
 * OQ-7 / ADR-0021 cross-host mTLS carrier — gap #1: the BOOT-PATH cross-host wiring (TDD RED → GREEN).
 *
 * The 2-CP-over-mTLS co-sign MECHANISM is already proven at loopback by `quorum-claims-tls-e2e.test.ts`.
 * The ONLY gap those tests do NOT cover is the BOOT PATH: the server hard-bound `127.0.0.1`, and the
 * `selectQuorumClaimsBoard` boot selector hard-coded a loopback plain-HTTP client (no peer URL, no TLS).
 * This suite drives the boot selectors themselves so a cross-host deployment (leader-hosts-board) can
 * run over mTLS, WITHOUT changing any behavior when the new env flags are unset.
 *
 *   - C1 (xh-t1): `startQuorumClaimsServer` binds on a CONFIGURED host (`QUORUM_CLAIMS_BIND_HOST` /
 *                 `opts.bindHost`), default `'127.0.0.1'` when unset (loopback byte-identical).
 *   - C2 (xh-t2): `selectQuorumClaimsBoard` derives baseUrl from `QUORUM_CLAIMS_PEER_URL` and builds a
 *                 TLS client (cert/key/trustedServerSpki) when mTLS is on; plain-HTTP loopback when off.
 *   - C3 (xh-t3): `loadQuorumClaimsCrossHostTls` loads operator manifests + certs from disk and derives
 *                 the trusted-SPKI set for BOTH server + client (the REAL manifest path, no injection).
 *   - C4 (xh-t4): leader-hosts-board — 2 CPs assemble a 2-of-2 proof THROUGH the boot selectors over a
 *                 server started with a configurable bind + mTLS, the follower pointing at the peer URL.
 *
 * HONEST scope: loopback host (127.0.0.1 — we exercise the CONFIGURABLE code path, not a WAN NIC);
 * verify_quorum is the off-chain ed25519 Move-mirror; TLS material is the test EC-P256 self-signed
 * fixtures. NO Azure, NO real IPs, NO live on-chain submit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import {
  InMemoryGenericClaimBoard,
  type QuorumClaimBoard,
  spkiFingerprint,
  signManifest,
  type OperatorManifest,
} from '@dvconf/shared';
import {
  startQuorumClaimsServer,
  type StartQuorumClaimsResult,
} from '../quorum-claims-server.js';
import { HttpQuorumClaimBoard } from '../quorum-claims-client.js';
import {
  buildCapTokenIssueBoardConfig,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from '../cap-token/index.js';
import {
  buildLocalCpKeystore,
  selectQuorumClaimsBoard,
  loadQuorumClaimsCrossHostTls,
} from '../index.js';
import type { CpOperator } from '../sui-chain-state-reader.js';
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

const TOKEN = 'quorum-claims-xh-boot-token-4f7c2a';

/** lowercase hex (no 0x) of bytes — mirrors index.ts canonicalBytesToHex. */
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

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C1 — server binds on a CONFIGURED host (default '127.0.0.1' when unset).
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('OQ-7 cross-host boot-wiring — C1 server bind host', () => {
  const started: StartQuorumClaimsResult[] = [];
  afterEach(async () => {
    while (started.length) await started.pop()!.stop();
  });

  it('(xh-t1-default-loopback) QUORUM_CLAIMS_BIND_HOST unset → binds 127.0.0.1 (byte-identical default)', async () => {
    const handle = await startQuorumClaimsServer({
      board: makeServerBoard(),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
      env: {}, // no bind host
    });
    started.push(handle);
    const addr = handle.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');
  });

  it('(xh-t1-configurable-bind) QUORUM_CLAIMS_BIND_HOST=0.0.0.0 → binds the configured host', async () => {
    const handle = await startQuorumClaimsServer({
      board: makeServerBoard(),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
      env: { QUORUM_CLAIMS_BIND_HOST: '0.0.0.0' },
    });
    started.push(handle);
    const addr = handle.server.address() as AddressInfo;
    expect(addr.address).toBe('0.0.0.0');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C2 — selectQuorumClaimsBoard: peer URL + TLS client (default loopback plain-HTTP unchanged).
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('OQ-7 cross-host boot-wiring — C2 client peer URL + tls', () => {
  it('(xh-t2-default-loopback-plain) flags unset → plain-HTTP loopback client (byte-identical default)', () => {
    const board = selectQuorumClaimsBoard({
      env: {
        QUORUM_CLAIMS_ENABLED: '1',
        QUORUM_CLAIMS_AUTH_TOKEN: TOKEN,
        QUORUM_CLAIMS_PORT: '8092',
      },
      logger: mockLogger(),
    });
    expect(board).toBeInstanceOf(HttpQuorumClaimBoard);
    expect((board as HttpQuorumClaimBoard).baseUrl).toBe('http://127.0.0.1:8092');
  });

  it('(xh-t2-peer-url-tls) mTLS on + QUORUM_CLAIMS_PEER_URL → TLS client at the peer URL', () => {
    const board = selectQuorumClaimsBoard({
      env: {
        QUORUM_CLAIMS_ENABLED: '1',
        QUORUM_CLAIMS_AUTH_TOKEN: TOKEN,
        QUORUM_CLAIMS_TLS_ENABLED: '1',
        QUORUM_CLAIMS_PEER_URL: 'https://leader.example:8092',
      },
      logger: mockLogger(),
      tls: { cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM, trustedServerSpki: new Set([SERVER_SPKI]) },
    });
    expect(board).toBeInstanceOf(HttpQuorumClaimBoard);
    expect((board as HttpQuorumClaimBoard).baseUrl).toBe('https://leader.example:8092');
  });

  it('(xh-t2-tls-on-no-material-throws) mTLS on but NO client material → fail-LOUD (refuse silent downgrade)', () => {
    expect(() =>
      selectQuorumClaimsBoard({
        env: {
          QUORUM_CLAIMS_ENABLED: '1',
          QUORUM_CLAIMS_AUTH_TOKEN: TOKEN,
          QUORUM_CLAIMS_TLS_ENABLED: '1',
          QUORUM_CLAIMS_PEER_URL: 'https://leader.example:8092',
        },
        logger: mockLogger(),
        // no tls material
      }),
    ).toThrow(/mTLS|tls|material|cert/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C3 — loadQuorumClaimsCrossHostTls: manifest-derived trust on BOTH sides, through the boot loader.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('OQ-7 cross-host boot-wiring — C3 manifest-derived cross-host tls loader', () => {
  const tmpDirs: string[] = [];
  const started: StartQuorumClaimsResult[] = [];
  afterEach(async () => {
    while (started.length) await started.pop()!.stop();
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  /** Write cert/key/signed-bundle to a temp dir; return the env the loader reads. */
  async function writeBootMaterial(): Promise<Record<string, string>> {
    const dir = mkdtempSync(join(tmpdir(), 'xh-boot-'));
    tmpDirs.push(dir);
    const certPath = join(dir, 'server-cert.pem');
    const keyPath = join(dir, 'server-key.pem');
    const bundlePath = join(dir, 'manifest-bundle.json');
    writeFileSync(certPath, SERVER_CERT_PEM, 'utf8');
    writeFileSync(keyPath, SERVER_KEY_PEM, 'utf8');

    // Two SIGNED operator manifests binding {operatorPubkey → certFingerprint(SPKI)} — the REAL trust.
    const opServer = Ed25519Keypair.generate();
    const opClient = Ed25519Keypair.generate();
    const validUntil = Date.now() + 60_000;
    const serverManifest: OperatorManifest = {
      operatorPubkey: toHex(opServer.getPublicKey().toRawBytes()),
      boardEndpoint: '127.0.0.1:8092',
      certFingerprint: SERVER_SPKI,
      validUntil,
    };
    const clientManifest: OperatorManifest = {
      operatorPubkey: toHex(opClient.getPublicKey().toRawBytes()),
      boardEndpoint: '127.0.0.1:8093',
      certFingerprint: CLIENT_SPKI,
      validUntil,
    };
    const bundle = [
      await signManifest(serverManifest, opServer),
      await signManifest(clientManifest, opClient),
    ];
    writeFileSync(bundlePath, JSON.stringify(bundle, null, 2), 'utf8');
    return {
      QUORUM_CLAIMS_TLS_ENABLED: '1',
      QUORUM_CLAIMS_TLS_CERT_PATH: certPath,
      QUORUM_CLAIMS_TLS_KEY_PATH: keyPath,
      QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH: bundlePath,
    };
  }

  it('(xh-t3-off-returns-undefined) QUORUM_CLAIMS_TLS_ENABLED unset → undefined (no file reads; byte-identical)', async () => {
    const out = await loadQuorumClaimsCrossHostTls({ env: {}, logger: mockLogger() });
    expect(out).toBeUndefined();
  });

  it('(xh-t3-loads-both-sides) manifest-derived trusted-SPKI set gates BOTH server + client', async () => {
    const env = await writeBootMaterial();
    const out = await loadQuorumClaimsCrossHostTls({ env, logger: mockLogger() });
    expect(out).toBeDefined();
    // server side
    expect(out!.serverTls.cert).toBe(SERVER_CERT_PEM);
    expect(out!.serverTls.key).toBe(SERVER_KEY_PEM);
    expect(out!.serverTls.trustedSpki.has(SERVER_SPKI)).toBe(true);
    expect(out!.serverTls.trustedSpki.has(CLIENT_SPKI)).toBe(true);
    // client side (same derived trust anchors)
    expect(out!.clientTls.cert).toBe(SERVER_CERT_PEM);
    expect(out!.clientTls.trustedServerSpki.has(SERVER_SPKI)).toBe(true);
    expect(out!.clientTls.trustedServerSpki.has(CLIENT_SPKI)).toBe(true);
  });

  it('(xh-t3-boot-roundtrip) a real post→get round-trips over an mTLS carrier built from the loaded material', async () => {
    const env = await writeBootMaterial();
    const loaded = await loadQuorumClaimsCrossHostTls({ env, logger: mockLogger() });
    expect(loaded).toBeDefined();

    // Server uses the manifest-derived serverTls (trusts the client SPKI via the derived set).
    const handle = await startQuorumClaimsServer({
      board: makeServerBoard(),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
      env: { QUORUM_CLAIMS_TLS_ENABLED: '1', QUORUM_CLAIMS_BIND_HOST: '127.0.0.1' },
      tls: loaded!.serverTls,
    });
    started.push(handle);
    const addr = handle.server.address() as AddressInfo;
    const baseUrl = `https://127.0.0.1:${addr.port}`;

    // Client presents the CLIENT cert/key + trusts the manifest-derived server SPKI set.
    const board = new HttpQuorumClaimBoard({
      baseUrl,
      token: TOKEN,
      logger: mockLogger(),
      tls: { cert: CLIENT_CERT_PEM, key: CLIENT_KEY_PEM, trustedServerSpki: loaded!.clientTls.trustedServerSpki },
    });

    const cpB = Ed25519Keypair.generate();
    const canonicalMsg = new TextEncoder().encode(`xh-t3-boot-${cpB.toSuiAddress()}`);
    const claim = issueClaim(canonicalMsg);
    const att = await selfAttest(cpB, canonicalMsg);
    await board.post('captoken-issue', claim, att, 0);

    const cellKey = `captoken-issue|${toHex(canonicalMsg)}`;
    const cell = await board.get(cellKey);
    expect(cell).toBeDefined();
    expect(cell!.attestations.length).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// C4 — leader-hosts-board: 2 CPs assemble a 2-of-2 proof THROUGH the boot selectors over mTLS.
// ───────────────────────────────────────────────────────────────────────────────────────────────
describe('OQ-7 cross-host boot-wiring — C4 leader-hosts-board 2-of-2 via boot path', () => {
  const started: StartQuorumClaimsResult[] = [];
  afterEach(async () => {
    while (started.length) await started.pop()!.stop();
  });

  it('(xh-t4-assemble-2of2-crosshost) server(configurable bind + mTLS) + 2 boot-selected TLS clients assemble 2-of-2', async () => {
    // The leader board — started with an EXPLICIT (configurable) bind host + injected mTLS server material.
    const serverTls = { key: SERVER_KEY_PEM, cert: SERVER_CERT_PEM, trustedSpki: new Set([CLIENT_SPKI]) };
    const handle = await startQuorumClaimsServer({
      board: makeServerBoard(),
      portOverride: 0,
      authTokenOverride: TOKEN,
      logger: mockLogger(),
      env: { QUORUM_CLAIMS_TLS_ENABLED: '1', QUORUM_CLAIMS_BIND_HOST: '127.0.0.1' },
      tls: serverTls,
    });
    started.push(handle);
    const addr = handle.server.address() as AddressInfo;
    const baseUrl = `https://127.0.0.1:${addr.port}`;

    const clientTls = {
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      trustedServerSpki: new Set([SERVER_SPKI]),
    };
    // Both CPs build their board THROUGH the boot selector (follower topology: peer URL = the leader).
    const boardEnv = {
      QUORUM_CLAIMS_ENABLED: '1',
      QUORUM_CLAIMS_AUTH_TOKEN: TOKEN,
      QUORUM_CLAIMS_TLS_ENABLED: '1',
      QUORUM_CLAIMS_PEER_URL: baseUrl,
    };
    const boardA = selectQuorumClaimsBoard({ env: boardEnv, logger: mockLogger(), tls: clientTls });
    const boardB = selectQuorumClaimsBoard({ env: boardEnv, logger: mockLogger(), tls: clientTls });
    expect(boardA).toBeInstanceOf(HttpQuorumClaimBoard);
    expect(boardB).toBeInstanceOf(HttpQuorumClaimBoard);

    const cpA = Ed25519Keypair.generate();
    const cpB = Ed25519Keypair.generate();
    const canonicalMsg = new TextEncoder().encode(`xh-t4-assemble-${cpA.toSuiAddress()}`);
    const discoveredCps: CpOperator[] = [
      { minerId: '0xa', operator: cpA.toSuiAddress() },
      { minerId: '0xb', operator: cpB.toSuiAddress() },
    ];

    const keystoreA = buildLocalCpKeystore({
      signer: cpA,
      logger: mockLogger(),
      quorumCollector: {
        board: boardA as HttpQuorumClaimBoard,
        discoveredCps,
        minQuorum: 2,
        pollIntervalMs: 5,
        maxPollRounds: 400,
      },
    });

    const claim = issueClaim(canonicalMsg);
    const attB = await selfAttest(cpB, canonicalMsg);
    await (boardB as HttpQuorumClaimBoard).post('captoken-issue', claim, attB, 0);

    const { qs, pubkeys, aggregateSig } = await keystoreA.collectQuorumSignatures(canonicalMsg, 2);
    expect(qs.signers.length).toBe(2);
    expect(qs.signatures.length).toBe(2);
    expect(new Set(qs.signers)).toEqual(new Set([cpA.toSuiAddress(), cpB.toSuiAddress()]));
    for (let i = 0; i < qs.signers.length; i++) {
      const pk = new Ed25519PublicKey(Uint8Array.from(pubkeys[i]));
      expect(await pk.verify(canonicalMsg, Uint8Array.from(qs.signatures[i]))).toBe(true);
    }
    expect(aggregateSig[0]).toBe(0x01);
    expect(aggregateSig.length).toBe(1 + 64 + 64);
  });
});
