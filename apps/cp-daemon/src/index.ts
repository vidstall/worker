/**
 * CP Daemon — Control Plane daemon entry point.
 *
 * Subscribes to relay/room/validator/signaling/voting events, runs relay + validator
 * scoring, sends heartbeat to ControlPlaneRegistry, and participates in role voting.
 *
 * Uses @dvconf/shared for all chain interactions (DAEMON-12) with exponential backoff (DAEMON-07).
 */

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  startHealthzServer,
  EventPoller,
  readIsPaused,
  InMemoryGenericClaimBoard,
} from '@dvconf/shared';
import type { Logger, NetworkConfig, QuorumClaimBoard } from '@dvconf/shared';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  runGracefulShutdown,
  readGracefulShutdownConfig,
  type GracefulShutdownPlan,
  type GracefulShutdownConfig,
  type ShutdownReason,
} from '@dvconf/chain-event-listener';
import {
  HealthMonitor,
  makeChainReporter,
  readCooldownMs,
  type ThresholdEnv,
} from '@dvconf/health-monitor';
import { buildHealthSignals, type CpHealthDeps } from './health-signals.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createEventHandler } from './event-handler.js';
import { startRoleVoting } from './role-voter.js';
import { startRevoteWatcher, makeMarkSubmitter, resolveScanIntervalEpochs } from './revote-watcher.js';
import { SuiChainStateReader } from './sui-chain-state-reader.js';
import {
  startRelayHeartbeatWatcher,
  makePromoteSubmitter,
} from './relay-heartbeat-watcher.js';
import { LiveRelayChainStateReader } from './relay-chain-state-reader.js';
import { startTurnIssuer } from './turn-issuer.js';
import { startTurnRpc } from './turn-rpc.js';
import {
  CapTokenIssuer,
  assembleCapTokenQuorum,
  buildCapTokenIssueBoardConfig,
  type CapTokenIssuerOpts,
  type CpKeystore,
  type SubmitFn,
  type SubmitResult,
  type CapTokenCacheLike,
  type CapTokenIssueClaim,
  type CapTokenIssueAttestation,
} from './cap-token-issuer.js';
import { makeCapTokenSubmitter } from './cap-token-submitter.js';
import type { CpOperator } from './sui-chain-state-reader.js';

export { CapTokenIssuer } from './cap-token-issuer.js';
export type {
  CapTokenIssuerOpts,
  CpKeystore,
  SubmitFn as CapTokenSubmitFn,
  RoomAssignedEvent,
  RoleChangedEvent,
  RoleAssignedEvent,
  RelaySlashedEvent,
} from './cap-token-issuer.js';

const logger = createLogger('cp-daemon');

// ── F62 Stage 4 Item #1 — bootstrap factory + LocalCpKeystore ─────────────
//
// Mirrors the `startTurnIssuer` factory shape in `turn-issuer.ts:257-291`. Lives
// in index.ts (rather than a sibling file) to honour the dispatch lane file
// ownership boundary which whitelists only `index.ts` + `cap-token-issuer.ts`.

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
   * W-P2 (D-W7) — explicit live-epoch source. When provided it overrides the
   * built-in cached-epoch refresher (tests/E2E inject a controlled epoch). When
   * omitted but a `client` is present, startCapTokenIssuer primes + polls the live
   * Sui epoch itself.
   */
  getCurrentEpoch?: () => bigint;
  /** W-P2 (D-W7) — cached-epoch refresh cadence (ms). Default 60_000. */
  epochRefreshIntervalMs?: number;
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
      // board must never assemble below the on-chain floor (G5 fail-closed).
      const effectiveQuorum = Math.max(minQuorum, threshold);
      const canonicalMsgHex = canonicalBytesToHex(canonicalMsg);
      // The cell CLAIM: the only identifying field the collector needs is the cell key
      // (canonicalMsgHex) — every CP that re-derived these exact bytes opens the SAME cell.
      // The other fields are advisory (the attestations already carry the signed bytes).
      const claim: CapTokenIssueClaim = {
        kind: 'captoken-issue',
        roomId: '0x' + '00'.repeat(32),
        peerPubkey: new Array(32).fill(0),
        role: 0,
        expiresEpoch: 0n,
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

      // 2) POLL listOpen() until the cell reaches `effectiveQuorum` DISTINCT operators.
      for (let round = 0; round < maxPollRounds; round++) {
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
  const cpKeystore =
    opts.cpKeystore ?? buildLocalCpKeystore({ signer: opts.signer, logger: opts.logger });

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

/**
 * P17 M2a-P11 — assemble + start the cp-daemon's F61 HealthMonitor
 * (DOH-014/016/017/018). Binds the HARD GATE `operator := signer.toSuiAddress()`
 * (the same signer makeChainReporter signs with → operator == ctx.sender(), so
 * report_cp_degradation does not abort, E_NOT_OPERATOR node_health.move:118).
 * variant 'cp' → report_cp_degradation over the ControlPlaneCap (node_type=3
 * hardcoded on-chain). Exported (not inline) so the wiring is unit-testable.
 */
export function startHealthMonitor(args: {
  client: SuiClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  deps: CpHealthDeps;
  logger: Logger;
  env?: ThresholdEnv;
}): { monitor: HealthMonitor; stop: () => void } {
  const { client, signer, config, cpCapId, deps, logger: log, env = process.env } = args;
  const operator = signer.toSuiAddress();
  const reporter = makeChainReporter({
    client,
    signer,
    config,
    capId: cpCapId,
    operator,
    variant: 'cp',
    logger: log,
  });
  const monitor = new HealthMonitor({
    signals: buildHealthSignals(deps, env),
    reporter,
    logger: log,
    cooldownMs: readCooldownMs(env),
  });
  monitor.start();
  return { monitor, stop: () => monitor.stop() };
}

// ── P17 M2b-P10 (DOH-021/023/024): F60 graceful shutdown ──────────────────────

/**
 * The cp-daemon's teardown closures, injected into {@link buildCpShutdownPlan}.
 * The cp-daemon is poller-only (no WS accept, nothing to drain) → `setAccepting`
 * and `drain` are NO-OPs; the substance is the ordered reactive → liveness-LAST
 * groups over the heartbeat + role-voting + the two watchers + the TURN/cap-token
 * issuers + the 9 EventPollers.
 */
export interface CpShutdownDeps {
  logger: Logger;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener (pause-arm only). */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the VOTE-06 role-voting loop. */
  stopRoleVoting: () => void;
  /** (3) reactive — the F47 re-vote watcher. */
  stopRevoteWatcher: () => void;
  /** (3) reactive — the RO-009 relay-heartbeat (Layer C) watcher. */
  stopRelayHeartbeatWatcher: () => void;
  /** (3) reactive — the TURN issuer rotation loop. */
  stopTurnIssuer: () => void;
  /** (3) reactive — the F62 cap-token issuer epoch refresher. */
  stopCapTokenIssuer: () => void;
  /** (3) reactive — the optional TURN RPC HTTP server (null when TURN_RPC_TOKEN unset). */
  stopTurnRpc?: () => void;
  /** (3) reactive — the 9 control-plane EventPollers. */
  stopPollers: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the daemon live). */
  stopHeartbeat: () => void;
  /** (4) LAST — the /healthz liveness server. */
  closeHealthz: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * Assemble the cp-daemon's ordered graceful-shutdown plan, encoding the two
 * cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops
 *         FIRST in `stopReactive` (with the watcher + ChainEventListener + the
 *         role-voting / re-vote / relay-heartbeat watchers + the TURN/cap-token
 *         issuers + the 9 pollers), NOT before the drain.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz) so the chain sees
 *         the cp LIVE through teardown (D-DOH-M2-F60-3 split-brain fix).
 * `setAccepting` + `drain` are NO-OPs (cp is poller-only). Exported (not inline) so
 * the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildCpShutdownPlan(
  reason: string,
  deps: CpShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: () => {}, // NO-OP — cp has no connection accept
    drain: async () => {}, // NO-OP — poller-only, nothing in-flight
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      deps.stopRoleVoting();
      deps.stopRevoteWatcher();
      deps.stopRelayHeartbeatWatcher();
      deps.stopTurnIssuer();
      deps.stopCapTokenIssuer();
      deps.stopTurnRpc?.();
      deps.stopPollers();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      await deps.closeHealthz();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * Assemble + start the cp-daemon's F60 SelfShutdownWatcher.
 *
 * The cp-daemon is NOT slashable (D-F60-4) and CP self-degradation is out of scope
 * (CP failover deferred to advisor gate 5) → arms = { paused } ONLY: it subscribes
 * NEITHER economic_layer NOR node_health, so only the `is_paused()` poll is armed.
 * Because both id-filtered arms are off, `ownMinerId` is unused → we pass `''` and
 * SKIP the {@link readCapMinerId} RPC (unlike validator/signaling, which arm
 * `degraded` and need the self-filter id). The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * The existing cp event-handler `RelaySlashed` arm (the TURN kill-switch for OTHER
 * relays) is UNTOUCHED — distinct from this self-targeted terminal trigger.
 * Exported so the arms + skipped-RPC wiring is unit-testable.
 */
export async function startCpSelfShutdownWatcher(args: {
  client: SuiClient;
  config: NetworkConfig;
  cpCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, listener, onSelfShutdown, logger: log } = args;
  const watcher = new SelfShutdownWatcher({
    listener,
    ownMinerId: '', // unused — both id-filtered arms (slash/degraded) are off
    arms: { slash: false, degraded: false, paused: true },
    onSelfShutdown,
    logger: log,
    isPaused: () => readIsPaused(client, config.packageId, config.networkRegistryId, log),
  });
  await watcher.start();
  return { watcher, stop: () => watcher.stop() };
}

async function main(): Promise<void> {
  // Load configuration
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const signer = loadKeypair('CP_KEYPAIR');

  const address = signer.toSuiAddress();
  logger.info(
    { address, rpcUrl: config.rpcUrl, packageId: config.packageId },
    'CP daemon starting',
  );

  // P17 M2b-P10 (DOH-019/027): the ChainEventListener backing the F60
  // SelfShutdownWatcher (pause arm only — NO subscribes) + the /healthz isLive
  // gate. HONEST CARRY-FORWARD: cp's 9 EventPollers are NOT routed through this
  // listener and the watcher's degraded arm is OFF → this listener has ZERO
  // subscribers → isDegraded() is always false → cp /healthz stays 200 in
  // practice (the isLive capability is wired but currently VACUOUS for cp). cp
  // /healthz is NOT peer-polled, so a 503 would be safe anyway (F1=Option A).
  const listener = new ChainEventListener({
    client,
    packageId: config.packageId,
    logger: logger.child({ component: 'self-shutdown-listener' }),
  });
  const gracefulCfg = readGracefulShutdownConfig();

  // F65 (DOH-008/009) — always-on, cheap liveness endpoint.
  const healthz = await startHealthzServer({
    port: Number(process.env['CP_HEALTHZ_PORT'] ?? 8091),
    service: 'cp-daemon',
    isLive: () => !listener.isDegraded(),
  });
  logger.info({ port: healthz.port }, 'healthz listening');

  // Auto-register if CP_CAP_ID not in env
  const { cpCapId } = await ensureRegistered(client, signer, config, logger);

  // Start heartbeat loop
  const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
  const stopHeartbeat = startHeartbeat(
    client,
    signer,
    config,
    cpCapId,
    heartbeatIntervalMs,
    logger,
  );

  // Start role voting loop (VOTE-06)
  const roleVotingIntervalMs = parseInt(process.env['ROLE_VOTING_INTERVAL_MS'] ?? '30000', 10);
  const stopRoleVoting = startRoleVoting(
    client,
    signer,
    config,
    cpCapId,
    logger,
    roleVotingIntervalMs,
  );

  // F47 RV-013 (Phase 4.0) — re-vote watcher, now wired with the live
  // SuiChainStateReader. The watcher scans on-chain state every `scanEpochs`
  // epochs and submits permissionless `mark_revote_eligible_*` TXs (idle +
  // composition-shift); every mark re-validates on-chain, so the daemon is
  // advisory. Cadence resolves from REVOTE_SCAN_INTERVAL_EPOCHS via
  // resolveScanIntervalEpochs(); the epoch→ms conversion happens here where the
  // live epoch duration is known.
  const reader = new SuiChainStateReader(client, config, logger);
  const scanEpochs = resolveScanIntervalEpochs();
  // epoch→ms: prefer an explicit ms override (demo/localnet set a small value),
  // else derive from the live epoch duration. No hardcode.
  const sysState = await client.getLatestSuiSystemState();
  const revoteIntervalMs = parseInt(
    process.env['REVOTE_SCAN_INTERVAL_MS'] ?? String(scanEpochs * Number(sysState.epochDurationMs)),
    10,
  );
  const stopRevoteWatcher = startRevoteWatcher(
    reader,
    makeMarkSubmitter(client, signer, config, logger),
    logger,
    revoteIntervalMs,
  );
  logger.info({ module: 'cp-daemon', scanEpochs, revoteIntervalMs }, 'revote watcher started');

  // M1 Phase 3.1 (REQ-RO-009) — RelayHeartbeatWatcher (Layer C, chain-authoritative).
  // Mirrors the revote-watcher wiring above: a LiveRelayChainStateReader over the
  // devInspect seam feeds the watcher, which submits permissionless `promote_relay`
  // PTBs (via makePromoteSubmitter) when a primary's heartbeat is stale > 3 epochs
  // and the standby is fresh. The chain re-asserts staleness (E_RELAY_NOT_STALE) so
  // the daemon is advisory. Cadence: RELAY_HEARTBEAT_SCAN_INTERVAL_MS (default = the
  // live epoch duration, so detection lands within the ~3-epoch threshold window;
  // C2: this poll cadence is now honored, NOT hardcoded). Phase 5.3 bench tunes it.
  const relayReader = new LiveRelayChainStateReader(client, config, logger);
  const relayHeartbeatScanMs = parseInt(
    process.env['RELAY_HEARTBEAT_SCAN_INTERVAL_MS'] ?? String(Number(sysState.epochDurationMs)),
    10,
  );
  const relayHeartbeatWatcher = startRelayHeartbeatWatcher(
    relayReader,
    makePromoteSubmitter(client, signer, config, logger),
    logger,
    { pollIntervalMs: relayHeartbeatScanMs },
  );
  const stopRelayHeartbeatWatcher = (): void => relayHeartbeatWatcher.stop();
  logger.info(
    { module: 'cp-daemon', relayHeartbeatScanMs },
    'relay heartbeat watcher started (Layer C)',
  );

  // Bootstrap TURN issuer (S30.B Option A — ADR-0005 hybrid 24h+on-slash rotation)
  const turnRotationIntervalMs = parseInt(
    process.env['TURN_ROTATION_INTERVAL_MS'] ?? '86400000',
    10,
  );
  const { issuer: turnIssuer, stop: stopTurnIssuer } = await startTurnIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpCapId,
    logger,
    rotateIntervalMs: turnRotationIntervalMs,
  });

  // S30.C: Optional TURN RPC HTTP server. Enabled iff TURN_RPC_TOKEN is set.
  // Relay daemon fetches credentials via POST /turn/issue during client room-join.
  const turnRpcToken = process.env['TURN_RPC_TOKEN'];
  const stopTurnRpc = turnRpcToken
    ? (
        await startTurnRpc({
          issuer: turnIssuer,
          port: parseInt(process.env['TURN_RPC_PORT'] ?? '8090', 10),
          token: turnRpcToken,
          logger,
        })
      ).stop
    : null;

  // F62 Stage 4 Item #1 — bootstrap CapTokenIssuer.
  // Wired with LocalCpKeystore (signs with local CP Ed25519 key). Peer-CP
  // discovery for true M-of-N is post-thesis (D-014); the daemon currently
  // runs with `quorumThreshold` defaulting to 2, so until peer-CP discovery
  // lands the issuer will log ERROR + skip submit on each event — exactly the
  // behavior STATUS.md § Stage 4 readiness #1 prescribes as the M1 wiring goal.
  const capTokenIssuerThreshold = parseInt(
    process.env['CAP_TOKEN_QUORUM_THRESHOLD'] ?? '2',
    10,
  );
  const { issuer: capTokenIssuer, stop: stopCapTokenIssuer } = await startCapTokenIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpRegistryObjectId: process.env['CP_REGISTRY_OBJECT_ID'] ?? '',
    quorumStateObjectId: process.env['QUORUM_STATE_OBJECT_ID'] ?? '',
    quorumThreshold: capTokenIssuerThreshold,
    logger,
  });
  // Set up event handler with TX context for room assignment + TURN kill-switch
  // + cap-token issuance (F62 M2 W-P2 — capTokenIssuer threaded into txContext so
  // RoomAssigned/RoleAssigned/RoleChanged/RelaySlashed arms drive the issuer).
  // M1 Phase 3.1 (REQ-RO-009 / C8) — RelayPromoted observer. The chain-authoritative
  // promotion event is the split-brain resolver: when room_manager::promote_relay
  // emits RelayPromoted, the cp-daemon records it (the canonical Stay decision). The
  // client drives its own re-discovery off the same on-chain event via
  // useRelayDiscovery; the daemon-side observer is the audit + future hook point.
  const relayPromotedObserver = {
    onRelayPromoted: async (
      evt: { room_id: string; old_primary: string; new_primary: string; epoch: number },
      traceId: string,
    ): Promise<void> => {
      logger.info(
        {
          trace_id: traceId,
          module: 'cp-daemon',
          action: 'relay-promoted-observed',
          context: {
            roomId: evt.room_id,
            oldPrimary: evt.old_primary,
            newPrimary: evt.new_primary,
            epoch: evt.epoch,
          },
        },
        'RelayPromoted observed — chain-authoritative promotion recorded (Layer C)',
      );
    },
  };

  const { handler, relayState, signalingState, validatorState } = createEventHandler(logger, undefined, {
    client,
    signer,
    config,
    cpCapId,
    turnIssuer,
    capTokenIssuer,
    relayPromotedObserver,
  });

  // ── F61 health signals (DOH-014) ──────────────────────────────────────────
  // rpc_error_rate: queryEvents failures / attempts, sampled at the bootstrap loop
  // (the verified in-daemon queryEvents catch — the EventPoller's internal poll is
  // private to @dvconf/shared, untouched). HONEST CARRY-FORWARD: the bootstrap loop
  // runs once at startup, so this is a startup-RPC-health gauge; a continuously
  // refreshed rate would need a net-new periodic probe (deferred, OQ-DOH-3).
  let rpcErrors = 0;
  let rpcTotal = 0;
  const getRpcErrorRate = (): number => (rpcTotal === 0 ? 0 : rpcErrors / rpcTotal);
  // event_lag: now - newest handled event timestamp (continuously updated by the
  // tracked handler below). Primes 0 (= healthy) until the first event is seen.
  let newestEventTsMs = 0;
  const getEventLagMs = (): number =>
    newestEventTsMs === 0 ? 0 : Math.max(0, Date.now() - newestEventTsMs);
  // Additive wrapper: stamp the newest event ts then delegate to the real handler
  // (event-handler.ts + its RelaySlashed arm untouched). Used by the bootstrap
  // replay + all pollers below.
  const trackedHandler = async (ev: SuiEvent): Promise<void> => {
    const ts = ev.timestampMs ? Number(ev.timestampMs) : 0;
    if (ts > newestEventTsMs) newestEventTsMs = ts;
    await handler(ev);
  };

  // Bootstrap: replay historical relay/signaling/validator events so state maps are populated
  // before real-time polling starts (prevents race where relay registers before CP poller runs)
  for (const mod of ['relay_registry', 'signaling_registry', 'validator_registry', 'registration'] as const) {
    try {
      const events = await client.queryEvents({
        query: { MoveEventModule: { package: config.packageId, module: mod } },
        limit: 100,
      });
      rpcTotal++; // F61 rpc_error_rate: a successful queryEvents attempt (DOH-014)
      for (const ev of events.data) {
        await trackedHandler(ev);
      }
      logger.info({ module: mod, count: events.data.length }, 'Bootstrap: replayed historical events');
    } catch (err) {
      rpcErrors++; // F61 rpc_error_rate: a failed queryEvents attempt (DOH-014)
      rpcTotal++;
      logger.warn({ module: mod, err }, 'Bootstrap: failed to query historical events');
    }
  }
  logger.info(
    { relays: relayState.size, signaling: signalingState.size, validators: validatorState.size },
    'Bootstrap complete — state maps populated',
  );

  // Poll relay_registry events
  const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);

  const relayPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'relay_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/relay_registry.json',
    logger: logger.child({ poller: 'relay_registry' }),
  });

  const cpPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'control_plane_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/control_plane_registry.json',
    logger: logger.child({ poller: 'control_plane_registry' }),
  });

  const roomPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'room_manager',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/room_manager.json',
    logger: logger.child({ poller: 'room_manager' }),
  });

  const signalingPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'signaling_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/signaling_registry.json',
    logger: logger.child({ poller: 'signaling_registry' }),
  });

  const economicPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'economic_layer',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/economic_layer.json',
    logger: logger.child({ poller: 'economic_layer' }),
  });

  const validatorPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/validator_registry.json',
    logger: logger.child({ poller: 'validator_registry' }),
  });

  const roleVotingPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'role_voting',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/role_voting.json',
    logger: logger.child({ poller: 'role_voting' }),
  });

  const registrationPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'registration',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/registration.json',
    logger: logger.child({ poller: 'registration' }),
  });

  // F8 (REQ-CRR-005) — poll turn_credential events so the cp-daemon observes
  // emergency relay-secret rotations (SecretRotated) and arms the TURN issuer
  // kill-switch via handleEvent → turnIssuer.emergencyEvictSecret. Live-only
  // (no historical replay): SecretRotated is an emergency kill-switch; replaying
  // past rotations on restart would only re-evict already-evicted secrets (no-op).
  const turnCredentialPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'turn_credential',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/turn_credential.json',
    logger: logger.child({ poller: 'turn_credential' }),
  });

  // Start all pollers (trackedHandler stamps the event-lag gauge then delegates)
  await Promise.all([
    relayPoller.start(trackedHandler),
    cpPoller.start(trackedHandler),
    roomPoller.start(trackedHandler),
    signalingPoller.start(trackedHandler),
    economicPoller.start(trackedHandler),
    validatorPoller.start(trackedHandler),
    roleVotingPoller.start(trackedHandler),
    registrationPoller.start(trackedHandler),
    turnCredentialPoller.start(trackedHandler),
  ]);

  // DOH-014/016/017/018: start the F61 self-degradation HealthMonitor (variant 'cp').
  // Additive loop alongside the heartbeat + 9 pollers; getters close over the rpc
  // + event-lag counters declared above. RO-020 healthz + event-handler untouched.
  const { stop: stopHealthMonitor } = startHealthMonitor({
    client,
    signer,
    config,
    cpCapId,
    logger,
    deps: { getRpcErrorRate, getEventLagMs },
  });

  logger.info(
    { heartbeatIntervalMs, pollIntervalMs, roleVotingIntervalMs, turnRotationIntervalMs },
    `CP daemon started — heartbeat every ${heartbeatIntervalMs}ms, polling events every ${pollIntervalMs}ms, role voting every ${roleVotingIntervalMs}ms, TURN secret rotating every ${turnRotationIntervalMs}ms`,
  );

  // ── P17 M2b-P10 (DOH-021/023/024): F60 graceful shutdown ──────────────────
  // Funnel SIGTERM/SIGINT AND the SelfShutdownWatcher trigger through ONE ordered
  // runGracefulShutdown — replaces the blind exit(0) with the 30s-drain (a NO-OP
  // for cp: poller-only, nothing in-flight) / 60s-force-kill (NET-NEW; cp had
  // none) sequence + C-A (HealthMonitor → reactive, stops FIRST there) + C-B
  // (heartbeat/healthz → LAST, the D-DOH-M2-F60-3 split-brain fix).
  let stopSelfShutdownWatcher: () => void = () => {};

  const runCpShutdown = (reason: string): void => {
    void runGracefulShutdown(
      buildCpShutdownPlan(reason, {
        logger,
        stopHealthMonitor, // C-A: DOH-018 — stop self-degradation submits in reactive
        stopWatcher: () => stopSelfShutdownWatcher(),
        stopChainListener: () => listener.stop(),
        stopRoleVoting,
        stopRevoteWatcher,
        stopRelayHeartbeatWatcher,
        stopTurnIssuer,
        stopCapTokenIssuer,
        stopTurnRpc: stopTurnRpc ? () => void stopTurnRpc() : undefined,
        stopPollers: () => {
          relayPoller.stop();
          cpPoller.stop();
          roomPoller.stop();
          signalingPoller.stop();
          economicPoller.stop();
          validatorPoller.stop();
          roleVotingPoller.stop();
          registrationPoller.stop();
          turnCredentialPoller.stop();
        },
        stopHeartbeat, // C-B → LAST
        closeHealthz: () => healthz.close(),
        exit: (code) => process.exit(code),
        config: gracefulCfg,
      }),
    );
  };

  // cp is NOT slashable (D-F60-4) + CP self-degradation is out of scope → arms
  // { paused } ONLY (subscribes NEITHER economic_layer NOR node_health).
  ({ stop: stopSelfShutdownWatcher } = await startCpSelfShutdownWatcher({
    client,
    config,
    cpCapId,
    listener,
    onSelfShutdown: (reason) => {
      logger.error({ reason }, 'self-shutdown triggered — initiating graceful shutdown');
      runCpShutdown(reason);
    },
    logger,
  }));

  process.on('SIGTERM', () => runCpShutdown('SIGTERM'));
  process.on('SIGINT', () => runCpShutdown('SIGINT'));
}

// Only run the daemon when executed as the entrypoint (`node index.js` / `tsx
// src/index.ts`). Stays inert on import so unit tests can exercise the exported
// factories (startCapTokenIssuer, buildLocalCpKeystore) without auto-starting main().
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]!).href;
if (isMain) {
  main().catch((err) => {
    logger.fatal({ err }, 'CP daemon crashed');
    process.exit(1);
  });
}
