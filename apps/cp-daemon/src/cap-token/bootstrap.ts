/**
 * F62 Stage 4 Item #1 — CapTokenIssuer bootstrap factory + LocalCpKeystore + the
 * Leg 7d live /quorum/claims board selection + cross-host mTLS material loader.
 *
 * Split out of the former monolithic `index.ts` (god-file split) into the
 * `cap-token/` module. See the boundary comment below for the file-ownership
 * rationale.
 */
import { readFileSync } from 'node:fs';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { InMemoryGenericClaimBoard, loadManifests } from '@dvconf/shared';
import type { Logger, NetworkConfig, QuorumClaimBoard, SignedManifest } from '@dvconf/shared';
import { CapTokenIssuer } from './issuer.js';
import type {
  CapTokenIssuerOpts,
  CpKeystore,
  SubmitFn,
  SubmitResult,
  CapTokenCacheLike,
} from './types.js';
import type { CapTokenIssueClaim, CapTokenIssueAttestation } from './canonical-messages.js';
import { InfraPeerPubkeyCache } from './infra-peer-recovery.js';
import { assembleCapTokenQuorum, buildCapTokenIssueBoardConfig } from './quorum.js';
import { makeCapTokenSubmitter } from '../cap-token-submitter.js';
import { QuorumStateIdUnsetError, SuiChainStateReader } from '../sui-chain-state-reader.js';
import type { CpOperator } from '../sui-chain-state-reader.js';
import {
  HttpQuorumClaimBoard,
  manifestsToTrustedSpki,
  type HttpQuorumClaimTlsConfig,
} from '../quorum-claims-client.js';
import { resolveQuorumClaimsPort } from '../quorum-claims-port.js';
import {
  isQuorumClaimsTlsEnabled,
  type QuorumClaimsTlsConfig,
} from '../quorum-claims-tls.js';

// ── F62 Stage 4 Item #1 — bootstrap factory + LocalCpKeystore ─────────────
//
// Mirrors the `startTurnIssuer` factory shape in `turn-issuer.ts:257-291`. Lives
// under cap-token/ (not index.ts) as part of a god-file split — the dispatch lane
// file ownership boundary now whitelists `cap-token/bootstrap.ts` + `cap-token/issuer.ts`
// (previously `index.ts` + `cap-token-issuer.ts`). index.ts re-exports this factory
// via cap-token/index.ts for backward-compatible import paths; do not re-inline this
// logic into index.ts.

/**
 * Leg 7c (G5) — the narrow live-chain read surface `startCapTokenIssuer` consumes on the
 * multi-CP (threshold>=2) PROD path: the discovered active-CP operator set + the per-round
 * on-chain `min_quorum`. Structurally satisfied by {@link SuiChainStateReader}; declared as
 * an interface so unit tests can inject a mock WITHOUT a localnet client.
 */
export interface ChainQuorumReader {
  getActiveCpOperators(): Promise<CpOperator[]>;
  readMinQuorum(quorumStateObjectId: string): Promise<bigint>;
}

export interface StartCapTokenIssuerOptions {
  submitFn?: SubmitFn;
  client?: SuiClient;
  signer: Ed25519Keypair;
  packageId: string;
  networkRegistryId: string;
  cpRegistryObjectId: string;
  quorumStateObjectId: string;
  logger: Logger;
  cpKeystore?: CpKeystore;
  quorumThreshold?: number;
  graceMs?: number;
  cache?: CapTokenCacheLike;
  /**
   * Leg 7c (G5) — injectable live-chain reader for the multi-CP discovery promotion. When
   * omitted but a `client` is present, `startCapTokenIssuer` constructs a real
   * `SuiChainStateReader` (cloning the revote-watcher lifecycle). Tests inject a mock.
   */
  chainReader?: ChainQuorumReader;
  /**
   * Leg 7c (G5) — network config used to construct a real {@link SuiChainStateReader} when
   * `chainReader` is omitted but a `client` is present (the prod path). Tests inject
   * `chainReader` directly and omit this.
   */
  networkConfig?: NetworkConfig;
  /**
   * Leg 7c (G3) — the infra-peer pubkey recovery cache, fed off the event-handler
   * CapabilityIssued observer. When provided, `submitIssue`'s INFRA-peer path recovers the
   * real 32-byte key via `recoverInfraPeerClaim` BEFORE the legacy `resolvePeerPubkey`
   * placeholder (null → fail-closed skip). The E2EE `sessionPubkeyB64` path is unaffected.
   */
  infraPeerCache?: InfraPeerPubkeyCache;
  /**
   * W-P2 (D-W7) — explicit live-epoch source. When provided it overrides the
   * built-in cached-epoch refresher (tests/E2E inject a controlled epoch). When
   * omitted but a `client` is present, startCapTokenIssuer primes + polls the live
   * Sui epoch itself.
   */
  getCurrentEpoch?: () => bigint;
  /** W-P2 (D-W7) — cached-epoch refresh cadence (ms). Default 60_000. */
  epochRefreshIntervalMs?: number;
  /**
   * Leg 7d (LIVE-mode) — the multi-CP quorum-collector board to inject into the keystore. When set
   * (live-mode via {@link selectQuorumClaimsBoard}) it slots behind the SAME injected
   * `quorumCollector.board` port as a PURE transport substitution (the live `HttpQuorumClaimBoard`
   * over the loopback 7a carrier). When omitted (the HERMETIC default) the keystore keeps its
   * in-memory `InMemoryGenericClaimBoard` BYTE-IDENTICAL — nothing about the protocol core changes.
   */
  quorumCollectorBoard?: QuorumClaimBoard;
}

export interface StartCapTokenIssuerResult {
  issuer: CapTokenIssuer;
  stop: () => void;
}

// ── Multi-CP quorum Leg 6 (collector wiring) ───────────────────────────────
//
// DESIGN-connection-arch.md build-seams + ROADMAP Leg 6: the `threshold>=2` branch
// of `collectQuorumSignatures` posts the LOCAL CP's own self-attestation leg to an
// INJECTED `QuorumClaimBoard`, polls `listOpen()` until the cell reaches `minQuorum`
// DISTINCT attesters, then folds them with Leg-4 `assembleCapTokenQuorum` into the
// EXACT single-CP shape the FROZEN `makeCapTokenSubmitter` consumer accepts UNCHANGED.
//
// The board is INJECTED (default `InMemoryGenericClaimBoard`) so Leg 7 can swap the
// live `/quorum/claims` HTTP board behind the SAME `QuorumClaimBoard` port — a pure
// transport substitution (the protocol core never changes). FAIL-LOUD (Fork-5): if the
// cell never reaches `minQuorum` within the bounded poll window, the collector escalates
// (the board's cap-token fail-loud gc fires) + throws so a blocked room-join is VISIBLE.

/**
 * Injectable multi-CP quorum collection config for `buildLocalCpKeystore`. Optional with a
 * sensible default (a fresh `InMemoryGenericClaimBoard` + `minQuorum=2`) so the production
 * single-CP path is unaffected; Leg 7 swaps `board` for the live HTTP carrier.
 */
export interface QuorumCollectorConfig {
  /** The injected board (default: a fresh in-memory board). Leg 7 swaps the live HTTP board. */
  board?: QuorumClaimBoard;
  /** The discovered active-CP operator set (Leg-1 getActiveCpOperators) for the OQ-1 membership gate. */
  discoveredCps?: CpOperator[];
  /** M-of-N threshold (Leg-1 readMinQuorum). Hermetic tests inject; default 2 (D-B4). */
  minQuorum?: number;
  /**
   * Leg 7c (G5 prod promotion) — a PER-ROUND live `cp_quorum_sig::min_quorum` reader. When
   * provided, the threshold>=2 poll loop calls it EVERY round (NO cache) so the off-chain
   * board observes a live `update_threshold` mutation immediately (it can never assemble below
   * the raised on-chain floor). Wired by `startCapTokenIssuer` to
   * `reader.readMinQuorum(QUORUM_STATE_OBJECT_ID)`. Absent (hermetic callers) → the static
   * `minQuorum` above is used unchanged.
   */
  readMinQuorum?: () => Promise<number>;
  /** Poll cadence (ms) between `listOpen()` checks. Default 50. */
  pollIntervalMs?: number;
  /** Max poll rounds before fail-LOUD escalation. Default 200. */
  maxPollRounds?: number;
}

/**
 * The round number passed to `board.gc()` on a fail-LOUD escalation. A cell is posted at
 * round 0; it is "expired" once `currentRound - openedRound >= wCorr`. A large constant
 * guarantees expiry regardless of the board's configured `W_corr`, so the cap-token
 * fail-LOUD branch fires deterministically when the poll window elapses below quorum.
 */
const QUORUM_FAIL_LOUD_GC_ROUND = 1_000_000;

/** lowercase hex (no 0x) of bytes — the captoken-issue board cellKey. */
function canonicalBytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/**
 * Build a local-CP keystore backed by the daemon's Ed25519 keypair. The `sign()`
 * path is fully functional; `collectQuorumSignatures()` at threshold ≥ 2 runs the
 * Leg-6 board-backed collector (post-own-leg + poll + assemble) over an INJECTED
 * `QuorumClaimBoard`, FAIL-LOUD if the M-of-N quorum is not reached in the window —
 * the issuer's handlers catch + ERROR-log so operators see the degraded state
 * without a daemon crash.
 */
export function buildLocalCpKeystore(opts: {
  signer: Ed25519Keypair;
  logger: Logger;
  quorumCollector?: QuorumCollectorConfig;
}): CpKeystore {
  const { signer, logger: kLogger } = opts;
  const localAddr = signer.toSuiAddress();
  const cc = opts.quorumCollector ?? {};
  const minQuorum = cc.minQuorum ?? 2;
  const pollIntervalMs = cc.pollIntervalMs ?? 50;
  const maxPollRounds = cc.maxPollRounds ?? 200;
  let escalated = false;
  const board: QuorumClaimBoard =
    cc.board ??
    new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({
        minDistinct: minQuorum,
        onUnquorumedExpiry: () => {
          escalated = true;
        },
      }),
    ]);
  // The discovered active-CP operator set: when an explicit set is injected (production /
  // hermetic E2E) it is the OQ-1 membership gate; absent it, the local CP is the only
  // known operator (single-host hermetic default — quorum unreachable → fail-LOUD).
  const discoveredCps: CpOperator[] =
    cc.discoveredCps ?? [{ minerId: localAddr, operator: localAddr }];
  return {
    async sign(message: Uint8Array) {
      // RAW 64-byte ed25519 over the canonical message (NO Sui intent wrap) —
      // matches Move `cp_quorum_sig::verify_quorum` (`ed25519_verify` over RAW
      // bytes) and revoke-cap-token.ts `makeSingleCpKeystore` (OQ-CRR-9). Was
      // `signer.signPersonalMessage`, which intent-wraps and fails Move verify.
      const sig = await signer.sign(message);
      const sig64 = Array.from(sig.slice(0, 64));
      const pubkey = Array.from(signer.getPublicKey().toRawBytes());
      return { signature: sig64, pubkey, addr: localAddr };
    },
    getCpAddress() {
      return localAddr;
    },
    async collectQuorumSignatures(canonicalMsg, threshold) {
      if (threshold <= 1) {
        // RAW 64-byte ed25519 over the canonical message (NO Sui intent wrap) —
        // matches Move `cp_quorum_sig::verify_quorum` + makeSingleCpKeystore
        // (OQ-CRR-9). Was `signer.signPersonalMessage`, which intent-wraps so the
        // single-CP issue path's quorum sig failed Move verify (abort 906).
        const sig = await signer.sign(canonicalMsg);
        const sig64 = Array.from(sig.slice(0, 64));
        const pubkey = Array.from(signer.getPublicKey().toRawBytes());
        const aggregateSig = [0x01, ...sig64];
        return {
          qs: { signers: [localAddr], signatures: [sig64] },
          pubkeys: [pubkey],
          aggregateSig,
        };
      }

      // ── Leg 6 — board-backed M-of-N collector (threshold >= 2) ───────────────
      // The effective quorum is max(on-chain min_quorum, the caller's threshold) — the
      // board must never assemble below the on-chain floor (G5 fail-closed). When a live
      // per-round reader is wired (Leg 7c prod path) min_quorum is re-read EVERY round (no
      // cache) so a live `update_threshold` is honored immediately; otherwise the static
      // `minQuorum` (hermetic default) is used.
      const canonicalMsgHex = canonicalBytesToHex(canonicalMsg);
      // The cell CLAIM: the only identifying field the collector needs is the cell key
      // (canonicalMsgHex) — every CP that re-derived these exact bytes opens the SAME cell.
      // The other fields are advisory (the attestations already carry the signed bytes).
      //
      // Leg 7d (wire-safety): `expiresEpoch` is advisory + UNUSED downstream (assembleCapTokenQuorum
      // takes `_claim`; the board cellKey is canonicalMsgHex; validateWireSchema reads only
      // `claim.kind`). The LIVE HTTP board (`HttpQuorumClaimBoard.post`) `JSON.stringify`s this claim
      // over the wire, and `JSON.stringify` cannot serialize a `bigint` — so the advisory expiry is
      // carried as a JSON-safe `0` (the hermetic InMemory path is byte-identical in observable behavior:
      // no test reads the collector cell's `expiresEpoch`, and the assembled proof is independent of it).
      const claim: CapTokenIssueClaim = {
        kind: 'captoken-issue',
        roomId: '0x' + '00'.repeat(32),
        peerPubkey: new Array(32).fill(0),
        role: 0,
        // wire-safe advisory expiry (number, not bigint) — JSON.stringify-able for the live HTTP board.
        expiresEpoch: 0 as unknown as bigint,
        nonce: 1,
        canonicalMsgHex,
      };

      // 1) POST the LOCAL CP's own self-attestation leg (RAW ed25519, single-CP shape).
      const selfSig = await signer.sign(canonicalMsg);
      const selfAtt: CapTokenIssueAttestation = {
        signature: Array.from(selfSig.slice(0, 64)),
        pubkey: Array.from(signer.getPublicKey().toRawBytes()),
        addr: localAddr,
      };
      await board.post('captoken-issue', claim, selfAtt, 0);

      const cellKey = `captoken-issue|${canonicalMsgHex}`;

      // 2) POLL listOpen() until the cell reaches the (per-round) effective quorum of DISTINCT
      // operators. `effectiveQuorum` is recomputed inside the loop so a live `readMinQuorum`
      // (Leg 7c G5) reflects an on-chain `update_threshold` immediately (NO cache).
      let effectiveQuorum = Math.max(minQuorum, threshold);
      for (let round = 0; round < maxPollRounds; round++) {
        if (cc.readMinQuorum) {
          // PER-ROUND live read (Leg 7c) — never cached; the board can never assemble below the
          // current on-chain floor even if it was raised mid-poll.
          const liveMinQuorum = await cc.readMinQuorum();
          effectiveQuorum = Math.max(liveMinQuorum, threshold);
        }
        const open = await board.listOpen();
        const cell = open.find((c) => c.key === cellKey);
        if (cell) {
          const atts = cell.attestations as CapTokenIssueAttestation[];
          // distinct registered operators among the accrued attestations (OQ-1 membership).
          const assembled = assembleCapTokenQuorum(claim, atts, discoveredCps);
          if (assembled.qs.signers.length >= effectiveQuorum) {
            await board.markSubmitted(cellKey);
            return assembled;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      // 3) FAIL-LOUD (Fork-5): the window elapsed below quorum. Drive the board GC past the
      // correlation window so the cap-token fail-LOUD branch escalates (a blocked room-join
      // must be VISIBLE), then ERROR-log + throw so the caller surfaces the degraded state.
      await board.gc(QUORUM_FAIL_LOUD_GC_ROUND);
      kLogger.error(
        {
          module: 'cap-token-bootstrap',
          context: {
            threshold,
            effective_quorum: effectiveQuorum,
            local_cp: localAddr,
            escalated_via_board_gc: escalated,
          },
        },
        'multi-CP quorum NOT reached within the bounded poll window — fail-LOUD escalation (bounded-retry w/ fresh nonce required)',
      );
      throw new Error(
        `multi-CP quorum unreached: needed ${effectiveQuorum} distinct CP signatures over the canonical message but only the local CP (and any peers within the window) attested`,
      );
    },
  };
}

// ── Multi-CP quorum Leg 7d — LIVE-mode board selection ──────────────────────
//
// ROADMAP Leg 7d: a small, testable selector that decides whether the daemon runs the
// HERMETIC default (`QUORUM_CLAIMS_ENABLED` unset → `undefined`, so `buildLocalCpKeystore`
// keeps its in-memory `InMemoryGenericClaimBoard` default BYTE-IDENTICAL) or the LIVE
// transport (`QUORUM_CLAIMS_ENABLED` set → a `HttpQuorumClaimBoard` pointed at the LOCAL
// loopback 7a carrier). It is PURE TRANSPORT SUBSTITUTION: the returned board slots behind the
// SAME injected `quorumCollector.board` port — the protocol core never changes.
//
// FAIL-LOUD (mirrors the 7a server): live-mode with `QUORUM_CLAIMS_AUTH_TOKEN` unset throws
// (a transport carrying quorum signatures must never run open). The port is resolved via the
// SHIPPED `resolveQuorumClaimsPort` (fail-closed on a non-numeric/out-of-range value).

/**
 * Decide the quorum-collector board for daemon startup.
 *
 * OQ-7 cross-host boot-wiring (gap #1): the client baseUrl is derived from `QUORUM_CLAIMS_PEER_URL`
 * (default `http(s)://127.0.0.1:${port}` — loopback, byte-identical when unset) so a FOLLOWER CP can
 * point at the LEADER's board. When mTLS is on (`QUORUM_CLAIMS_TLS_ENABLED`) the caller supplies the
 * client's `{cert,key,trustedServerSpki}` (built in `main()` from the loaded operator manifests) and
 * it rides every request; when off, the plain-HTTP loopback path is byte-identical.
 *
 * @returns a `HttpQuorumClaimBoard` (live carrier) when `QUORUM_CLAIMS_ENABLED` is set (with
 *          `QUORUM_CLAIMS_AUTH_TOKEN`), or `undefined` when unset so the hermetic
 *          `InMemoryGenericClaimBoard` default is preserved BYTE-IDENTICAL.
 * @throws  when live-mode is enabled but `QUORUM_CLAIMS_AUTH_TOKEN` is unset (fail-LOUD), or when
 *          mTLS is enabled but no client material is supplied (fail-LOUD — refuse a silent downgrade).
 */
export function selectQuorumClaimsBoard(args: {
  env?: Record<string, string | undefined>;
  logger: Logger;
  /**
   * OQ-7 Phase C cross-host mTLS CLIENT material (cert/key + the pinned server-SPKI set). Threaded in
   * from `main()`'s manifest-derived load. REQUIRED when `QUORUM_CLAIMS_TLS_ENABLED` is on; IGNORED
   * (and unnecessary) on the plain-HTTP loopback path — absent → the byte-identical existing client.
   */
  tls?: HttpQuorumClaimTlsConfig;
}): HttpQuorumClaimBoard | undefined {
  const env = args.env ?? process.env;
  const enabled = env['QUORUM_CLAIMS_ENABLED'];
  if (enabled === undefined || enabled === '' || enabled === '0' || enabled === 'false') {
    // HERMETIC default — buildLocalCpKeystore keeps its in-memory board (byte-identical).
    return undefined;
  }
  // FAIL-LOUD: a live transport carrying quorum signatures must never run without a token.
  const token = env['QUORUM_CLAIMS_AUTH_TOKEN'];
  if (token === undefined || token === '') {
    throw new Error(
      'QUORUM_CLAIMS_ENABLED is set but QUORUM_CLAIMS_AUTH_TOKEN is unset — refusing to build a ' +
        'live /quorum/claims board (security-critical transport; set the token or unset the flag).',
    );
  }
  const port = resolveQuorumClaimsPort(env);
  const tlsEnabled = isQuorumClaimsTlsEnabled(env);
  // FAIL-LOUD: mTLS on but no client material would be a SILENT DOWNGRADE to plain-HTTP against an
  // mTLS-only carrier — refuse to start (the follower MUST present its cert + pin the peer SPKI).
  if (tlsEnabled && args.tls === undefined) {
    throw new Error(
      'QUORUM_CLAIMS_TLS_ENABLED is set but no cross-host mTLS client material ' +
        '(cert/key/trustedServerSpki) was provided to selectQuorumClaimsBoard — refusing to build a ' +
        'plain-HTTP client against the mTLS carrier (set the cert/key/manifest paths or unset the flag).',
    );
  }
  // Peer URL (cross-host) → the leader's board; default loopback (scheme follows the TLS flag so an
  // mTLS-on default still yields an `https://` baseUrl the pinned dispatcher can handshake over).
  const peerUrl = env['QUORUM_CLAIMS_PEER_URL'];
  const baseUrl =
    peerUrl !== undefined && peerUrl !== ''
      ? peerUrl
      : `${tlsEnabled ? 'https' : 'http'}://127.0.0.1:${port}`;
  args.logger.info(
    {
      module: 'cap-token-bootstrap',
      context: { baseUrl, mode: tlsEnabled ? 'live-crosshost-mtls' : 'live-loopback' },
    },
    'quorum-claims live transport ENABLED — collector board = HttpQuorumClaimBoard',
  );
  return new HttpQuorumClaimBoard({
    baseUrl,
    token,
    logger: args.logger,
    ...(tlsEnabled && args.tls !== undefined ? { tls: args.tls } : {}),
  });
}

/** OQ-7 cross-host boot-wiring: the derived mTLS material for BOTH the server + client boot selectors. */
export interface QuorumClaimsCrossHostTls {
  /** Server-side TLS: own cert/key + the trusted PEER SPKI set (`startQuorumClaimsServer` opts.tls). */
  serverTls: QuorumClaimsTlsConfig;
  /** Client-side TLS: own cert/key + the trusted SERVER SPKI set (`HttpQuorumClaimBoard` opts.tls). */
  clientTls: HttpQuorumClaimTlsConfig;
}

/**
 * OQ-7 Phase C cross-host boot LOADER (gap #1): when `QUORUM_CLAIMS_TLS_ENABLED` is on, load this CP's
 * own TLS cert/key + the SIGNED operator-manifest bundle from disk, verify the manifests, and DERIVE
 * the trusted-SPKI peer set (the REAL manifest trust path — NO injected set, NO CA). Returns the tls
 * config for BOTH boot selectors (`serverTls` for `startQuorumClaimsServer`, `clientTls` for
 * `selectQuorumClaimsBoard`), symmetric because the manifest bundle carries every operator's SPKI.
 *
 * OFF by default: when the flag is unset it returns `undefined` WITHOUT reading any file — the boot is
 * byte-identical to the plain-HTTP loopback path. FAIL-LOUD when the flag is on but a required path is
 * unset or the bundle yields no valid peer.
 *
 * Env (all required only when `QUORUM_CLAIMS_TLS_ENABLED` is on):
 *   - `QUORUM_CLAIMS_TLS_CERT_PATH`        — PEM path of this CP's self-signed TLS cert.
 *   - `QUORUM_CLAIMS_TLS_KEY_PATH`         — PEM path of this CP's TLS private key.
 *   - `QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH` — JSON path of the `SignedManifest[]` OOB bundle.
 */
export async function loadQuorumClaimsCrossHostTls(args: {
  env?: Record<string, string | undefined>;
  logger: Logger;
}): Promise<QuorumClaimsCrossHostTls | undefined> {
  const env = args.env ?? process.env;
  // OFF path — no file reads, no manifest load, no tls. Byte-identical boot.
  if (!isQuorumClaimsTlsEnabled(env)) return undefined;

  const certPath = env['QUORUM_CLAIMS_TLS_CERT_PATH'];
  const keyPath = env['QUORUM_CLAIMS_TLS_KEY_PATH'];
  const bundlePath = env['QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH'];
  if (!certPath || !keyPath || !bundlePath) {
    throw new Error(
      'QUORUM_CLAIMS_TLS_ENABLED is set but one of QUORUM_CLAIMS_TLS_CERT_PATH / ' +
        'QUORUM_CLAIMS_TLS_KEY_PATH / QUORUM_CLAIMS_MANIFEST_BUNDLE_PATH is unset — the cross-host ' +
        'mTLS carrier needs its own cert/key + the signed operator-manifest bundle (fail-closed).',
    );
  }

  const cert = readFileSync(certPath, 'utf8');
  const key = readFileSync(keyPath, 'utf8');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as SignedManifest[];
  const manifests = await loadManifests(bundle);
  const trustedSpki = manifestsToTrustedSpki(manifests);
  if (trustedSpki.size === 0) {
    throw new Error(
      'QUORUM_CLAIMS_MANIFEST_BUNDLE yielded NO valid operator manifests — the trusted-SPKI peer set ' +
        'is empty; the mTLS carrier would trust no peer (fail-closed refuse-to-start).',
    );
  }

  args.logger.info(
    {
      module: 'cap-token-bootstrap',
      context: { trustedPeers: trustedSpki.size, certPath, bundlePath },
    },
    'quorum-claims cross-host mTLS material loaded (manifest-derived trusted-SPKI set)',
  );
  return {
    serverTls: { key, cert, trustedSpki },
    clientTls: { cert, key, trustedServerSpki: trustedSpki },
  };
}

/**
 * Bootstrap a `CapTokenIssuer` with production wiring (mirrors `startTurnIssuer`).
 *
 * M1 wiring boundary (per ROADMAP § Phase 3.5.1 + STATUS.md § Stage 4 readiness
 * #1): instantiate the issuer with a LocalCpKeystore that throws on
 * `collectQuorumSignatures(_, threshold ≥ 2)`. Peer-CP discovery + the
 * `executeWithRetry`-backed TX dispatcher are deferred to a follow-up phase
 * (D-014 sub-decision). For now the production `submitFn` logs + throws so any
 * accidental quorum success (e.g. threshold=1 test config) surfaces clearly.
 */
export async function startCapTokenIssuer(
  opts: StartCapTokenIssuerOptions,
): Promise<StartCapTokenIssuerResult> {
  const submitFn = opts.submitFn ?? selectProductionSubmitFn(opts);
  const threshold = opts.quorumThreshold ?? 2;
  const isMultiCp = threshold >= 2;

  // ── Leg 7c (G5) — multi-CP discovery promotion + fail-closed config gate ──────────────
  //
  // A multi-CP (threshold>=2) LIVE issue MUST source the on-chain `min_quorum` + the active-CP
  // operator set from chain. Construct (or accept an injected) ChainQuorumReader. FAIL-CLOSED:
  // a multi-CP daemon with `quorumStateObjectId` UNSET refuses to start (NO silent minQuorum=2).
  // Single-CP (threshold<=1) is unaffected — it never reads the quorum-state object.
  let chainReader: ChainQuorumReader | undefined = opts.chainReader;
  if (!chainReader && opts.client && opts.networkConfig) {
    // Clone the revote-watcher reader lifecycle (index.ts revote wiring): one reader instance,
    // reused across rounds. Read-only devInspect — no signer, no TX.
    chainReader = new SuiChainStateReader(opts.client, opts.networkConfig, opts.logger);
  }

  // Counters (additive pino observability — Leg 7c): live reads + recovery hit/miss are
  // emitted from their call sites; the operator-set size is logged here at discovery time.
  let discoveredCps: CpOperator[] | undefined;
  // Leg 7d (LIVE-mode): when a live board is injected, thread it through the keystore's
  // `quorumCollector.board` port. When undefined (the HERMETIC default), pass NO `quorumCollector`
  // so `buildLocalCpKeystore`'s in-memory default is BYTE-IDENTICAL to the pre-7d behavior.
  const liveBoard = opts.quorumCollectorBoard;
  let buildKeystore = (): CpKeystore =>
    buildLocalCpKeystore({
      signer: opts.signer,
      logger: opts.logger,
      ...(liveBoard !== undefined && { quorumCollector: { board: liveBoard } }),
    });

  if (isMultiCp && !opts.cpKeystore) {
    // FAIL-CLOSED gate (invariant #3): a multi-CP live issue with the quorum-state id unset
    // must refuse — never silently default minQuorum=2.
    if (!opts.quorumStateObjectId) {
      opts.logger.error(
        {
          module: 'cap-token-bootstrap',
          context: { threshold, reason: 'quorum-state-id-unset' },
        },
        'multi-CP CapTokenIssuer refused to start — QUORUM_STATE_OBJECT_ID unset (failing closed; will NOT silently default minQuorum=2)',
      );
      throw new QuorumStateIdUnsetError();
    }
    if (chainReader) {
      // Discover the active-CP operator set ONCE at startup (the OQ-1 membership gate). The
      // min_quorum read is deferred to a PER-ROUND closure (no cache) so a live
      // `update_threshold` is honored every assembly round.
      const reader = chainReader;
      const quorumStateObjectId = opts.quorumStateObjectId;
      discoveredCps = await reader.getActiveCpOperators();
      opts.logger.debug(
        {
          module: 'cap-token-bootstrap',
          context: { operator_set_size: discoveredCps.length },
        },
        'discovered active-CP operator set (G5 prod read)',
      );
      const resolvedCps = discoveredCps;
      buildKeystore = (): CpKeystore =>
        buildLocalCpKeystore({
          signer: opts.signer,
          logger: opts.logger,
          quorumCollector: {
            // Leg 7d: live board (loopback 7a carrier) when injected; absent → in-memory default.
            ...(liveBoard !== undefined && { board: liveBoard }),
            discoveredCps: resolvedCps,
            readMinQuorum: async () => {
              const q = await reader.readMinQuorum(quorumStateObjectId);
              opts.logger.debug(
                {
                  module: 'cap-token-bootstrap',
                  context: { min_quorum: Number(q), source: 'per-round-live-read' },
                },
                'read live min_quorum (G5 per-round, no cache)',
              );
              return Number(q);
            },
          },
        });
    }
  }

  const cpKeystore = opts.cpKeystore ?? buildKeystore();

  // W-P2 (D-W7) — cached-epoch source for token expiry. An explicit getCurrentEpoch
  // (tests/E2E) wins; otherwise, when a client is present, prime + poll the live Sui
  // epoch and expose it via a closure. Without either, the issuer falls back to the
  // legacy 0-based offset (expiry = 100 epochs). The poll is unref'd so it never
  // keeps the process alive, and stop() clears it.
  let cachedEpoch = 0n;
  let epochTimer: ReturnType<typeof setInterval> | undefined;
  const refreshEpoch = async (): Promise<void> => {
    if (!opts.client) return;
    try {
      const sys = await opts.client.getLatestSuiSystemState();
      cachedEpoch = BigInt(sys.epoch);
    } catch (err) {
      opts.logger.warn(
        { module: 'cap-token-bootstrap', context: { err: (err as Error).message } },
        'epoch refresh failed — keeping last cached epoch',
      );
    }
  };
  const getCurrentEpoch = opts.getCurrentEpoch ?? (() => cachedEpoch);
  if (!opts.getCurrentEpoch && opts.client) {
    await refreshEpoch(); // prime so the first issuance uses a real epoch
    const intervalMs = opts.epochRefreshIntervalMs ?? 60_000;
    epochTimer = setInterval(() => {
      void refreshEpoch();
    }, intervalMs);
    if (typeof epochTimer.unref === 'function') epochTimer.unref();
  }

  const issuerOpts: CapTokenIssuerOpts = {
    submitFn,
    packageId: opts.packageId,
    networkRegistryId: opts.networkRegistryId,
    cpRegistryObjectId: opts.cpRegistryObjectId,
    quorumStateObjectId: opts.quorumStateObjectId,
    cpKeystore,
    logger: opts.logger,
    getCurrentEpoch,
    ...(opts.quorumThreshold !== undefined && { quorumThreshold: opts.quorumThreshold }),
    ...(opts.graceMs !== undefined && { graceMs: opts.graceMs }),
    ...(opts.cache !== undefined && { cache: opts.cache }),
    ...(opts.infraPeerCache !== undefined && { infraPeerCache: opts.infraPeerCache }),
  };
  const issuer = new CapTokenIssuer(issuerOpts);

  opts.logger.info(
    {
      module: 'cap-token-bootstrap',
      context: {
        local_cp: cpKeystore.getCpAddress(),
        threshold: opts.quorumThreshold ?? 2,
        has_cache: opts.cache !== undefined,
      },
    },
    'CapTokenIssuer started',
  );

  return {
    issuer,
    stop: () => {
      if (epochTimer) clearInterval(epochTimer);
      opts.logger.info({ module: 'cap-token-bootstrap' }, 'CapTokenIssuer stopped');
    },
  };
}

/**
 * Select the production submitFn (W-P1 / D-W6; Leg 6 multi-CP wiring). With a wired
 * `client`, BOTH single-CP (threshold<=1) and multi-CP (threshold>=2) route to the real
 * `makeCapTokenSubmitter` PTB dispatcher — the M-of-N COLLECTION happens upstream inside
 * the keystore's board-backed `collectQuorumSignatures` (Leg 6), so the submitter consumes
 * the SAME assembled `{ qs, pubkeys, aggregateSig }` shape UNCHANGED whether the proof has
 * 1 or N signers. Only a MISSING client falls back to the deferred throwing stub (D-014:
 * a no-client daemon cannot publish on-chain).
 */
function selectProductionSubmitFn(opts: StartCapTokenIssuerOptions): SubmitFn {
  if (opts.client) {
    return makeCapTokenSubmitter(opts.client, opts.signer, opts.logger);
  }
  return makeDeferredSubmit(opts.logger);
}

/**
 * Test-only accessor for {@link selectProductionSubmitFn} (the routing is otherwise
 * module-private). Lets a unit assert that threshold>=2 WITH a client no longer routes to
 * the deferred stub (Leg 6 — the multi-CP path is wired to the real submitter).
 */
export function selectProductionSubmitFnForTest(opts: StartCapTokenIssuerOptions): SubmitFn {
  return selectProductionSubmitFn(opts);
}

/**
 * Deferred-production submitFn — logs WARN and throws so the daemon does not
 * silently submit malformed TXs. Used for the multi-CP (threshold>=2) path until
 * peer-CP discovery is implemented (D-014 sub-decision).
 */
function makeDeferredSubmit(submitLogger: Logger): SubmitFn {
  return async ({ label, args }): Promise<SubmitResult> => {
    submitLogger.warn(
      { module: 'cap-token-bootstrap', context: { label, args_keys: Object.keys(args) } },
      'CapTokenIssuer submitFn — production dispatcher deferred (D-014); throwing to surface degraded state',
    );
    throw new Error(
      `CapTokenIssuer submitFn deferred: production "${label}" dispatcher pending peer-CP discovery wiring (D-014)`,
    );
  };
}
