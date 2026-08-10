/**
 * P11 WAN canary — drive the browser page through the room + build the classifier call args.
 * Split out of `p11-wan-canary-loss.ts` (pure code movement — see that file's header for the
 * full demo context / honesty bounds; nothing here changes behavior).
 */

import type { Browser } from 'playwright';
import {
  type CanaryDivergence,
} from '../../../apps/validator-daemon/src/canary/verifier.js';
import {
  newDropAccumulator,
  type DropAccumulator,
  type LossClassifierConfig,
} from '../../../apps/validator-daemon/src/canary/loss-classifier.js';
import { sleep, log } from './relay-standup.js';
import type { DemoCfg } from './config-gate.js';

export async function driveRoom(
  browser: Browser,
  pageUrl: string,
  wsUrl: string,
  roomId: string,
): Promise<Record<string, unknown>> {
  const page = await browser.newPage();
  page.on('console', (m) => log(`PAGE> ${m.text()}`));
  page.on('pageerror', (e) => log(`PAGE-ERROR> ${String(e)}`));
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.evaluate(
    ({ relayUrl, rid }) => {
      (window as unknown as { __p11Opts: unknown }).__p11Opts = { relayUrl, roomId: rid };
    },
    { relayUrl: wsUrl, rid: roomId },
  );
  const result = (await page.evaluate(async () =>
    (window as unknown as { __p11Run: () => Promise<Record<string, unknown>> }).__p11Run(),
  )) as Record<string, unknown>;
  await sleep(2000); // drain in-flight RTP through the lossy tap.
  await page.close();
  return result;
}

/**
 * Synthesise a SECOND co-homed verifier's divergence list (W-M3-SIM: the live verify loop
 * is Task 5.2+, so there is no second LIVE consumer). For the benign-independent leg the
 * second verifier sees DIFFERENT random drops (independent loss → low cross-receiver
 * agreement); for the targeted leg it sees the SAME frameSeqs MISSING (high agreement). This
 * is the SIMULATED secondary signal — NOT live corroboration. Returns a per-receiver map the
 * classifier consumes; the FIRST receiver is the LIVE captured list.
 */
export function buildPerReceiverMap(
  liveDivergences: CanaryDivergence[],
  cfg: DemoCfg,
  correlated: boolean,
): Map<string, CanaryDivergence[]> {
  const m = new Map<string, CanaryDivergence[]>();
  m.set('verifier-live-A', liveDivergences);
  // The synthetic co-homed verifiers (B..k). Correlated ⇒ identical MISSING set (targeted
  // withholding all receivers see); independent ⇒ a different random subset (benign loss).
  const liveMissing = liveDivergences.filter((d) => d.observedHash === 'MISSING');
  for (let i = 1; i < cfg.k; i++) {
    const id = `verifier-sim-${String.fromCharCode(66 + i - 1)}`;
    if (correlated) {
      m.set(id, liveMissing.map((d) => ({ ...d })));
    } else {
      // independent: each synthetic receiver re-rolls which of its OWN frames it lost.
      const indep = liveMissing.filter(() => Math.random() * 100 < cfg.lossPct);
      m.set(id, indep);
    }
  }
  return m;
}

/**
 * Build the args for the SHIPPED `classifyDivergences` from the harness cfg + the measured
 * live loss prior, in the EXACT shape the real signature requires (REQ-CFA-039/040, closes
 * W-M4-HARNESS-SHAPE). PURE — no I/O, no ports — so the hermetic shape test can call it.
 *
 * Three defects this REPLACES (all were masked by an `as unknown as Parameters<...>[2]` cast):
 *   (1) the accumulator field is `byRelay` (a fresh `newDropAccumulator()`), NOT `perRelay`;
 *   (2) `cfg.relayMinerId` is REQUIRED (the cumulative bound keys by it — omitting it keyed
 *       `'undefined'`, so a sustained withholder silently passed as benign);
 *   (3) `deltaBps` is coerced to a `bigint` (the classifier sums `stunPacketLossBps + deltaBps`;
 *       a `number` deltaBps throws `Cannot mix BigInt and other types` at runtime).
 *
 * A FRESH accumulator is returned every call (a single benign window must NOT promote); a
 * sustained-withholding run folds rounds into THIS accumulator via `accumulateRound` across
 * windows before classifying (the cumulative tooth). The cast is GONE — `tsc` now enforces the
 * real shape, so a future drift fails the typecheck AND the import-shape smoke.
 */
export function buildClassifyArgs(
  liveLossBps: bigint,
  cfg: DemoCfg,
): {
  stunPacketLossBps: bigint;
  roundAccumulator: DropAccumulator;
  classifierCfg: LossClassifierConfig;
} {
  return {
    stunPacketLossBps: liveLossBps,
    // (1) the REAL DropAccumulator (`byRelay` field), not the bogus `{ perRelay: new Map() }`.
    roundAccumulator: newDropAccumulator(),
    classifierCfg: {
      // (2) the REQUIRED relayMinerId the cumulative bound keys by.
      relayMinerId: cfg.relayMinerId,
      k: cfg.k,
      // (3) bigint deltaBps (the env/cfg value is a number — coerced here).
      deltaBps: BigInt(cfg.deltaBps),
      sendRate: cfg.sendRate,
    },
  };
}
