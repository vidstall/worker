/**
 * REQ-CFA-042 / REQ-CFA-043 (M4a chunk 3, D-CFA-33) — verify/publish loop HERMETIC HALF
 * (validator-daemon).
 *
 * Wires the M3 verify chain that had ZERO production callers
 *   verifyForwardedCanary (verifier.ts:189)
 *     -> classifyDivergences (loss-classifier.ts:236)
 *       -> buildDivergenceProof (proof.ts:164)
 *         -> submitCanarySlash (slash-submitter.ts)
 * behind an INJECTABLE `CanaryForwardCapture` + `submit` seam, in a crash-safe interval loop
 * mirroring `startCanaryCellLoop`. This is the HERMETIC HALF only:
 *
 *   - NO live media, NO mediasoup, NO `publisher.publish()`, NO `WebRtcTransport` capture —
 *     the captured forwarded Buffers come from the injected `capture` seam (synthetic in
 *     tests; the LIVE producer/SFU-forward/consumer plane is M4b, port-locked this session).
 *   - ZERO `apps/relay/` edit (INV-B). Every media tap stays validator-daemon-side.
 *   - The `MIN_ATTESTERS=2` quorum is now formed by the W-M4-COSIGN PULL-CORROBORATION claim board
 *     (claim-board.ts, D-CFA-42): each daemon PUBLISHES its OWN Wallet-B self-attestation
 *     (signSelfAttestation) and a slash ASSEMBLEs only when >=2 DISTINCT session pubkeys accrue. The
 *     M4a synthetic-peer-keypair seam is GONE. The LIVE cross-validator media capture + the live
 *     cp-daemon carrier remain M4b — the gate is exercised over SYNTHETIC captures here (W-M3-SIM
 *     narrowed, not closed; W-M4-COSIGN protocol root is now BUILT, its live transport is M4b).
 *
 * ── WHAT THIS GENUINELY CLOSES vs WHAT IT DOES NOT (DA-3, on record) ─────────────────────
 *   CLOSES W-M3-STUN-PATH: `state.relayStunLossBps` (index.ts decl/init + the measureRelay write
 *     — WRITTEN with zero readers) gets its FIRST real reader. The loop reads
 *     `getStunLossBps(relayId) ?? 0n` and passes it AS the classifier's `stunPacketLossBps`
 *     arg (folded into the benign budget, D-CFA-25 — a COARSE prior, never a binding signal).
 *   NARROWS (does NOT close) W-M3-SIM: a real `PerReceiverDivergences` Map is assembled over
 *     the room-scoped pool (chunk 1) so the SECONDARY denominator is truthful — but the
 *     per-receiver frames are synthetic (no live cross-validator media). NOT "live corroboration".
 *   AMPLIFIES W-M3-OFFCHAIN: this loop IS the off-chain gate going live. A colluding quorum's
 *     invisible eligibility lever now actually fires. Re-disclosed, tied to W-E4. NEVER "resolved".
 *
 * PURE CORE: `runCanaryVerifyRound` is deterministic in its inputs (the injected capture +
 * an explicit immutable-style accumulator) — unit-testable WITHOUT ports. `startCanaryVerifyLoop`
 * is the additive, crash-safe interval shell (each round wrapped in a try; a fault NEVER escapes).
 *
 * LOGGING (HARD-GATE): holds NO key material. cellSecret/kRoom flow THROUGH the capture seam
 * into the verifier but are NEVER logged here (only non-secret counts: relayMinerId, promoted,
 * absorbed, perReceiver). INV-C: every id logged is a public miner_id / room id.
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createLogger, type Logger } from '@dvconf/shared';
import { verifyForwardedCanary, type CanaryDivergence } from './verifier.js';
import {
  classifyDivergences,
  newDropAccumulator,
  accumulateRound,
  type DropAccumulator,
  type PerReceiverDivergences,
} from './loss-classifier.js';
import {
  OBSERVED_HASH_MISSING,
  canonicalProofMessage,
  signSelfAttestation,
  assembleProofFromAttestations,
  distinctAttesterCount,
  MIN_ATTESTERS,
  type DivergenceProof,
  type DivergenceClaim,
  type DivergenceAttestation,
} from './proof.js';
import { attestIfIndependentlyObserved, type ClaimBoard } from './claim-board.js';
import type { CanaryValidator, RelayRoomScope } from './cell.js';

const MOD = 'canary/verify-loop';

/**
 * One round's captured forwarded canary frames for a `(relay, room)` scope, keyed by the
 * DISTINCT receiver miner_id that captured them, plus the verify inputs needed to recompute
 * the local ground-truth canary set. In M4b the `perReceiver` Buffers come from real
 * cross-validator `WebRtcTransport` consumers; here they are synthetic (injected). The
 * cellSecret/kRoom are the per-cell OOB factors the verifier re-derives K_canary from —
 * carried THROUGH (never logged).
 */
export interface CanaryForwardCaptureResult {
  relayId: string;
  roomId: string;
  canaryKid: number;
  /** The LOCALLY-driven expected ctr sequence (the canonical canary frame order). */
  expectedCtrs: number[];
  kRoom: Uint8Array;
  cellSecret: Uint8Array;
  /** receiverMinerId -> the canary-bearing RTP packets that receiver captured this round. */
  perReceiver: Map<string, Buffer[]>;
}

/**
 * The injectable forwarded-capture seam: given a `(relay,room)` scope, return that round's
 * per-receiver captured frames + verify inputs. SYNTHETIC in tests (no live media); the LIVE
 * producer/SFU-forward/consumer implementation is M4b (port-locked). MAY throw — the loop is
 * crash-safe around it.
 */
export type CanaryForwardCapture = (scope: RelayRoomScope) => Promise<CanaryForwardCaptureResult>;

/** The injectable slash-submit seam (synthetic in tests; the live PTB submit is M4b). */
export type CanarySlashSubmit = (proof: DivergenceProof) => Promise<void>;

/** Tuning for the per-round classify gate (mirrors LossClassifierConfig's gate knobs). */
export interface CanaryVerifyConfig {
  /** SECONDARY signal floor: a DROP correlates only when MISSING in >= k DISTINCT receivers. */
  k: number;
  /** WEAK-PRIOR band (bps) added to the STUN prior to form the benign budget. */
  deltaBps: bigint;
  /** Expected canary frames per round (the send-rate window denominator). */
  sendRate: number;
}

/** The verify-loop dependency seam (all injectable so the loop runs with NO ports). */
export interface CanaryVerifyDeps {
  /** The `(relay, room)` scopes to audit this round (chunk-1 per-relay room-scoping). */
  getRelayRoomScopes: () => RelayRoomScope[];
  /**
   * The room-scoped co-auditor pool for a scope (chunk 1's `buildRelayScopedValidatorPool`),
   * so the SECONDARY `>= k` denominator is TRUTHFUL (no cross-room over-count, W-M3-OVERCOUNT).
   */
  getValidators: (scope: RelayRoomScope) => CanaryValidator[];
  /**
   * Read `state.relayStunLossBps.get(relayId) ?? 0n` — the FIRST real reader (closes
   * W-M3-STUN-PATH). The returned bps is folded into the classifier benign budget.
   */
  getStunLossBps: (relayId: string) => bigint;
  /** Capture the forwarded canary frames per receiver (injectable; synthetic in tests). */
  capture: CanaryForwardCapture;
  /**
   * This validator's OWN pull-corroboration claim board (W-M4-COSIGN, D-CFA-42/43): it PUBLISHES its
   * own Wallet-B self-attestation here, POLL-CORROBORATEs open cells against it, and ASSEMBLES+SUBMITS
   * from it (step 7). In-memory fake in tests; the live OFF-MEDIA-PATH cp-daemon carrier is M4b
   * (D-CFA-47). REPLACES the M4a synthetic-peer-keypair seam.
   *
   * C1 (ADR-0021, PLAN-m4b-hermetic §3.2): assemble+submit reads from THIS board only — there is no
   * designated assembler. Every co-observer is an equal assembler+submitter over its OWN board.
   */
  localBoard: ClaimBoard;
  /**
   * C1 censorship-resistance fan-out (ADR-0021, PLAN-m4b-hermetic §3.2). When this validator
   * self-attests (step 5) or corroborates (step 6), it cross-posts the attestation to EVERY board in
   * this list (in addition to `localBoard`) so each honest co-observer independently accrues >=2 on
   * its OWN board. DEFAULT `[]` -> the fan-out is a no-op and the singleton path is BYTE-IDENTICAL to
   * the pre-C1 single-board behavior. Cross-post is FAIL-OPEN per board (a failing co-observer board
   * must NEVER abort the round — redundancy IS the safety net here, the deliberate OPPOSITE of the
   * fail-CLOSED carrier-store discipline). The live OOB-manifest-discovered boards are M4b.
   */
  coObserverBoards?: ClaimBoard[];
  /**
   * C1 jittered self-submit (ADR-0021, PLAN-m4b-hermetic §3.2): awaited immediately BEFORE
   * `deps.submit(proof)` to de-synchronize the now-redundant submitters across co-observers (the
   * on-chain VecSet + `markSubmitted` + the already-slashed abort absorb any double-submit race).
   * DEFAULT no-op -> deterministic in tests + byte-identical timing for the singleton path.
   */
  jitter?: () => Promise<void>;
  /** This validator's Wallet-B SESSION keypair — signs its OWN single attestation only (INV-C). */
  selfSessionKeypair: Ed25519Keypair;
  /** Submit a built proof (injectable; the live PTB submit is M4b). */
  submit: CanarySlashSubmit;
  /** Gate tuning. */
  config: CanaryVerifyConfig;
  /**
   * Monitoring-redesign gap #4 (optional; default no-op -> byte-identical without it).
   * Fired once per scope, right where `perReceiver.size` is already computed (the
   * distinct-receiver breadth for that (relay,room) scope this round).
   */
  onCoverageSample?: (relayMinerId: string, distinctValidators: number) => void;
  /**
   * Monitoring-redesign gap #4 (optional). Fired once per open cell, right where the
   * >=2-distinct-attester quorum gate is already evaluated (step 7).
   */
  onQuorumSample?: (relayMinerId: string, met: boolean) => void;
  /**
   * Monitoring-redesign gap #4 (optional). Fired once per proof actually assembled +
   * submitted (step 7) -- the chain-visible "promoted" moment.
   */
  onDivergencePromoted?: () => void;
}

/**
 * C1 cross-post fan-out (PLAN-m4b-hermetic §3.2). Post `attestation` for `claim` to the validator's
 * OWN `localBoard` AND every co-observer board, FAIL-OPEN per board: a single failing co-observer
 * board is logged and skipped, NEVER aborting the round. The redundancy across boards — not any one
 * board — is the censorship-resistance safety net, so a fail-CLOSED here would re-introduce the very
 * censorship lever C1 removes. The `localBoard` post is also wrapped so a transient local failure
 * cannot deny a peer's accrual on the other boards.
 */
async function fanOutPost(
  deps: CanaryVerifyDeps,
  claim: DivergenceClaim,
  attestation: DivergenceAttestation,
  round: number,
  log: Logger,
): Promise<void> {
  const boards: ClaimBoard[] = [deps.localBoard, ...(deps.coObserverBoards ?? [])];
  for (const board of boards) {
    try {
      await board.post(claim, attestation, round);
    } catch (err) {
      // FAIL-OPEN: redundancy is the safety net; one censoring/unreachable co-observer board must not
      // abort the round (that would BE the censorship lever C1 closes). Logged, then skipped.
      log.warn(
        { err, round, relayMinerId: claim.relayMinerId, frameSeq: claim.frameSeq },
        'C1 cross-post to a co-observer board failed (fail-open — redundancy is the safety net)',
      );
    }
  }
}

/** The result of ONE verify round — the NEW accumulator + what was promoted/absorbed. */
export interface CanaryVerifyRoundResult {
  /** The per-relay drop accumulator AFTER this round (folded ON TOP of the input — persisted). */
  accumulator: DropAccumulator;
  /** Divergences promoted to slashable this round (one proof per frameSeq, submitted). */
  promoted: CanaryDivergence[];
  /** Divergences absorbed as benign loss this round. */
  absorbed: CanaryDivergence[];
  /** Distinct receivers whose divergences fed the per-receiver Map (the SECONDARY breadth). */
  perReceiverCount: number;
}

/**
 * Tally one relay's observed DROPs + expected sends for the cumulative accumulator. A frame is
 * DROPPED iff it is MISSING in the canonical (deduped-by-frameSeq) divergence set; `expectedSends`
 * is the send-rate window (the expected-ctr count). One canonical entry per frameSeq (a frame
 * MISSING in several receivers counts ONCE — distinctness is the SECONDARY signal, not the rate).
 */
function tallyRound(
  perReceiver: PerReceiverDivergences,
  expectedSends: number,
): { observedDrops: number; expectedSends: number } {
  const droppedSeqs = new Set<number>();
  for (const divergences of perReceiver.values()) {
    for (const d of divergences) {
      if (d.observedHash === OBSERVED_HASH_MISSING) droppedSeqs.add(d.frameSeq);
    }
  }
  return { observedDrops: droppedSeqs.size, expectedSends: Math.max(0, expectedSends) };
}

/**
 * Run ONE verify round for all current `(relay,room)` scopes against the supplied accumulator,
 * returning a NEW accumulator (the input is left untouched — crash-safe, immutable-style). PURE
 * w.r.t. its injected deps:
 *
 *   1. capture(scope) -> per-receiver forwarded Buffers (synthetic here; live = M4b)
 *   2. verifyForwardedCanary per receiver -> assemble a real PerReceiverDivergences Map
 *   3. accumulateRound(acc, relayId, {drops, sends}) -> the NEW persisted accumulator
 *   4. classifyDivergences(map, getStunLossBps(relayId) ?? 0n, acc', cfg) -> promoted/absorbed
 *      (the STUN read is the FIRST reader — closes W-M3-STUN-PATH)
 *   5. for each promoted frameSeq: buildDivergenceProof(SYNTHETIC peers) -> submit
 *
 * Multiple scopes share ONE accumulator threaded scope-to-scope (each keyed by its relayId
 * inside the accumulator), so the returned accumulator folds every scope this round.
 */
export async function runCanaryVerifyRound(
  deps: CanaryVerifyDeps,
  prev: DropAccumulator | undefined,
  round: number,
  loggerArg?: Logger,
): Promise<CanaryVerifyRoundResult> {
  const log = loggerArg ?? createLogger(MOD);
  // Immutable-style: start from a SHALLOW copy of the prior accumulator so the caller's
  // reference is never mutated (accumulateRound already returns a new map; this guards the
  // first-round `undefined` and keeps the input object frozen for the crash-safe loop).
  let acc: DropAccumulator = prev
    ? { byRelay: new Map(prev.byRelay) }
    : newDropAccumulator();

  const promoted: CanaryDivergence[] = [];
  const absorbed: CanaryDivergence[] = [];
  let perReceiverCount = 0;
  // This daemon's local divergence view per (roomId|relayMinerId) scope — the POLL-CORROBORATE step
  // (after the scope loop) checks open cells against it so it only ever attests what it observed.
  const localByScope = new Map<string, CanaryDivergence[]>();

  for (const scope of deps.getRelayRoomScopes()) {
    const cap = await deps.capture(scope);

    // (2) verify per receiver -> real PerReceiverDivergences Map (the SECONDARY breadth source).
    const perReceiver: PerReceiverDivergences = new Map();
    for (const [receiverMinerId, captured] of cap.perReceiver) {
      const vr = await verifyForwardedCanary(captured, {
        kRoom: cap.kRoom,
        roomId: scope.roomId,
        cellSecret: cap.cellSecret,
        canaryKid: cap.canaryKid,
        expectedCtrs: cap.expectedCtrs,
      });
      perReceiver.set(receiverMinerId, vr.divergences);
    }
    perReceiverCount = Math.max(perReceiverCount, perReceiver.size);
    deps.onCoverageSample?.(scope.relayId, perReceiver.size);

    // (3) fold this round's drop tally into the PERSISTED per-relay accumulator (keyed by relayId).
    const tally = tallyRound(perReceiver, cap.expectedCtrs.length || deps.config.sendRate);
    acc = accumulateRound(acc, scope.relayId, tally);

    // (4) classify — the STUN value is READ here as the classifier's stunPacketLossBps arg
    // (FIRST real reader -> closes W-M3-STUN-PATH; folded into the benign budget, D-CFA-25).
    const stunPacketLossBps = deps.getStunLossBps(scope.relayId) ?? 0n;
    const result = classifyDivergences(perReceiver, stunPacketLossBps, acc, {
      relayMinerId: scope.relayId,
      k: deps.config.k,
      deltaBps: deps.config.deltaBps,
      sendRate: deps.config.sendRate,
    });

    // (5) W-M4-COSIGN PULL-CORROBORATION (D-CFA-42, replaces the M4a synthetic-mint). PUBLISH-OWN:
    // for each promoted divergence, sign ONE Wallet-B self-attestation over the UNCHANGED 145-byte
    // canonical message and post it to the claim board. The >=2-distinct quorum + assemble/submit
    // happen AFTER the scope loop (a peer daemon's independent attestation must be able to accrue).
    for (const d of result.promoted) {
      const claim: DivergenceClaim = {
        roomId: scope.roomId,
        relayMinerId: scope.relayId,
        canaryId: cap.canaryKid,
        frameSeq: d.frameSeq,
        expectedHash: d.expectedHash,
        observedHash: d.observedHash,
      };
      const selfAtt = await signSelfAttestation(
        canonicalProofMessage({ ...claim, sessionKeypairs: [] }),
        deps.selfSessionKeypair,
      );
      // C1 cross-post (PLAN §3.2): fan the self-attestation out to localBoard + every co-observer
      // board so each honest co-observer independently accrues >=2. coObserverBoards defaults to []
      // (no fan-out) -> byte-identical to the pre-C1 single-board post.
      await fanOutPost(deps, claim, selfAtt, round, log);
      promoted.push(d);
    }
    absorbed.push(...result.absorbed);

    // Remember this scope's local divergence view (union over receivers) so the post-loop
    // POLL-CORROBORATE step can append THIS daemon's attestation to peer-opened cells it can
    // INDEPENDENTLY confirm (D-CFA-41), keyed by the cell's (roomId, relayMinerId) scope.
    const scopeDivs: CanaryDivergence[] = [];
    for (const divs of perReceiver.values()) scopeDivs.push(...divs);
    localByScope.set(`${scope.roomId}|${scope.relayId}`, scopeDivs);

    log.info(
      {
        round,
        relayMinerId: scope.relayId,
        roomId: scope.roomId,
        perReceiver: perReceiver.size,
        promoted: result.promoted.length,
        absorbed: result.absorbed.length,
        stunLossBps: stunPacketLossBps.toString(),
      },
      'canary verify round classified (hermetic half — synthetic capture, STUN read live)',
    );
  }

  // (6) POLL-CORROBORATE (D-CFA-41): append THIS daemon's attestation to any OPEN cell it can
  // INDEPENDENTLY re-observe — only on a local byte-match, so it can never be coerced into
  // attesting a divergence it did not observe. Keyed by the cell's (roomId, relayMinerId) scope.
  for (const open of await deps.localBoard.listOpen()) {
    const localDivs = localByScope.get(`${open.claim.roomId}|${open.claim.relayMinerId}`) ?? [];
    const att = await attestIfIndependentlyObserved(open.claim, localDivs, deps.selfSessionKeypair);
    // C1 cross-post (PLAN §3.2): a corroborating attestation also fans out to every co-observer board
    // so a peer's cell on ANOTHER board accrues this validator's independent observation. FAIL-OPEN.
    if (att) await fanOutPost(deps, open.claim, att, round, log);
  }

  // (7) ASSEMBLE + SUBMIT (D-CFA-40/44): any cell that reached >= MIN_ATTESTERS DISTINCT Wallet-B
  // attesters is assembled from the accrued REMOTE attestations and submitted ONCE (markSubmitted).
  // Sub-quorum cells never submit (FAIL CLOSED). The chain re-verifies + dedups by miner_id.
  // C1 (PLAN §3.2): assemble+submit reads from THIS validator's OWN board (no designated assembler).
  // Each co-observer is an equal assembler+submitter over its own board, so censoring requires
  // compromising ALL >=2 honest boards = exactly the on-chain >=2-distinct threshold.
  for (const open of await deps.localBoard.listOpen()) {
    const quorumMet = distinctAttesterCount(open.attestations) >= MIN_ATTESTERS;
    deps.onQuorumSample?.(open.claim.relayMinerId, quorumMet);
    if (quorumMet) {
      const proof = assembleProofFromAttestations(open.claim, open.attestations);
      // C1 jittered self-submit: de-synchronize the now-redundant submitters before the submit. The
      // on-chain VecSet + markSubmitted below + the already-slashed abort absorb any double-submit
      // race. DEFAULT no-op -> deterministic + byte-identical timing for the singleton path.
      if (deps.jitter) await deps.jitter();
      await deps.submit(proof);
      await deps.localBoard.markSubmitted(open.key);
      deps.onDivergencePromoted?.();
    }
  }

  // (8) GC stale un-quorumed cells (fail-closed after W_corr) + drop submitted cells past the window.
  await deps.localBoard.gc(round);

  return { accumulator: acc, promoted, absorbed, perReceiverCount };
}

/** Live handle for the verify loop: a stop fn + a test-only single-round driver. */
export interface CanaryVerifyLoopHandle {
  /** Stop the rotation interval. */
  stop: () => void;
  /**
   * Drive ONE round synchronously (test-only — the interval uses the SAME path). Awaits the
   * round so a test can assert without a timer. The persisted accumulator is threaded internally.
   */
  runRoundForTest: () => Promise<void>;
  /**
   * REQ-RMS-022 (static-mesh-hardening D1) — returns the LATEST accumulator object (the loop
   * REPLACES it each round — immutable style, see runCanaryVerifyRound); callers MUST call per
   * read and never cache the returned reference. Read-only by contract. Feeds the validator's
   * /canary/load LoadStateProvider. Rows stay EMPTY until canary M4b supplies live captures
   * (DA-3) — the feed serving an empty relays[] is the honest, disclosed state.
   */
  getAccumulator: () => DropAccumulator;
}

/**
 * Start the additive, crash-safe canary VERIFY loop. Each tick runs `runCanaryVerifyRound`
 * against the PERSISTED per-relay accumulator (threaded across rounds so the cumulative tooth
 * accrues history) and bumps the round. Mirrors `startCanaryCellLoop`:
 *   - the first round runs immediately;
 *   - every tick is wrapped in a try so a fault NEVER escapes (a thrown round is swallowed and
 *     the loop continues — the accumulator from the last GOOD round is retained);
 *   - the caller in index.ts additionally wraps the whole start in a guard so a verify-loop
 *     fault can never abort the daemon.
 *
 * HERMETIC: all I/O (capture, submit, STUN read) is injected via `deps`. NO ports, NO mediasoup.
 */
export function startCanaryVerifyLoop(args: {
  deps: CanaryVerifyDeps;
  intervalMs: number;
  logger?: Logger;
}): CanaryVerifyLoopHandle {
  const { deps, intervalMs } = args;
  const log = args.logger ?? createLogger(MOD);
  let round = 0;
  let accumulator: DropAccumulator = newDropAccumulator();
  let inFlight: Promise<void> | null = null;

  // One round, crash-safe. Returns nothing — the accumulator is persisted in the closure.
  const runOnce = async (): Promise<void> => {
    const r = round;
    try {
      const res = await runCanaryVerifyRound(deps, accumulator, r, log);
      accumulator = res.accumulator; // PERSIST the cumulative history across rounds
      round += 1;
    } catch (err) {
      // Crash-safe: a verify-round fault must never take down the validator daemon. The last
      // good accumulator is retained; the round counter still advances so a single bad round
      // does not pin the cumulative window forever.
      round += 1;
      log.error({ err, round: r }, 'canary verify round failed (loop continues)');
    }
  };

  // Tick scheduler: never STACK rounds (a slow capture must not overlap the next tick). If a
  // round is already running, the tick is dropped. Used by the background interval.
  const tick = (): void => {
    if (inFlight) return;
    inFlight = runOnce().finally(() => {
      inFlight = null;
    });
    void inFlight;
  };

  tick(); // round 0 immediately (like the cell loop)
  const handle = setInterval(tick, intervalMs);

  // Test-only: drive a round to completion DETERMINISTICALLY. Awaits any in-flight round first
  // (so it never races the background interval's round-0 fire), then runs its OWN round so the
  // caller is guaranteed exactly-one additional completed round per call.
  const runRoundForTest = async (): Promise<void> => {
    while (inFlight) await inFlight;
    inFlight = runOnce().finally(() => {
      inFlight = null;
    });
    await inFlight;
  };

  log.info({ intervalMs }, 'canary verify loop started (hermetic half)');
  return {
    stop: () => {
      clearInterval(handle);
      log.info('canary verify loop stopped');
    },
    runRoundForTest,
    // REQ-RMS-022 (D1): latest per-relay accumulator for the /canary/load feed. The loop
    // REPLACES `accumulator` each round (immutable style) — this returns whatever is current.
    getAccumulator: () => accumulator,
  };
}

/**
 * REQ-RMS-015 — read-only export of the per-relay sustained-divergence signal the
 * MESH placement scorer consumes to EXCLUDE a Byzantine relay BEFORE selection.
 * Mirrors the classifier's PRIMARY cumulative gate WITHOUT re-implementing it:
 * a relay is "flagged" iff it has >= MIN_ROUNDS_FOR_CUMULATIVE rounds of history
 * AND its cumulative observed drop rate strictly exceeds `budgetBps`. PURE.
 * (Re-uses MIN_ROUNDS_FOR_CUMULATIVE from loss-classifier; budgetBps is the same
 * STUN-prior+delta budget the classifier gates against.)
 */
export function isRelayFlaggedByCanary(
  acc: DropAccumulator,
  relayMinerId: string,
  budgetBps: bigint,
  minRounds: number,
): boolean {
  const s = acc.byRelay.get(relayMinerId);
  if (!s || s.rounds < minRounds || s.sends === 0) return false;
  const rateBps = (BigInt(s.drops) * 10_000n) / BigInt(s.sends);
  return rateBps > budgetBps;
}
