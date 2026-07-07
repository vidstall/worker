/*
 * Cap-token leader (VM-1) driver bin.
 *
 * Entry-point guard: main() only runs when the file is executed directly
 * (import.meta.url check pattern from captoken-cosign-attester.ts). Importing
 * collectIssueQuorum in tests does NOT trigger main().
 *
 * Responsibilities:
 *   1. Start the /quorum/claims HTTP carrier (server) so followers can POST their
 *      attestations via the network.
 *   2. Post the REAL CapTokenIssueClaim (not advisory) so followers can independently
 *      re-derive + G4 byte-match + sign (via rebuildCanonicalAndSignIfMatches).
 *   3. Self-attest as leader (RAW ed25519, single-CP branch shape).
 *   4. Poll until minQuorum distinct attestations are collected.
 *   5. Assemble the IssueQuorum via assembleCapTokenQuorum (OQ-1 operator-membership gate).
 *   6. Submit buildIssueQuorumTx → waitForTransaction → log digest + issuerQuorum.
 *
 * Exports:
 *   collectIssueQuorum  -- the testable core (board-path quorum collection).
 *   IssueRequest        -- type alias for IssueParams (the leader's request shape).
 *
 * Env vars (main mode) -- aligned with the shipped QUORUM_CLAIMS_* carrier + CP_KEYPAIR
 * convention and the RUNBOOK-captoken-cosign-live.md:
 *   QUORUM_CLAIMS_BIND_HOST             -- bind host for the server (default '0.0.0.0')
 *   QUORUM_CLAIMS_AUTH_TOKEN            -- bearer token for the /quorum/claims carrier
 *   QUORUM_CLAIMS_TLS_ENABLED           -- '1'/'true' to enable mTLS mode
 *   QUORUM_CLAIMS_TLS_CERT_PATH         -- leader's TLS cert PEM (required in TLS mode)
 *   QUORUM_CLAIMS_TLS_KEY_PATH          -- leader's TLS key PEM (required in TLS mode)
 *   QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH  -- SignedManifest[] JSON for mTLS trust derivation
 *   CP_KEYPAIR                          -- bech32 suiprivkey1... ed25519 key
 *   FOLLOWER_CP_ADDRESS                 -- follower's operator address (for discoveredCps)
 *   PACKAGE_ID                          -- deployed package id
 *   NETWORK_REGISTRY_ID                 -- NetworkRegistry object id
 *   CP_REGISTRY_ID                      -- CPRegistry object id
 *   QUORUM_STATE_OBJECT_ID              -- QuorumConfigState object id
 *   SUI_NETWORK                         -- 'localnet'|'testnet'|'devnet'|'mainnet'|URL
 *
 * CLI args:
 *   --room-id 0x..   (default: random 32-byte address)
 *   --role <n>       (default: 4 = signaling)
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { Transaction } from '@mysten/sui/transactions';
import {
  createLogger,
  InMemoryGenericClaimBoard,
  loadManifests,
  manifestsToTrustedSpki,
  createSuiClient,
  type QuorumClaimBoard,
  type Logger,
  type SignedManifest,
} from '@dvconf/shared';
import type { CpOperator } from '../sui-chain-state-reader.js';
import {
  buildIssueCanonicalMsg,
  buildIssueQuorumTx,
  type IssueParams,
  type IssueQuorum,
} from '../captoken-issue-ptb.js';
import {
  buildCapTokenIssueBoardConfig,
  assembleCapTokenQuorum,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from '../cap-token-issuer.js';
import {
  startQuorumClaimsServer,
} from '../quorum-claims-server.js';
import { HttpQuorumClaimBoard } from '../quorum-claims-client.js';

const MOD = 'cap-token/leader';

// ── Helpers ────────────────────────────────────────────────────────────────

/** lowercase hex (no 0x) of bytes — the captoken-issue board cellKey. */
function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

// ── Core export (testable without env vars) ────────────────────────────────

/** The leader's issue request — type alias for IssueParams (nonce: bigint). */
export interface IssueRequest extends IssueParams {}

/**
 * Board-path quorum collector for the leader VM.
 *
 * Posts the REAL CapTokenIssueClaim (non-advisory: real roomId/peerPubkey/role/
 * expiresEpoch/nonce) so followers using postAttestation can independently
 * re-derive the canonical bytes (G4 byte-match) before signing.
 *
 * The leader self-attests first, then polls until minQuorum distinct CP
 * attestations are on the board, then assembles via assembleCapTokenQuorum
 * (OQ-1 operator-membership gate).
 *
 * Returns an IssueQuorum ready to pass to buildIssueQuorumTx.
 */
export async function collectIssueQuorum(opts: {
  board: QuorumClaimBoard;
  leaderKp: Ed25519Keypair;
  discoveredCps: CpOperator[];
  req: IssueRequest;
  minQuorum: number;
  pollIntervalMs?: number;
  maxPollRounds?: number;
  logger?: Logger;
}): Promise<IssueQuorum> {
  const pollIntervalMs = opts.pollIntervalMs ?? 50;
  const maxPollRounds = opts.maxPollRounds ?? 200;
  const log =
    opts.logger ??
    ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger);

  // 1. Build the canonical ISSUE message from the REAL request parameters.
  //    (captoken-issue-ptb.ts version — nonce: bigint)
  const canonicalMsg = buildIssueCanonicalMsg(opts.req);
  const canonicalMsgHex = toHex(canonicalMsg);

  // 2. Build a REAL claim (not advisory) so followers can re-derive + G4 byte-match.
  //    WIRE-SAFETY: BigInt is NOT JSON-serializable, and HttpQuorumClaimBoard posts the claim
  //    via JSON.stringify — a bigint field would throw. So expiresEpoch/nonce are stored as
  //    NUMBERs on the claim (exact for the < 2^53 epoch/nonce range). canonicalMsgHex above is
  //    built from the REAL bigint request; the follower's postAttestation coerces expiresEpoch
  //    back to bigint before re-deriving, so the G4 byte-match still reproduces these bytes.
  const claim: CapTokenIssueClaim = {
    kind: 'captoken-issue',
    roomId: opts.req.roomId,
    peerPubkey: opts.req.peerPubkey,
    role: opts.req.role,
    expiresEpoch: Number(opts.req.expiresEpoch) as unknown as bigint,
    nonce: Number(opts.req.nonce),
    canonicalMsgHex,
  };

  // 3. Leader self-attest (RAW ed25519 — NO Sui intent wrap; matches Move verify_quorum).
  const sig = await opts.leaderKp.sign(canonicalMsg);
  const leaderAtt: CapTokenIssueAttestation = {
    signature: Array.from(sig.slice(0, 64)),
    pubkey: Array.from(opts.leaderKp.getPublicKey().toRawBytes()),
    addr: opts.leaderKp.toSuiAddress(),
  };
  await opts.board.post('captoken-issue', claim, leaderAtt, 0);

  // 4. The board namespaces by kind: "captoken-issue|${cellKey(claim)}".
  const cellKey = `captoken-issue|${canonicalMsgHex}`;

  log.info(
    { module: MOD, context: { cellKey, minQuorum: opts.minQuorum } },
    'leader: self-attested, polling board for quorum',
  );

  // 5. Poll until minQuorum distinct operator attestations are present.
  for (let round = 0; round < maxPollRounds; round++) {
    const cell = await opts.board.get(cellKey);
    if (cell !== undefined) {
      const atts = cell.attestations as unknown as CapTokenIssueAttestation[];
      const { qs, pubkeys, aggregateSig } = assembleCapTokenQuorum(
        claim,
        atts,
        opts.discoveredCps,
      );
      if (qs.signers.length >= opts.minQuorum) {
        log.info(
          { module: MOD, context: { signers: qs.signers, round } },
          'leader: quorum assembled',
        );
        return { qs, pubkeys, aggregateSig };
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(
    `collectIssueQuorum: quorum not reached after ${maxPollRounds} rounds ` +
      `(minQuorum=${opts.minQuorum})`,
  );
}

// ── Live bin entry point ───────────────────────────────────────────────────

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`${MOD}: ${what} is required`);
  return v;
};

async function main(): Promise<void> {
  const logger = createLogger(MOD);

  // ── Parse CLI args ──────────────────────────────────────────────────────
  const argv = process.argv.slice(2);
  let roomId: string | undefined;
  let role = 4;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--room-id' && argv[i + 1]) {
      roomId = argv[++i];
    } else if (argv[i] === '--role' && argv[i + 1]) {
      role = Number(argv[++i]);
    }
  }
  if (!roomId) {
    // Default: random 32-byte address (demo room).
    const bytes = new Uint8Array(32);
    // Use globalThis.crypto for Node 19+; fall back to node:crypto for older.
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(bytes);
    } else {
      const { randomFillSync } = await import('node:crypto');
      randomFillSync(bytes);
    }
    roomId = '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // ── Read env vars ───────────────────────────────────────────────────────
  const bindHost = process.env['QUORUM_CLAIMS_BIND_HOST'] ?? '0.0.0.0';
  const authToken = need(process.env['QUORUM_CLAIMS_AUTH_TOKEN'], 'QUORUM_CLAIMS_AUTH_TOKEN');
  const tlsEnabled =
    process.env['QUORUM_CLAIMS_TLS_ENABLED'] === '1' ||
    process.env['QUORUM_CLAIMS_TLS_ENABLED'] === 'true';
  const tlsCertPath = process.env['QUORUM_CLAIMS_TLS_CERT_PATH'];
  const tlsKeyPath = process.env['QUORUM_CLAIMS_TLS_KEY_PATH'];
  const manifestsPath = process.env['QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH'];
  const rawKey = need(process.env['CP_KEYPAIR'], 'CP_KEYPAIR (bech32 suiprivkey1...)');
  const followerCpAddress = need(process.env['FOLLOWER_CP_ADDRESS'], 'FOLLOWER_CP_ADDRESS');
  const packageId = need(process.env['PACKAGE_ID'], 'PACKAGE_ID');
  const networkRegistryId = need(process.env['NETWORK_REGISTRY_ID'], 'NETWORK_REGISTRY_ID');
  const cpRegistryId = need(process.env['CP_REGISTRY_ID'], 'CP_REGISTRY_ID');
  const quorumStateId = need(process.env['QUORUM_STATE_OBJECT_ID'], 'QUORUM_STATE_OBJECT_ID');
  const suiNetwork = process.env['SUI_NETWORK'] ?? 'localnet';

  // ── Parse keypair ───────────────────────────────────────────────────────
  const leaderKp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(rawKey).secretKey);
  logger.info(
    { module: MOD, context: { addr: leaderKp.toSuiAddress(), roomId, role, suiNetwork } },
    'cap-token leader starting',
  );

  // ── Build server-side board ─────────────────────────────────────────────
  const serverBoard = new InMemoryGenericClaimBoard([
    buildCapTokenIssueBoardConfig({
      minDistinct: 2,
      onUnquorumedExpiry: (key) => {
        logger.warn({ module: MOD, context: { key } }, 'quorum cell expired without reaching threshold');
      },
    }),
  ]);

  // ── Optional mTLS material ──────────────────────────────────────────────
  let tlsConfig:
    | { key: string; cert: string; trustedSpki: ReadonlySet<string> }
    | undefined;
  let trustedSpki: Set<string> | undefined;

  if (tlsEnabled) {
    const certPath = need(
      tlsCertPath,
      'QUORUM_CLAIMS_TLS_CERT_PATH (required with QUORUM_CLAIMS_TLS_ENABLED=1)',
    );
    const keyPath = need(
      tlsKeyPath,
      'QUORUM_CLAIMS_TLS_KEY_PATH (required with QUORUM_CLAIMS_TLS_ENABLED=1)',
    );
    const bundlePath = need(
      manifestsPath,
      'QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH (required with QUORUM_CLAIMS_TLS_ENABLED=1 — the ' +
        'SPKI-pin trust set; without it the client would silently fall back to plain-HTTP ' +
        'against a TLS server)',
    );
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    const raw = JSON.parse(readFileSync(bundlePath, 'utf8')) as SignedManifest[];
    const verified = await loadManifests(raw);
    trustedSpki = manifestsToTrustedSpki(verified);
    logger.info(
      { module: MOD, context: { trustedCount: trustedSpki.size } },
      'mTLS mode: manifest-derived trust',
    );
    tlsConfig = { cert, key, trustedSpki };
  }

  // ── Start the /quorum/claims carrier ───────────────────────────────────
  const serverHandle = await startQuorumClaimsServer({
    board: serverBoard,
    logger,
    bindHost,
    authTokenOverride: authToken,
    ...(tlsConfig
      ? { env: { ...process.env, QUORUM_CLAIMS_TLS_ENABLED: '1' }, tls: tlsConfig }
      : {}),
  });

  const rawAddr = serverHandle.server.address() as AddressInfo | null;
  if (!rawAddr || typeof rawAddr === 'string') {
    await serverHandle.stop();
    throw new Error(`${MOD}: could not determine server port`);
  }
  const protocol = tlsConfig ? 'https' : 'http';
  const serverHost = bindHost === '0.0.0.0' ? '127.0.0.1' : bindHost;
  const baseUrl = `${protocol}://${serverHost}:${rawAddr.port}`;

  logger.info(
    { module: MOD, context: { baseUrl } },
    'quorum claims server started — waiting for follower attestations',
  );

  // ── Build the client-side HTTP board (leader polls its own server) ──────
  let clientBoard: QuorumClaimBoard;
  if (tlsConfig && manifestsPath && trustedSpki) {
    const certPath = tlsCertPath!;
    const keyPath = tlsKeyPath!;
    clientBoard = new HttpQuorumClaimBoard({
      baseUrl,
      token: authToken,
      logger,
      tls: {
        cert: readFileSync(certPath, 'utf8'),
        key: readFileSync(keyPath, 'utf8'),
        trustedServerSpki: trustedSpki,
      },
    });
  } else {
    clientBoard = new HttpQuorumClaimBoard({ baseUrl, token: authToken, logger });
  }

  // ── Fetch current epoch for expiry ──────────────────────────────────────
  const suiClient = createSuiClient(suiNetwork);
  const currentEpoch = BigInt((await suiClient.getLatestSuiSystemState()).epoch);
  const expiresEpoch = currentEpoch + 100n;
  // Use current timestamp as nonce (unique per run; D-010-B monotonic in production).
  const nonce = BigInt(Date.now());

  // peerPubkey: for the demo bin, generate a random 32-byte peer key.
  const peerBytes = new Uint8Array(32);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(peerBytes);
  } else {
    const { randomFillSync } = await import('node:crypto');
    randomFillSync(peerBytes);
  }
  const peerPubkey = Array.from(peerBytes);

  const req: IssueRequest = {
    roomId,
    peerPubkey,
    role,
    expiresEpoch,
    nonce,
  };

  // Normalize the env-supplied follower address to the exact SDK form (0x + 64 lowercase hex).
  // assembleCapTokenQuorum gates the follower's att.addr (= followerKp.toSuiAddress(), already
  // normalized) against discoveredCps[].operator via a raw Set.has — a non-normalized
  // FOLLOWER_CP_ADDRESS would silently drop the follower's attestation and hang the leader until
  // maxPollRounds (fail-closed, but a live-run hang). Normalizing both sides mirrors the
  // integration test's normalizeSuiAddress usage.
  const leaderAddr = leaderKp.toSuiAddress();
  const followerAddr = normalizeSuiAddress(followerCpAddress);
  const discoveredCps: CpOperator[] = [
    { minerId: leaderAddr, operator: leaderAddr },
    { minerId: followerAddr, operator: followerAddr },
  ];

  // ── Collect quorum (polls board until 2-of-2) ──────────────────────────
  try {
    const quorum = await collectIssueQuorum({
      board: clientBoard,
      leaderKp,
      discoveredCps,
      req,
      minQuorum: 2,
      pollIntervalMs: 500,
      maxPollRounds: 120, // ~60 seconds
      logger,
    });

    // ── Build + submit the PTB ──────────────────────────────────────────────
    const tx = new Transaction();
    buildIssueQuorumTx(
      tx,
      { packageId, networkRegistryId, cpRegistryId, quorumStateId },
      req,
      quorum,
    );
    tx.setGasBudget(100_000_000);

    const res = await suiClient.signAndExecuteTransaction({
      signer: leaderKp,
      transaction: tx,
      options: { showEffects: true, showEvents: true },
    });
    await suiClient.waitForTransaction({ digest: res.digest });

    const status = (res.effects?.status?.status as string) ?? 'unknown';
    if (status !== 'success') {
      // A reverted TX (Move abort 886 dup-signer / 906 intent-wrap / gas) must exit non-zero,
      // NOT log "cap-token issued". Surface the abort for the live run.
      throw new Error(
        `${MOD}: issue_capability_token TX ${res.digest} did not succeed ` +
          `(status=${status}, error=${res.effects?.status?.error ?? 'n/a'})`,
      );
    }
    logger.info(
      {
        module: MOD,
        context: { digest: res.digest, status, issuerQuorum: quorum.qs.signers },
      },
      'cap-token issued via board-path quorum',
    );
  } finally {
    await serverHandle.stop();
    logger.info({ module: MOD }, 'quorum claims server stopped');
  }
}

// Only execute main() when this file is the direct entry point (not imported as a module).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((e) => {
    // Top-level fatal before logger scope — intentional console.error for a standalone bin.
    // eslint-disable-next-line no-console
    console.error(`${MOD}: FATAL`, e);
    process.exit(1);
  });
}
