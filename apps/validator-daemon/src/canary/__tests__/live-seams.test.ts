/**
 * Stage 4 (multi-cp-quorum) — `live-seams.ts` UNIT tests. HERMETIC: temp files only (manifest
 * bundle / keys file / PEM), NO network, NO live daemon, NO chain. These pin the flag-gated
 * construction of the 3 LIVE canary verify-loop seams (`{ submit, coObserverBoards, capture,
 * getRelayRoomScopes }`) the demo slash plane wires in.
 *
 * What is PINNED here (per STAGE4-WIRING-BRIEF.md "Workflow shape" + TDD mandate):
 *   (a) flag OFF / unset  -> buildLiveSeams returns null (index.ts keeps the no-op seams,
 *       byte-identical vanilla).
 *   (b) flag ON + fixture env + temp manifest-bundle + temp keys file -> returns submit +
 *       coObserverBoards (>=1 peer) + capture + getRelayRoomScopes (>=1 synthetic scope).
 *   (c) LOAD-BEARING: the INJECTED capture, fed through the REAL verifier + classifier via two
 *       helper-built daemons sharing a board, PROMOTES to a TAMPER (p=1) and the (fake) submit
 *       FIRES with a well-formed >=2-distinct proof -> the demo slash path will actually slash.
 *   (d) INV-C: the constructed wire payload (the self-attestation that fans out) carries ONLY a
 *       Wallet-B {pubkey,sig}; nothing leaks CANARY_CELL_SECRET nor a Wallet-A<->Wallet-B mapping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiClient } from '@mysten/sui/client';
import { signManifest, type OperatorManifest, type SignedManifest } from '@dvconf/shared';
import { buildLiveSeams, loadCanaryTls, resolveRelayPipeFromManifest } from '../live-seams.js';
import {
  runCanaryVerifyRound,
  type CanaryVerifyDeps,
  type CanarySlashSubmit,
} from '../verify-loop.js';
import { type CanaryValidator } from '../cell.js';
import { OBSERVED_HASH_MISSING, buildDivergenceProof, type DivergenceProof } from '../proof.js';
import { InMemoryClaimBoard } from '../claim-board.js';

// ── fixture constants (the demo config the helper sources, NOT test literals on the wire) ──
const RELAY_MINER = 'demo-relay-miner-id';
const ROOM_ID = 'demo-room-id';
const AUTH_TOKEN = 'demo-shared-bearer';
// A 16-byte cellSecret as lowercase hex (the salt; the helper reads CANARY_CELL_SECRET).
const CELL_SECRET_HEX = '5a'.repeat(16);

let dir: string;
let selfKp: Ed25519Keypair;
let peerKp: Ed25519Keypair;
// The relay (bondOwner) keypair written into the temp keys file — hoisted so case (f) can
// assert the constructed `submit` seam SIGNS with exactly this key (W-E9 self-slash).
let relayKp: Ed25519Keypair;

/** Build a signed manifest for `kp` over `endpoint` with a synthetic cert fingerprint. */
async function makeSigned(kp: Ed25519Keypair, endpoint: string, certFp: string): Promise<SignedManifest> {
  const manifest: OperatorManifest = {
    operatorPubkey: Buffer.from(kp.getPublicKey().toRawBytes()).toString('hex'),
    boardEndpoint: endpoint,
    certFingerprint: certFp,
    validUntil: Date.now() + 3_600_000,
  };
  return signManifest(manifest, kp);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'live-seams-'));
  selfKp = new Ed25519Keypair();
  peerKp = new Ed25519Keypair();

  // Temp manifest-bundle.json: SELF + one PEER (operatorPubkey != self).
  const bundle: SignedManifest[] = [
    await makeSigned(selfKp, '127.0.0.1:8092', 'aa'.repeat(32)),
    await makeSigned(peerKp, '127.0.0.1:8093', 'bb'.repeat(32)),
  ];
  writeFileSync(join(dir, 'manifest-bundle.json'), JSON.stringify(bundle));

  // Temp keys file (.scratch-daemon-keys.json shape): the relay entry = bondOwner (W-E9 self-slash).
  relayKp = new Ed25519Keypair();
  const keys = {
    relay: {
      secretKey: relayKp.getSecretKey(), // bech32 'suiprivkey1...'
      capId: '0xcap',
      stakeId: '0xrelaybond',
      minerId: RELAY_MINER,
    },
  };
  writeFileSync(join(dir, 'keys.json'), JSON.stringify(keys));

  // Temp PEM cert/key for THIS host (only path-presence + read are exercised hermetically).
  writeFileSync(join(dir, 'cert.pem'), '-----BEGIN CERTIFICATE-----\nFAKE\n-----END CERTIFICATE-----\n');
  writeFileSync(join(dir, 'key.pem'), '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fixture env that turns the master flag ON with all the demo inputs wired to temp files. */
function fixtureEnv(): Record<string, string | undefined> {
  return {
    CANARY_LIVE_SEAMS_ENABLED: '1',
    CANARY_CELL_SECRET: CELL_SECRET_HEX,
    CANARY_CLAIMS_TLS_ENABLED: '1',
    CANARY_CLAIMS_AUTH_TOKEN: AUTH_TOKEN,
    CANARY_TLS_CERT_PATH: join(dir, 'cert.pem'),
    CANARY_TLS_KEY_PATH: join(dir, 'key.pem'),
    CANARY_MANIFEST_BUNDLE_PATH: join(dir, 'manifest-bundle.json'),
    CANARY_DAEMON_KEYS_PATH: join(dir, 'keys.json'),
    CANARY_SELF_OPERATOR_PUBKEY: Buffer.from(selfKp.getPublicKey().toRawBytes()).toString('hex'),
    CANARY_DEMO_RELAY_MINER_ID: RELAY_MINER,
    CANARY_DEMO_ROOM_ID: ROOM_ID,
    CANARY_DEMO_CANARY_KID: '7',
    NETWORK_REGISTRY_ID: '0xnetreg',
    VALIDATOR_REGISTRY_ID: '0xvalreg',
    ROOM_MANAGER_ID: '0xroommgr',
    PACKAGE_ID: '0xpkg',
    SUI_RPC_URL: 'http://127.0.0.1:9000',
  };
}

// ─────────────────────────────────────────────────────────────────────────────────
// (a) flag OFF / unset → null (byte-identical vanilla; index.ts keeps the no-op seams)
// ─────────────────────────────────────────────────────────────────────────────────
describe('(a) master flag gate — default OFF returns null', () => {
  it('unset CANARY_LIVE_SEAMS_ENABLED → buildLiveSeams returns null', async () => {
    const env = fixtureEnv();
    delete env.CANARY_LIVE_SEAMS_ENABLED;
    expect(await buildLiveSeams(env)).toBeNull();
  });

  it('CANARY_LIVE_SEAMS_ENABLED=0 / "false" → null', async () => {
    expect(await buildLiveSeams({ ...fixtureEnv(), CANARY_LIVE_SEAMS_ENABLED: '0' })).toBeNull();
    expect(await buildLiveSeams({ ...fixtureEnv(), CANARY_LIVE_SEAMS_ENABLED: 'false' })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (b) flag ON → all 3 seams + scope present
// ─────────────────────────────────────────────────────────────────────────────────
describe('(b) flag ON → constructs submit + coObserverBoards(>=1) + capture + getRelayRoomScopes', () => {
  it('returns the live deps shape from temp manifest-bundle + keys file', async () => {
    const seams = await buildLiveSeams(fixtureEnv());
    expect(seams).not.toBeNull();
    expect(typeof seams!.submit).toBe('function');
    expect(typeof seams!.capture).toBe('function');
    expect(typeof seams!.getRelayRoomScopes).toBe('function');
    expect(Array.isArray(seams!.coObserverBoards)).toBe(true);
    expect(seams!.coObserverBoards.length).toBeGreaterThanOrEqual(1);

    const scopes = seams!.getRelayRoomScopes!();
    expect(scopes.length).toBeGreaterThanOrEqual(1);
    expect(scopes[0]).toEqual({ relayId: RELAY_MINER, roomId: ROOM_ID });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (c) LOAD-BEARING — injected capture PROMOTES to a TAMPER (p=1) → submit fires >=2-distinct
// ─────────────────────────────────────────────────────────────────────────────────
describe('(c) injected capture promotes to a TAMPER (p=1) → demo slash path fires', () => {
  it('two helper-built daemons sharing a board reach >=2-distinct and SUBMIT a well-formed proof', async () => {
    const seams = await buildLiveSeams(fixtureEnv());
    expect(seams).not.toBeNull();

    const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };
    const PEER: CanaryValidator = { minerId: 'peer-miner', sessionWallet: 'peer-session' };

    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const fakeSubmit: CanarySlashSubmit = async (proof) => {
      submitted.push(proof);
    };

    // Two daemons over the SAME board with DISTINCT session keypairs (mirrors verify-loop.test.ts
    // runShared). Both reuse the helper's INJECTED capture + getRelayRoomScopes; the rest is the
    // ambient deps index.ts already supplies live (getValidators/getStunLossBps/config).
    const mkDeps = (selfSessionKeypair: Ed25519Keypair): CanaryVerifyDeps => ({
      getRelayRoomScopes: seams!.getRelayRoomScopes!,
      getValidators: () => [SELF, PEER],
      getStunLossBps: () => 0n,
      capture: seams!.capture,
      localBoard: board,
      coObserverBoards: [],
      selfSessionKeypair,
      submit: fakeSubmit,
      config: { k: 2, deltaBps: 0n, sendRate: 5 },
    });

    const a = mkDeps(new Ed25519Keypair());
    const b = mkDeps(new Ed25519Keypair());

    // A TAMPER (p=1) promotes in a SINGLE round; run 2 rounds so both daemons corroborate on the
    // shared board → >=2-distinct → submit fires.
    let accA: Awaited<ReturnType<typeof runCanaryVerifyRound>>['accumulator'] | undefined;
    let accB: Awaited<ReturnType<typeof runCanaryVerifyRound>>['accumulator'] | undefined;
    let promotedSeen = 0;
    for (let r = 0; r < 2; r++) {
      const ra = await runCanaryVerifyRound(a, accA, r);
      accA = ra.accumulator;
      promotedSeen += ra.promoted.length;
      const rb = await runCanaryVerifyRound(b, accB, r);
      accB = rb.accumulator;
    }

    // The injected divergence promoted as a TAMPER (p=1, single round).
    expect(promotedSeen).toBeGreaterThan(0);
    // The shared-board >=2-distinct quorum submitted a well-formed proof.
    expect(submitted.length).toBeGreaterThan(0);
    const proof = submitted[0]!;
    expect(proof.relayMinerId).toBe(RELAY_MINER);
    expect(proof.roomId).toBe(ROOM_ID);
    // TAMPER = present-but-different (NOT a drop / MISSING).
    expect(proof.observedHash).not.toBe(OBSERVED_HASH_MISSING);
    expect(proof.expectedHash).not.toBe(proof.observedHash);
    // >=2 DISTINCT Wallet-B attesters.
    const distinct = new Set(proof.attestations.map((x) => Buffer.from(x.sessionPublicKey).toString('hex')));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (d) INV-C — no CANARY_CELL_SECRET and no Wallet-A<->Wallet-B mapping on the wire payload
// ─────────────────────────────────────────────────────────────────────────────────
describe('(d) INV-C — the wire payload leaks no salt and no Wallet-A<->Wallet-B mapping', () => {
  it('the fanned-out attestation carries only a 32B pubkey + 64B sig (no cellSecret, no Wallet-A id)', async () => {
    const seams = await buildLiveSeams(fixtureEnv());
    expect(seams).not.toBeNull();

    const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };
    const PEER: CanaryValidator = { minerId: 'peer-miner', sessionWallet: 'peer-session' };
    const board = new InMemoryClaimBoard({ wCorr: 100 });

    const deps: CanaryVerifyDeps = {
      getRelayRoomScopes: seams!.getRelayRoomScopes!,
      getValidators: () => [SELF, PEER],
      getStunLossBps: () => 0n,
      capture: seams!.capture,
      localBoard: board,
      coObserverBoards: [],
      selfSessionKeypair: new Ed25519Keypair(),
      submit: async () => {},
      config: { k: 2, deltaBps: 0n, sendRate: 5 },
    };
    await runCanaryVerifyRound(deps, undefined, 0);

    const open = await board.listOpen();
    expect(open.length).toBeGreaterThan(0);
    const cellSecretBytes = Buffer.from(CELL_SECRET_HEX, 'hex');
    for (const cell of open) {
      for (const att of cell.attestations) {
        // Only the two raw-byte fields exist; their lengths are the Wallet-B {pubkey,sig} shape.
        expect(Object.keys(att).sort()).toEqual(['sessionPublicKey', 'signature']);
        expect(att.sessionPublicKey.length).toBe(32);
        expect(att.signature.length).toBe(64);
        // The salt never appears inside any attestation field.
        expect(Buffer.from(att.sessionPublicKey).includes(cellSecretBytes)).toBe(false);
        expect(Buffer.from(att.signature).includes(cellSecretBytes)).toBe(false);
      }
      // The claim carries only public ids — no Wallet-A (operator) pubkey, no cellSecret.
      const claimJson = JSON.stringify(cell.claim);
      expect(claimJson.includes(CELL_SECRET_HEX)).toBe(false);
      expect(claimJson.includes(Buffer.from(selfKp.getPublicKey().toRawBytes()).toString('hex'))).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (e) Stage 4.5 — loadCanaryTls: own PEM + the trusted-peer SPKI set, SHARED by the client boards
//     AND the local /canary/claims SERVER (index.ts) so the same pin set guards BOTH directions.
// ─────────────────────────────────────────────────────────────────────────────────
describe('(e) loadCanaryTls — own cert/key + trusted-peer SPKI set from the OOB bundle', () => {
  it('reads this host PEM and distills the 2-entry trusted SPKI set (both manifests certFingerprint)', async () => {
    const tls = await loadCanaryTls(fixtureEnv());
    expect(tls.cert).toContain('BEGIN CERTIFICATE');
    expect(tls.key).toContain('BEGIN PRIVATE KEY');
    // The set the SERVER pins as trustedClientSpki == what the CLIENT pins as trustedServerSpki:
    // every manifest's certFingerprint (self 'aa'*32 + peer 'bb'*32) — single-sourced, both directions.
    expect(tls.trustedSpki instanceof Set).toBe(true);
    expect(tls.trustedSpki.size).toBe(2);
    expect(tls.trustedSpki.has('aa'.repeat(32))).toBe(true);
    expect(tls.trustedSpki.has('bb'.repeat(32))).toBe(true);
  });

  it('throws fail-loud when a required TLS path is unset', async () => {
    const env = fixtureEnv();
    delete env.CANARY_TLS_CERT_PATH;
    await expect(loadCanaryTls(env)).rejects.toThrow(/CANARY_TLS_CERT_PATH/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (f) CARRY (multi-cp-quorum step-3) — the constructed `submit` seam, INVOKED via the
//     `createClient` hook. The WAN run exercised this path live, but no automated test
//     drove the REAL seam (cases a-e use a FAKE submit). This pins the 4a wiring without a
//     socket: lazy single-client, the W-E9 relay-self-slash signer, and the fail-loud path.
// ─────────────────────────────────────────────────────────────────────────────────
describe('(f) the constructed submit seam invokes createClient + signs with the relay key (W-E9)', () => {
  /**
   * A real >=2-distinct proof (buildDivergenceProof). roomId/relayMinerId MUST be valid 32-byte
   * Sui addresses — the PTB `tx.pure.id(...)` validates them strictly (unlike the proof builder,
   * which zero-fills non-hex). The seam hands this to the (mock) client.
   */
  async function makeProof(): Promise<DivergenceProof> {
    return buildDivergenceProof({
      roomId: `0x${'11'.repeat(32)}`,
      relayMinerId: `0x${'22'.repeat(32)}`,
      canaryId: 7,
      frameSeq: 2,
      expectedHash: 'aa'.repeat(32),
      observedHash: 'bb'.repeat(32),
      sessionKeypairs: [new Ed25519Keypair(), new Ed25519Keypair()],
    });
  }

  /** A mock SuiClient that records the signer/tx and returns a successful (or failing) result. */
  function mockClient(status: 'success' | 'failure') {
    const calls = { sign: [] as Array<{ signer: unknown; transaction: unknown }>, wait: [] as string[] };
    const client = {
      signAndExecuteTransaction: async (args: { signer: unknown; transaction: unknown }) => {
        calls.sign.push(args);
        return { digest: '0xdeadbeef', effects: { status: { status, error: 'E_DEMO' } } };
      },
      waitForTransaction: async (args: { digest: string }) => {
        calls.wait.push(args.digest);
        return {};
      },
    } as unknown as SuiClient;
    return { client, calls };
  }

  it('lazily creates ONE client (SUI_RPC_URL), reuses it, and signs with the relay bond owner', async () => {
    const rpcUrls: string[] = [];
    const { client, calls } = mockClient('success');
    const seams = await buildLiveSeams(fixtureEnv(), {
      createClient: (rpcUrl: string) => {
        rpcUrls.push(rpcUrl);
        return client;
      },
    });
    expect(seams).not.toBeNull();

    // LAZY: construction opens no socket — createClient untouched until the first submit.
    expect(rpcUrls).toEqual([]);

    const proof = await makeProof();
    await seams!.submit(proof);

    // First submit created exactly one client, pointed at the env RPC url.
    expect(rpcUrls).toEqual(['http://127.0.0.1:9000']);
    expect(calls.sign.length).toBe(1);
    expect(calls.wait).toEqual(['0xdeadbeef']);

    // W-E9: the slash tx is SIGNED BY THE RELAY (bond owner) — the keypair from the keys file,
    // NOT a validator key. Address-compare the recorded signer to the hoisted relay keypair.
    const signer = calls.sign[0]!.signer as Ed25519Keypair;
    expect(signer.toSuiAddress()).toBe(relayKp.toSuiAddress());
    // A Transaction was handed in (PTB content is pinned by slash-submitter + the localnet E2E).
    expect(calls.sign[0]!.transaction).toBeDefined();

    // Second submit REUSES the cached client (lazy single-client) — no new createClient call.
    await seams!.submit(proof);
    expect(rpcUrls).toEqual(['http://127.0.0.1:9000']);
    expect(calls.sign.length).toBe(2);
  });

  it('propagates a fail-loud error when the chain reports a non-success status', async () => {
    const { client } = mockClient('failure');
    const seams = await buildLiveSeams(fixtureEnv(), { createClient: () => client });
    const proof = await makeProof();
    await expect(seams!.submit(proof)).rejects.toThrow(/failed on-chain/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (g) B3 (REQ-MLW-B-13) — resolveRelayPipeFromManifest: the AUTHENTICATED signed relay pipe
//     endpoint (from the v2 OOB manifest) takes precedence over the unsigned CANARY_PIPE_PARAMS_PATH
//     file. The lookup key MUST match loadManifests' Map key (lowercase raw-pubkey hex, no `0x`).
// ─────────────────────────────────────────────────────────────────────────────────
describe('(g) resolveRelayPipeFromManifest — authenticated relay pipe from the v2 OOB manifest', () => {
  const pubHex = (kp: Ed25519Keypair): string =>
    Buffer.from(kp.getPublicKey().toRawBytes()).toString('hex');

  it('returns {ip,port} for a relayPipe-bearing signed manifest', async () => {
    const kp = new Ed25519Keypair();
    const m: OperatorManifest = {
      operatorPubkey: pubHex(kp),
      boardEndpoint: '127.0.0.1:8092',
      certFingerprint: 'cc'.repeat(32),
      validUntil: Date.now() + 3_600_000,
      relayPipe: { ip: '10.9.9.9', port: 40001 },
    };
    const bundle: SignedManifest[] = [await signManifest(m, kp)];
    const bundlePath = join(dir, 'pipe-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle));
    const env = {
      CANARY_MANIFEST_BUNDLE_PATH: bundlePath,
      CANARY_RELAY_OPERATOR_PUBKEY: pubHex(kp),
    };
    const r = await resolveRelayPipeFromManifest(env);
    expect(r).toEqual({ ip: '10.9.9.9', port: 40001 });
  });

  it('returns null without the env (falls back to the unsigned file)', async () => {
    expect(await resolveRelayPipeFromManifest({})).toBeNull();
  });

  it('returns null when the matching manifest carries NO relayPipe (pure trust anchor)', async () => {
    const kp = new Ed25519Keypair();
    const bundle: SignedManifest[] = [await makeSigned(kp, '127.0.0.1:8092', 'dd'.repeat(32))];
    const bundlePath = join(dir, 'nopipe-bundle.json');
    writeFileSync(bundlePath, JSON.stringify(bundle));
    const r = await resolveRelayPipeFromManifest({
      CANARY_MANIFEST_BUNDLE_PATH: bundlePath,
      CANARY_RELAY_OPERATOR_PUBKEY: pubHex(kp),
    });
    expect(r).toBeNull();
  });
});
