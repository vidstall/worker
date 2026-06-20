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
 *   - The `MIN_ATTESTERS=2` floor (proof.ts:165-168) is satisfied with SYNTHETIC peer Ed25519
 *     keypairs from the injected `syntheticPeerKeypairs` seam. The REAL >=2-distinct-Wallet-B
 *     co-sign collection protocol (W-M4-COSIGN) is UNBUILT (= M4b, the TRUE root of W-M3-SIM).
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
import { OBSERVED_HASH_MISSING, buildDivergenceProof, type DivergenceProof } from './proof.js';
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
   * Mint >= MIN_ATTESTERS synthetic peer session keypairs to satisfy buildDivergenceProof's
   * floor. The REAL multi-validator co-sign protocol (W-M4-COSIGN) is UNBUILT (= M4b).
   */
  syntheticPeerKeypairs: () => Ed25519Keypair[];
  /** Submit a built proof (injectable; the live PTB submit is M4b). */
  submit: CanarySlashSubmit;
  /** Gate tuning. */
  config: CanaryVerifyConfig;
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

    // (5) for each promoted frameSeq build a proof (SYNTHETIC peers for the MIN_ATTESTERS=2
    // floor — W-M4-COSIGN unbuilt) and submit via the injected seam (live PTB = M4b).
    for (const d of result.promoted) {
      const sessionKeypairs = deps.syntheticPeerKeypairs();
      const proof = await buildDivergenceProof({
        roomId: scope.roomId,
        relayMinerId: scope.relayId,
        canaryId: cap.canaryKid,
        frameSeq: d.frameSeq,
        expectedHash: d.expectedHash,
        observedHash: d.observedHash,
        sessionKeypairs,
      });
      await deps.submit(proof);
      promoted.push(d);
    }
    absorbed.push(...result.absorbed);

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
  };
}
