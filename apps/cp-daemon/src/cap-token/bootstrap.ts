/**
 * F62 Stage 4 Item #1 — CapTokenIssuer bootstrap factory + LocalCpKeystore + the
 * Leg 7d live /quorum/claims board selection + cross-host mTLS material loader.
 *
 * Split out of the former monolithic `index.ts` (god-file split) into the
 * `cap-token/` module. See the boundary comment below for the file-ownership
 * rationale. `buildLocalCpKeystore` now lives in `./keystore.js`;
 * `selectQuorumClaimsBoard` + `loadQuorumClaimsCrossHostTls` live in
 * `./quorum-claims-board-selector.js` — this file keeps `startCapTokenIssuer`
 * + its submit-fn helpers, re-exporting the moved factories for backward-
 * compatible import paths (cap-token/index.ts already re-exports this module
 * wholesale).
 */
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, NetworkConfig, QuorumClaimBoard } from '@dvconf/shared';
import { CapTokenIssuer } from './issuer.js';
import type {
  CapTokenIssuerOpts,
  CpKeystore,
  SubmitFn,
  SubmitResult,
  CapTokenCacheLike,
} from './types.js';
import { InfraPeerPubkeyCache } from './infra-peer-recovery.js';
import { makeCapTokenSubmitter } from '../cap-token-submitter.js';
import { QuorumStateIdUnsetError, SuiChainStateReader } from '../sui-chain-state-reader.js';
import type { CpOperator } from '../sui-chain-state-reader.js';
import { buildLocalCpKeystore } from './keystore.js';

export { buildLocalCpKeystore } from './keystore.js';
export type { QuorumCollectorConfig } from './keystore.js';
export {
  selectQuorumClaimsBoard,
  loadQuorumClaimsCrossHostTls,
} from './quorum-claims-board-selector.js';
export type { QuorumClaimsCrossHostTls } from './quorum-claims-board-selector.js';

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
