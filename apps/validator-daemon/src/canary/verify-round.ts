/**
 * Canary verify/publish loop -- single-round core (REQ-CFA-042/043, M4a chunk 3, D-CFA-33).
 *
 * `runCanaryVerifyRound` is the PURE deterministic core wired by
 * `verify-loop.ts`'s `startCanaryVerifyLoop`: it captures the forwarded canary
 * frames per `(relay,room)` scope, verifies + classifies them, folds the drop
 * tally into the persisted per-relay accumulator, and drives the W-M4-COSIGN
 * pull-corroboration claim-board publish/corroborate/assemble+submit pipeline.
 *
 * Extracted from the former `verify-loop.ts` monolith. `runCanaryVerifyRound` is
 * re-exported from `verify-loop.ts` so external import sites are unchanged.
 *
 * LOGGING (HARD-GATE): holds NO key material. cellSecret/kRoom flow THROUGH the capture seam
 * into the verifier but are NEVER logged here (only non-secret counts: relayMinerId, promoted,
 * absorbed, perReceiver). INV-C: every id logged is a public miner_id / room id.
 */

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
  type DivergenceClaim,
  type DivergenceAttestation,
} from './proof.js';
import { attestIfIndependentlyObserved, type ClaimBoard } from './claim-board.js';
import type { CanaryVerifyDeps, CanaryVerifyRoundResult } from './verify-loop.js';

const MOD = 'canary/verify-loop';

/**
 * C1 cross-post fan-out (PLAN-m4b-hermetic §3.2). Post `attestation` for `claim` to the validator's
 * OWN `localBoard` AND every co-observer board, FAIL-OPEN per board: a single failing co-observer
 * board is logged and skipped, NEVER aborting the round. The redundancy across boards — not any one
 * board — is the censorship-resistance safety net, so a fail-CLOSED here would re-introduce the very
 * censorship lever C1 removes. The `localBoard` post is also wrapped so a transient local failure
 * cannot deny a peer's accrual on the other boards.
 */
export async function fanOutPost(
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
