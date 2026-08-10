/**
 * P11 — WAN/real-camera CANARY-LOSS demo (REQ-CFA-032/033/034, D-CFA-27, M3 chunk 3).
 *
 * ════════════════════════════════════════════════════════════════════════════════════
 *  ⚠️ THE LIVE RUN IS DEFERRED (F2 / user gate 2026-06-20). THIS FILE IS A BUILD-NOW
 *     SCRIPT + ACCEPTANCE HARNESS — DO NOT RUN IT AS PART OF M3. It is NOT wired into CI
 *     and NOT wired into any pnpm script. See `P11-WAN-CANARY-RUNBOOK.md` for WHY the run
 *     is deferred (a concurrent session holds the localnet/mediasoup ports during M3, AND
 *     the live canary-tap path needs a relay-internal media plane the validator-daemon
 *     does not yet have — see "DEFERRED: the missing media plane" below).
 * ════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS DEMONSTRATES (when finally run at a viva / M4 milestone):
 *   The M3 loss classifier (`loss-classifier.ts` `classifyDivergences`) does NOT mistake
 *   BENIGN packet loss on a real-camera RTP path for a tampering/withholding divergence.
 *   Over a SINGLE HOP (one co-homed publisher + one co-homed consumer on the SAME relay
 *   R_k — see "SINGLE-HOP ONLY" below), it drives a REAL getUserMedia camera track,
 *   injects a controlled LOSS rate, captures the relay-forwarded canary bodies at a
 *   relay-internal tap, runs the SHIPPED `verifyForwardedCanary` to produce the per-frame
 *   `divergences[]`, then feeds those into the SHIPPED `classifyDivergences` and asserts:
 *     - benign, INDEPENDENT, within-budget loss  → ABSORBED (zero proofs built);
 *     - a TAMPER (present-but-wrong-bytes)        → ALWAYS promoted p=1, never gated;
 *     - sustained sub-budget withholding          → eventually promoted by the cumulative
 *                                                    `1-(1-f)^n` bound (PRIMARY signal).
 *   It is the LIVE/WAN counterpart to the hermetic `loss-classifier.test.ts` unit proof:
 *   the unit test proves the classifier LOGIC over synthetic divergence lists; THIS proves
 *   the same logic survives a REAL lossy RTP path end-to-end. The unit test is the gate;
 *   this is the demo that the gate's assumption (a real loss profile feeds the classifier
 *   the same shape of `divergences[]`) actually holds.
 *
 * ────────────────────────────────────────────────────────────────────────────────────
 *  HONESTY BOUNDS (DA-2/DA-3/DA-8 — carry VERBATIM into any write-up; same discipline as
 *  P10's transmission-m2 artifact):
 *  ────────────────────────────────────────────────────────────────────────────────────
 *   LABEL: **OPTIMISTIC FLOOR — loopback ICE, REAL camera, NOT WAN glass-to-glass.**
 *   - Transport is REAL WebRTC (WebRtcTransport, real ICE/DTLS) but over LOOPBACK
 *     (127.0.0.1). The "WAN" in the name is the LOSS PROFILE (a tc/netem or app-level
 *     drop injector), NOT a real wide-area path. Real WAN adds jitter, reordering, MTU
 *     re-fragmentation, and ECN that loopback does NOT — those make the W-M3-TAIL hazard
 *     (below) WORSE, not better. So a PASS here is a FLOOR, not a glass-to-glass claim.
 *   - Media is a REAL camera (getUserMedia, no `--use-fake-device-for-media-stream`) — the
 *     delta over P10 (which uses Chrome's fake device). A real VP8 stream has realistic
 *     keyframe/interframe cadence + variable frame size; the canary frames must remain
 *     size/timing/cadence-plausible against it (W-E6, on record — NOT proven here).
 *   - The classifier's CROSS-RECEIVER signal (≥k co-homed verifiers see the SAME frameSeq
 *     MISSING) is SIMULATED even here: `verifyForwardedCanary` has ZERO `index.ts` callers
 *     (the live verify loop is Task 5.2+), so a SECOND co-homed verifier's divergence list
 *     is synthesised, not captured from a second live consumer. This demo exercises the
 *     PRIMARY (cumulative) + WEAK-PRIOR (STUN budget) signals live; the SECONDARY signal
 *     stays synthetic (W-M3-SIM). Do NOT claim "cross-receiver corroboration exercised
 *     live."
 *   - Relay-blindness is STRUCTURAL (the relay forwards the opaque canary body, never
 *     reads it — INV-B); validator-blindness is ECONOMIC/OPERATIONAL (the validator holds
 *     cellSecret). NEVER a crypto "relay/validator CANNOT decrypt" claim.
 *
 *  SINGLE-HOP ONLY (W-E5, LOAD-BEARING — do NOT extend to a multi-relay path):
 *   The publisher and the consumer are BOTH co-homed on the SAME relay R_k. A multi-relay
 *   (publisher→R_a→R_b→consumer) path would make a drop attributable to EITHER relay or the
 *   inter-relay link — which degrades the isolated-slash claim to Miranda et al.'s pair/link
 *   prior art (the "which hop dropped it?" attribution gap). The whole point of the canary
 *   audit is that a co-homed verifier isolates the slash to R_k. Keep it one hop.
 *
 *  DEFERRED: the missing media plane (REQ-CFA-034 — why this can't run in M3):
 *   The validator-daemon has NO mediasoup dependency, and a real `WebRtcTransport`'s
 *   consumer does NOT emit a per-packet 'rtp' event (only a `pipe`-type DirectTransport
 *   consumer does). So a LIVE canary tap needs a relay-INTERNAL pipe-tap = net-new
 *   media-plane glue inside `apps/relay/` — which M3 must NOT touch (INV-B: ZERO
 *   `apps/relay/` non-test edits). This harness therefore OWNS its own in-process mediasoup
 *   relay + tap (exactly like P10, additive under `scripts/bench/**`, importing NO
 *   production media-path module) — but a TRUE production live run needs that relay-internal
 *   tap wired, which is the net-new media plane deferred to viva/M4.
 *
 *  CANARY_CELL_SECRET FAIL-SAFE-OFF (runbook precondition):
 *   The canary cell loop refuses to start without `CANARY_CELL_SECRET` (index.ts:347-353 —
 *   it throws "CANARY_CELL_SECRET unset/empty … loop not started" and runs NO unsalted,
 *   relay-recomputable assignment). Any LIVE run of this demo MUST export a hex
 *   `CANARY_CELL_SECRET` (the same out-of-band Wallet-B-distributed secret the publisher +
 *   verifier share), or there are NO canary frames to lose and the demo is vacuous.
 *
 * ADDITIVE / TEST-ONLY: lives under `scripts/bench/p11-wan-canary/**`. Imports the SHIPPED
 * verifier + classifier (read-only) and stands up its OWN in-process relay+tap. Imports NO
 * production media-path module; never edits `apps/relay/**`; NEVER logs key material
 * (cellSecret / assignmentSecret / K_canary / keys).
 *
 * Run (DEFERRED — only at a viva/M4, after the port lock clears + a real camera is present):
 *   CANARY_CELL_SECRET=<hex> P11_LOSS_PCT=5 \
 *     pnpm exec tsx scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts
 *   …--write-artifact  → GREEN-ONLY dated artifact (relay-overlap N1: green-only at the
 *                        generator; a FAIL writes nothing).
 *
 * NOTE (pure code-movement split): the demo body now lives across sibling modules in this
 * same directory — `config-gate.ts` (env cfg + the W-M3-TAIL sanity gate), `relay-standup.ts`
 * (the in-process mediasoup relay + lossy tap), `drive-room.ts` (drive the browser page +
 * build the classifier call args), `artifact.ts` (verdict shape + the dated artifact writer).
 * This file is now the THIN CLI entry point: it wires those pieces together in `main()` and
 * re-exports the symbols (`DemoCfg`, `SanityGate`, `runTailSanityGate`, `buildClassifyArgs`)
 * that `wan-harness-shape.test.ts` imports directly from this path. No logic changed.
 */

import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import {
  verifyForwardedCanary,
  type VerifyInput,
} from '../../../apps/validator-daemon/src/canary/verifier.js';
import { readCfg, runTailSanityGate } from './config-gate.js';
import { bundleEntry, standUpRelay, log, type CaptureRoom } from './relay-standup.js';
import { driveRoom, buildPerReceiverMap, buildClassifyArgs } from './drive-room.js';
import { writeArtifact, type DemoVerdict } from './artifact.js';

// Re-exported for backward compat: `wan-harness-shape.test.ts` imports these directly from
// this entry-point path (pure code movement — the symbols now live in the sibling modules).
export { readCfg, runTailSanityGate } from './config-gate.js';
export type { DemoCfg, SanityGate } from './config-gate.js';
export { buildClassifyArgs, buildPerReceiverMap } from './drive-room.js';

/**
 * The live demo body. DEFERRED — guarded so an accidental run is loud, not silent. The
 * classifier import is intentionally LATE-bound (dynamic) so this script can be type-checked
 * and read while `loss-classifier.ts` is being built in parallel (chunk 2); a real run
 * resolves it at runtime.
 */
async function main(): Promise<void> {
  // Hard guard: this demo is DEFERRED. It refuses to run unless explicitly acknowledged,
  // so it can never collide with the concurrent session holding the ports.
  if (process.env['P11_I_ACKNOWLEDGE_DEFERRED_RUN'] !== 'yes') {
    log('REFUSING TO RUN — P11 is the DEFERRED WAN/real-camera demo (REQ-CFA-034).');
    log('The live run is deferred to a viva/M4 milestone (port lock + net-new media plane).');
    log('To run it THEN, set P11_I_ACKNOWLEDGE_DEFERRED_RUN=yes and CANARY_CELL_SECRET=<hex>.');
    log('See scripts/bench/p11-wan-canary/P11-WAN-CANARY-RUNBOOK.md.');
    process.exit(2);
  }
  if (!process.env['CANARY_CELL_SECRET']) {
    log('FATAL — CANARY_CELL_SECRET unset: the canary loop fails safe-off (index.ts:347-353); nothing to lose.');
    process.exit(2);
  }

  const cfg = readCfg();
  const writeArt = process.argv.includes('--write-artifact');
  log(`cfg: ${JSON.stringify(cfg)}`);

  // Late dynamic import so build-time readability does not depend on chunk-2's loss-classifier.
  const { classifyDivergences } = (await import(
    '../../../apps/validator-daemon/src/canary/loss-classifier.js'
  )) as typeof import('../../../apps/validator-daemon/src/canary/loss-classifier.js');

  const bundleJs = await bundleEntry();
  const room: CaptureRoom = { producerId: null, packets: [], producer: null, injectedDrops: 0 };
  const relay = await standUpRelay(bundleJs, room, cfg);

  log('launching headless Chromium with a REAL camera (no fake-device flag)…');
  const browser = await chromium.launch({
    headless: true,
    // NOTE: NO --use-fake-device-for-media-stream — a REAL camera is required (the P10→P11
    // delta). --use-fake-ui-for-media-stream auto-accepts the camera permission prompt.
    args: ['--use-fake-ui-for-media-stream'],
  });
  const browserVersion = `Chromium ${browser.version()}`;
  log(browserVersion);

  log('═══ driving SINGLE-HOP real-camera canary room (lossy tap) ═══');
  const runResult = await driveRoom(browser, relay.pageUrl, relay.wsUrl, 'p11-wan-canary');
  log(`page run: ${JSON.stringify(runResult)}`);

  // Verify the forwarded canary bodies with the SHIPPED verifier. The expectedCtrs + keying
  // come from the page run (the publisher's canary stream is deterministic from cellSecret).
  const verifyInput: VerifyInput = {
    kRoom: Buffer.from(String(runResult['kRoomHex'] ?? ''), 'hex'),
    roomId: String(runResult['roomId'] ?? 'p11-wan-canary'),
    cellSecret: Buffer.from(process.env['CANARY_CELL_SECRET']!, 'hex'),
    canaryKid: Number(runResult['canaryKid'] ?? 0),
    expectedCtrs: (runResult['expectedCtrs'] as number[] | undefined) ?? [],
  };
  const vr = await verifyForwardedCanary(room.packets, verifyInput);

  await browser.close();
  relay.close();

  // ── THE W-M3-TAIL SANITY GATE — before any classification ──
  const sanity = runTailSanityGate(room.packets, vr, verifyInput.expectedCtrs.length);
  log(`sanity gate: ${sanity.reason}`);

  const reasons: string[] = [];
  if (!sanity.ok) {
    reasons.push(sanity.reason);
    const verdict: DemoVerdict = {
      pass: false,
      reasons,
      sanity,
      cfg,
      vr,
      injectedDrops: room.injectedDrops,
      forwarded: room.packets.length,
    };
    log('DEMO ABORT — extraction broke (W-M3-TAIL); NOT classifying (no artifact written).');
    for (const r of reasons) log(`  - ${r}`);
    // emit nothing on a sanity abort either (green-only).
    void verdict;
    process.exit(1);
  }

  // ── Classify (the W-E2 crux): benign loss must be ABSORBED, tamper/withholding PROMOTED ──
  // The STUN budget is a weak prior; here we feed the measured live loss as the prior.
  const liveLossBps = BigInt(Math.round((room.injectedDrops / Math.max(1, room.injectedDrops + room.packets.length)) * 10_000));
  const perReceiver = buildPerReceiverMap(vr.divergences, cfg, /*correlated*/ false);
  // REAL-shape args (REQ-CFA-039/040): a `byRelay` accumulator, the REQUIRED relayMinerId, and
  // a bigint deltaBps — the `as unknown as` cast is GONE, so `tsc` enforces the shape.
  const { stunPacketLossBps, roundAccumulator, classifierCfg } = buildClassifyArgs(liveLossBps, cfg);
  const { promoted, absorbed } = classifyDivergences(
    perReceiver,
    stunPacketLossBps,
    roundAccumulator,
    classifierCfg,
  );

  // Acceptance: a BENIGN, independent, within-budget loss window promotes ZERO DROP proofs.
  const benignDropsAbsorbed = promoted.every((d) => d.observedHash !== 'MISSING');
  if (!benignDropsAbsorbed) {
    reasons.push(
      `FALSE POSITIVE: benign independent loss @ ${cfg.lossPct}% promoted ${promoted.filter((d) => d.observedHash === 'MISSING').length} DROP(s) — the classifier mistook WAN loss for withholding.`,
    );
  } else {
    reasons.push(
      `PASS — benign independent loss @ ${cfg.lossPct}% ABSORBED (${absorbed.length} absorbed, 0 DROP promoted); tail extraction healthy; classifier did NOT mistake WAN loss for withholding. OPTIMISTIC FLOOR (loopback, real camera). Cross-receiver SIMULATED (W-M3-SIM).`,
    );
  }

  const pass = sanity.ok && benignDropsAbsorbed;
  const verdict: DemoVerdict = {
    pass,
    reasons,
    sanity,
    cfg,
    vr,
    injectedDrops: room.injectedDrops,
    forwarded: room.packets.length,
  };

  if (pass) {
    log('DEMO PASS — benign WAN loss absorbed, tamper/withholding teeth intact (FLOOR).');
    if (writeArt) {
      const f = writeArtifact(verdict, browserVersion);
      log(`wrote PROVISIONAL dated artifact: ${f}`);
    } else {
      log('(re-run with --write-artifact to emit the dated .evidence artifact GREEN-ONLY)');
    }
    process.exit(0);
  } else {
    log('DEMO FAIL — see reasons (NO artifact written; green-only generator):');
    for (const r of reasons) log(`  - ${r}`);
    process.exit(1);
  }
}

/**
 * Run `main()` ONLY when this file is the process entry point (`tsx … p11-wan-canary-loss.ts`),
 * NOT when it is IMPORTED (the hermetic shape test imports `runTailSanityGate` /
 * `buildClassifyArgs` for REQ-CFA-039..041 and must NOT trip `main()`'s deferred-run guard /
 * bind ports / boot mediasoup). The DEFERRED-RUN guard inside `main()` is UNCHANGED — a real
 * `tsx` invocation still hits it and refuses without `P11_I_ACKNOWLEDGE_DEFERRED_RUN=yes`.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error('[p11-wan-canary] FATAL', err);
    process.exit(1);
  });
}
