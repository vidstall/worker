/*
 * Cap-token follower (VM-2) attester bin.
 * Entry-point guard: main() only runs when the file is executed directly
 * (import.meta.url check). Importing postAttestation in tests does NOT trigger main().
 *
 * Polls the shared QuorumClaimBoard for open 'captoken-issue' cells, independently
 * re-derives the canonical ISSUE message from the cell claim fields, and signs it
 * with this CP's ed25519 key -- only when the re-derived bytes EXACTLY match the
 * poster's claimed bytes (G4 byte-match + policy validation via
 * rebuildCanonicalAndSignIfMatches). Returns false when no cell requires signing.
 *
 * Export: postAttestation -- the testable core.
 * main()  -- the live bin entry point (reads env vars, polls on interval).
 *
 * Env vars (main mode) -- aligned with the shipped QUORUM_CLAIMS_* carrier + CP_KEYPAIR convention
 * (apps/cp-daemon/src/index.ts) and plans/multi-cp-quorum/RUNBOOK-captoken-cosign-live.md:
 *   QUORUM_CLAIMS_PEER_URL             -- base URL of the leader's live /quorum/claims carrier
 *   QUORUM_CLAIMS_AUTH_TOKEN           -- bearer token matching the server's auth
 *   CP_KEYPAIR                         -- bech32 suiprivkey1... ed25519 key (self-custody)
 *   CURRENT_EPOCH                      -- optional: Sui epoch for expiry validation (VM-2 needs NO chain RPC)
 *   CAPTOKEN_COSIGN_POLL_MS            -- optional: polling interval in ms (default 2000)
 *   QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH -- optional: SignedManifest[] JSON; when set -> mTLS mode
 *   QUORUM_CLAIMS_TLS_CERT_PATH        -- this CP's TLS cert PEM (required with the bundle path)
 *   QUORUM_CLAIMS_TLS_KEY_PATH         -- this CP's TLS key PEM (required with the bundle path)
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import {
  type QuorumClaimBoard,
  createLogger,
  loadManifests,
  manifestsToTrustedSpki,
  type SignedManifest,
} from '@dvconf/shared';
import { rebuildCanonicalAndSignIfMatches, type CapTokenIssueClaim } from '../cap-token/index.js';
import { HttpQuorumClaimBoard } from '../quorum-claims-client.js';

const MOD = 'cap-token/follower-attester';

// ── Core export (testable without env vars) ────────────────────────────────

/**
 * Scan the board for any open 'captoken-issue' cell and post this CP's
 * independent attestation. Returns true when an attestation was posted, false
 * when no open cell of that kind exists or none passes the G4/policy check.
 *
 * Mirrors the shape of the canary attestIfIndependentlyObserved flow but with
 * the cap-token predicate: re-derive via rebuildCanonicalAndSignIfMatches
 * (byte-match + policy-validate) rather than the canary observation predicate.
 */
export async function postAttestation(
  board: QuorumClaimBoard,
  signer: Ed25519Keypair,
  opts?: { currentEpoch?: bigint },
): Promise<boolean> {
  const cells = await board.listOpen();
  for (const cell of cells) {
    if (cell.kind !== 'captoken-issue') continue;
    const raw = cell.claim as CapTokenIssueClaim;
    // WIRE-SAFETY: a claim that round-tripped a JSON board (HttpQuorumClaimBoard) carries
    // expiresEpoch as a NUMBER — the leader posts Number(...) because BigInt is not
    // JSON-serializable. Coerce it back to bigint for re-derivation so rebuildCanonicalAndSignIfMatches
    // reproduces identical bytes whether the board was in-memory (bigint) or HTTP (number).
    // BigInt() is a no-op on a bigint and exact for the < 2^53 epoch range.
    const claimForDerive: CapTokenIssueClaim = { ...raw, expiresEpoch: BigInt(raw.expiresEpoch) };
    const att = await rebuildCanonicalAndSignIfMatches(
      claimForDerive,
      signer,
      opts?.currentEpoch !== undefined ? { currentEpoch: opts.currentEpoch } : undefined,
    );
    if (att) {
      // Re-post the ORIGINAL wire-safe claim (expiresEpoch still a number) so this follower's
      // own POST stays JSON-serializable over the HTTP board.
      await board.post('captoken-issue', raw, att, cell.openedRound);
      return true;
    }
  }
  return false;
}

// ── Live bin entry point ───────────────────────────────────────────────────

const need = (v: string | undefined, what: string): string => {
  if (!v) throw new Error(`${MOD}: ${what} is required`);
  return v;
};

async function main(): Promise<void> {
  const logger = createLogger(MOD);

  const boardUrl = need(process.env['QUORUM_CLAIMS_PEER_URL'], 'QUORUM_CLAIMS_PEER_URL');
  const authToken = need(process.env['QUORUM_CLAIMS_AUTH_TOKEN'], 'QUORUM_CLAIMS_AUTH_TOKEN');
  const rawKey = need(process.env['CP_KEYPAIR'], 'CP_KEYPAIR (bech32 suiprivkey1...)');
  const pollMs = Number(process.env['CAPTOKEN_COSIGN_POLL_MS'] ?? '2000') || 2000;
  const currentEpoch =
    process.env['CURRENT_EPOCH'] !== undefined
      ? BigInt(process.env['CURRENT_EPOCH'])
      : undefined;

  const signer = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(rawKey).secretKey);
  logger.info(
    { module: MOD, context: { addr: signer.toSuiAddress(), boardUrl, pollMs } },
    'cap-token follower attester starting',
  );

  // Optional mTLS via operator manifests (OQ-7 / ADR-0021 Phase C).
  let board: QuorumClaimBoard;
  const manifestsPath = process.env['QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH'];
  if (manifestsPath !== undefined) {
    const raw = JSON.parse(readFileSync(manifestsPath, 'utf8')) as SignedManifest[];
    const verified = await loadManifests(raw);
    const trustedSpki = manifestsToTrustedSpki(verified);
    // CP's own TLS cert + key for mutual auth (expected alongside the manifests file).
    const certPath = need(process.env['QUORUM_CLAIMS_TLS_CERT_PATH'], 'QUORUM_CLAIMS_TLS_CERT_PATH (required with QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH)');
    const keyPath = need(process.env['QUORUM_CLAIMS_TLS_KEY_PATH'], 'QUORUM_CLAIMS_TLS_KEY_PATH (required with QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH)');
    const cert = readFileSync(certPath, 'utf8');
    const key = readFileSync(keyPath, 'utf8');
    board = new HttpQuorumClaimBoard({
      baseUrl: boardUrl,
      token: authToken,
      tls: { cert, key, trustedServerSpki: trustedSpki },
    });
    logger.info({ module: MOD, context: { trustedCount: trustedSpki.size } }, 'mTLS mode: loaded manifests');
  } else {
    board = new HttpQuorumClaimBoard({ baseUrl: boardUrl, token: authToken });
    logger.info({ module: MOD }, 'plain-HTTP mode (no QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH)');
  }

  // Poll loop.
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    try {
      const posted = await postAttestation(board, signer, { currentEpoch });
      if (posted) {
        logger.info(
          { module: MOD, context: { addr: signer.toSuiAddress() } },
          'cap-token follower: attestation posted',
        );
      }
    } catch (err) {
      logger.error(
        { module: MOD, context: { err: (err as Error).message } },
        'cap-token follower: error during attestation round (continuing)',
      );
    }
    await sleep(pollMs);
  }
}

// Only execute main() when this file is the direct entry point (not imported as a module).
// This prevents the env-var checks and polling loop from running when vitest (or any other
// test runner) imports postAttestation for unit testing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((e) => {
    // Top-level fatal before logger scope -- intentional console.error for a standalone bin.
    // eslint-disable-next-line no-console
    console.error(`${MOD}: FATAL`, e);
    process.exit(1);
  });
}
