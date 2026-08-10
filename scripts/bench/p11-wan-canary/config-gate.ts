/**
 * P11 WAN canary — env-tunable demo config + the W-M3-TAIL pre-classifier sanity gate. Split
 * out of `p11-wan-canary-loss.ts` (pure code movement — see that file's header for the full
 * demo context / honesty bounds; nothing here changes behavior).
 */

import { CANARY_SFRAME_LEN, type VerifyResult } from '../../../apps/validator-daemon/src/canary/verifier.js';

/**
 * Tuning read from env so the runbook can sweep loss without editing the script.
 * EXPORTED so the hermetic shape test (`wan-harness-shape.test.ts`) can build the SAME cfg
 * the harness feeds `buildClassifyArgs` — pinning the REAL `classifyDivergences` call shape
 * (REQ-CFA-039/040, closes W-M4-HARNESS-SHAPE).
 */
export interface DemoCfg {
  /** Injected app-level drop rate (0..100). The WAN "loss" — NOT the loopback's own. */
  lossPct: number;
  /** Cumulative-bound send rate window n (frames per window) — mirrors classifier cfg. */
  sendRate: number;
  /** Single-window budget Δ (bps) the WEAK-PRIOR floor compares against. A NUMBER at the env/
   *  call site (env is parsed as a number); coerced to the classifier's bigint in
   *  `buildClassifyArgs` (the classifier's `LossClassifierConfig.deltaBps` is a bigint). */
  deltaBps: number;
  /** ≥k distinct co-homed verifiers for the SECONDARY (SIMULATED) signal. */
  k: number;
  /** Number of synthetic cumulative rounds to drive for the sub-budget-withholding leg. */
  rounds: number;
  /**
   * The STABLE relay miner_id this batch audits — the REQUIRED key into the per-relay
   * cumulative accumulator (`classifyDivergences:256` / `cumulativeBoundCrossed:171-180`).
   * Omitting it (the old call) keyed the cumulative bound by `'undefined'`, so a SUSTAINED
   * withholding run silently passed as benign. Sourced from env (the OOB-known relay id) with
   * a stable default so the cumulative tooth keys consistently across rounds (D-CFA-21).
   */
  relayMinerId: string;
}

export function readCfg(): DemoCfg {
  return {
    lossPct: Number(process.env['P11_LOSS_PCT'] ?? '5'),
    sendRate: Number(process.env['P11_SEND_RATE'] ?? '30'),
    deltaBps: Number(process.env['P11_DELTA_BPS'] ?? '500'),
    k: Number(process.env['P11_K'] ?? '2'),
    rounds: Number(process.env['P11_ROUNDS'] ?? '12'),
    relayMinerId: process.env['P11_RELAY_MINER_ID'] ?? 'p11-relay-under-audit',
  };
}

/**
 * ── W-M3-TAIL PRE-CLASSIFIER SANITY GATE (REQ-CFA-033, the load-bearing chunk-3 part) ──
 *
 * `verifier.ts:extractCanaryBody` reads the canary SFrame body as the LAST
 * `CANARY_SFRAME_LEN` bytes of a forwarded packet. A real WAN path can RE-PACKETIZE /
 * re-fragment / pad RTP, which moves or splits that fixed tail — so the verifier would
 * find NO canary body in ANY packet and report EVERY expected ctr as `observedHash:
 * 'MISSING'`. That is an EXTRACTION BUG (the body is on the wire but at the wrong offset),
 * NOT genuine withholding — but the downstream classifier, fed an all-MISSING divergence
 * list, would read it as CATASTROPHIC withholding and (via the cumulative bound) promote a
 * slash. This gate runs BEFORE `classifyDivergences` and FAILS LOUD on that signature:
 *
 *   tail-extractable rate = (mediaPackets the verifier could parse a canary trailer from)
 *                         / (forwarded packets large enough to HOLD a canary body)
 *
 * If almost no forwarded canary-sized packet yields a parseable tail trailer, extraction
 * broke — ABORT the demo (do NOT classify, do NOT build proofs). A genuine withholding run,
 * by contrast, has a HEALTHY tail-extractable rate on the frames that WERE forwarded and
 * MISSING only on the frames that were dropped.
 */
export interface SanityGate {
  forwardedCanarySizedPackets: number;
  tailExtractable: number;
  extractRate: number;
  /** true ⇒ extraction is healthy ⇒ a MISSING means genuine withholding, classify on. */
  ok: boolean;
  reason: string;
}

export function runTailSanityGate(
  packets: Buffer[],
  vr: VerifyResult,
  expectedCtrCount: number,
): SanityGate {
  // "Canary-sized" = large enough to hold a full canary SFrame body in its tail.
  const minCanary = 12 + CANARY_SFRAME_LEN;
  const forwardedCanarySized = packets.filter((p) => p.length >= minCanary).length;
  // The verifier's own `mediaPackets` = forwarded bodies whose fixed-tail trailer parsed as
  // OUR canaryKid. If the WAN path re-packetized, that count collapses to ~0 even though
  // canary-sized packets WERE forwarded.
  const tailExtractable = vr.mediaPackets;
  const extractRate = forwardedCanarySized === 0 ? 0 : tailExtractable / forwardedCanarySized;
  // All-MISSING with NO extractable tail on canary-sized traffic = the extraction-broke
  // signature. Threshold is deliberately loose (0.5): a real lossy run still extracts the
  // tail on every frame it DID forward; only re-fragmentation collapses it toward 0.
  const allMissing =
    vr.divergences.length === expectedCtrCount &&
    vr.divergences.every((d) => d.observedHash === 'MISSING');
  const extractionBroke = forwardedCanarySized > 0 && extractRate < 0.5 && allMissing;
  return {
    forwardedCanarySizedPackets: forwardedCanarySized,
    tailExtractable,
    extractRate,
    ok: !extractionBroke,
    reason: extractionBroke
      ? `EXTRACTION BROKE: ${forwardedCanarySized} canary-sized packets forwarded but only ` +
        `${tailExtractable} yielded a parseable fixed-tail trailer (rate ${extractRate.toFixed(2)} < 0.50) ` +
        `AND all ${expectedCtrCount} ctrs MISSING — a re-packetizing/padding WAN path moved the ` +
        `fixed CANARY_SFRAME_LEN tail. This is a fragmentation bug masquerading as total ` +
        `withholding (W-M3-TAIL); do NOT classify or slash. Fix RTP framing (no re-fragment / ` +
        `MTU-safe canary frame) before re-running.`
      : `tail extraction healthy (rate ${extractRate.toFixed(2)} on ${forwardedCanarySized} ` +
        `canary-sized forwarded packets) — MISSING ctrs reflect genuine drop/withholding, classify on.`,
  };
}
