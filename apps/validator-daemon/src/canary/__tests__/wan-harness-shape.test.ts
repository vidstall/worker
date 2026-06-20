/**
 * REQ-CFA-039/040/041 (M4a chunk 2, D-CFA-32) — WAN-harness config-shape FIX tests.
 *
 * Closes W-M4-HARNESS-SHAPE: the P11 WAN/real-camera demo
 * (`scripts/bench/p11-wan-canary/p11-wan-canary-loss.ts`) called the SHIPPED
 * `classifyDivergences` with THREE defects, ALL masked from `tsc` by an
 * `as unknown as Parameters<typeof classifyDivergences>[2]` cast:
 *   (1) the accumulator was `{ perRelay: new Map() }` — the real `DropAccumulator`
 *       field is `byRelay` (loss-classifier.ts:111/131), so a live run keyed NOTHING;
 *   (2) the cfg OMITTED the REQUIRED `relayMinerId` (read at classifyDivergences:256 /
 *       cumulativeBoundCrossed:171-180) → the cumulative bound keyed by `'undefined'`,
 *       so a SUSTAINED withholding run silently PASSES as benign (the gate never fires);
 *   (3) `deltaBps` was passed as `number` (call-site cfg.deltaBps is number) while the
 *       classifier wants `bigint` (LossClassifierConfig.deltaBps:75) → a runtime
 *       `Cannot mix BigInt and other types` throw at `stunPacketLossBps + cfg.deltaBps`.
 *
 * THESE TESTS PIN (all HERMETIC — no ports, no mediasoup, no localnet; the harness RUN
 * stays DEFERRED behind P11_I_ACKNOWLEDGE_DEFERRED_RUN, which these tests NEVER set):
 *   (a) IMPORT-SHAPE SMOKE — import the REAL `classifyDivergences` + `newDropAccumulator`
 *       and the harness's `buildClassifyArgs` helper, and assert the helper builds the
 *       EXACT shape the real signature requires (a `byRelay` accumulator, a supplied
 *       `relayMinerId`, a `bigint` deltaBps), then call the real `classifyDivergences`
 *       with those args. A future drift back to the cast-hidden shape breaks RED.
 *   (b) PURE SYNTHETIC lossy / re-packetized-Buffer test driving the SHIPPED chain
 *       `verifyForwardedCanary` (extractCanaryBody read) -> `runTailSanityGate`
 *       (ABORT iff rate<0.50 AND all-MISSING) -> `classifyDivergences`: benign-absorbed /
 *       W-M3-TAIL-ABORT / sustained-sub-budget-promoted.
 *
 * SCOPE: FIX-ONLY. The harness `main()` (which binds ports + a mediasoup worker) is NEVER
 * executed — importing the harness module does NOT auto-run it (the entry-point guard).
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  classifyDivergences,
  newDropAccumulator,
  accumulateRound,
  type DropAccumulator,
  type PerReceiverDivergences,
} from '../loss-classifier.js';
import { OBSERVED_HASH_MISSING } from '../proof.js';
import {
  verifyForwardedCanary,
  recomputeCanaryFrame,
  deriveCanarySeed,
  CANARY_SFRAME_LEN,
  type VerifyInput,
} from '../verifier.js';
// The harness is read-only SHIPPED bench code. Importing it MUST NOT execute main()
// (no port bind / no mediasoup). The entry-point guard keeps main() inert on import.
import {
  runTailSanityGate,
  buildClassifyArgs,
  type DemoCfg,
} from '../../../../../scripts/bench/p11-wan-canary/p11-wan-canary-loss.js';

// ── shared fixtures ───────────────────────────────────────────────────────────────

const RELAY_MINER = 'p11-relay-under-audit';

const demoCfg = (over: Partial<DemoCfg> = {}): DemoCfg => ({
  lossPct: 5,
  sendRate: 30,
  deltaBps: 500, // NOTE: number at the call site — buildClassifyArgs must coerce to bigint
  k: 2,
  rounds: 12,
  relayMinerId: RELAY_MINER,
  ...over,
});

// Build a real canary VerifyInput over synthetic keying. cellSecret single-roots the seed.
const KROOM = new Uint8Array(32).fill(0x07);
const CELL_SECRET = new Uint8Array(16).fill(0x5a);
const CANARY_KID = 3;
const ROOM_ID = 'p11-shape-test';

const verifyInput = (expectedCtrs: number[]): VerifyInput => ({
  kRoom: KROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  expectedCtrs,
});

/** A minimal VP8-ish RTP packet carrying a canary SFrame body in its fixed tail. */
const wrapAsRtp = (body: Uint8Array): Buffer => {
  const header = Buffer.alloc(12); // a 12-byte RTP header stand-in (verifier reads the tail only)
  return Buffer.concat([header, Buffer.from(body)]);
};

// ─────────────────────────────────────────────────────────────────────────────────
// (a) IMPORT-SHAPE SMOKE — defeats the `as unknown as` cast.
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-039/040 — P11 classify-call shape matches the REAL classifyDivergences signature', () => {
  it('buildClassifyArgs produces a byRelay accumulator (NOT perRelay), a relayMinerId, and a bigint deltaBps', () => {
    const { stunPacketLossBps, roundAccumulator, classifierCfg } = buildClassifyArgs(123n, demoCfg());

    // (1) the accumulator is a real DropAccumulator with the `byRelay` field — NOT `perRelay`.
    expect(roundAccumulator).toHaveProperty('byRelay');
    expect(roundAccumulator.byRelay).toBeInstanceOf(Map);
    expect(roundAccumulator as unknown as { perRelay?: unknown }).not.toHaveProperty('perRelay');

    // (2) the REQUIRED relayMinerId is supplied (cumulativeBoundCrossed keys by it).
    expect(classifierCfg.relayMinerId).toBe(RELAY_MINER);
    expect(typeof classifierCfg.relayMinerId).toBe('string');
    expect(classifierCfg.relayMinerId.length).toBeGreaterThan(0);

    // (3) deltaBps is a bigint (the call-site DemoCfg.deltaBps is a number — coerced here).
    expect(typeof classifierCfg.deltaBps).toBe('bigint');
    expect(classifierCfg.deltaBps).toBe(500n);

    // stun prior flows through unchanged as a bigint.
    expect(typeof stunPacketLossBps).toBe('bigint');
    expect(stunPacketLossBps).toBe(123n);
  });

  it('the real classifyDivergences accepts the harness-built args without a cast and without a BigInt throw', () => {
    const { stunPacketLossBps, roundAccumulator, classifierCfg } = buildClassifyArgs(0n, demoCfg());
    const perReceiver: PerReceiverDivergences = new Map([
      ['v1', [{ frameSeq: 4, expectedHash: 'a'.repeat(64), observedHash: OBSERVED_HASH_MISSING }]],
    ]);
    // A fresh accumulator → a single benign window must NOT promote (and must NOT throw the
    // `Cannot mix BigInt` error the old `deltaBps:number` shape produced at stun+delta).
    const result = classifyDivergences(perReceiver, stunPacketLossBps, roundAccumulator, classifierCfg);
    expect(result.promoted).toHaveLength(0);
    expect(result.absorbed.map((d) => d.frameSeq)).toEqual([4]);
  });

  it('buildClassifyArgs returns the SAME bigint-keyed shape the loss-classifier accumulator API mints', () => {
    // Drift guard: the harness accumulator must be interchangeable with newDropAccumulator().
    const harnessAcc: DropAccumulator = buildClassifyArgs(0n, demoCfg()).roundAccumulator;
    const apiAcc = newDropAccumulator();
    expect(Object.keys(harnessAcc)).toEqual(Object.keys(apiAcc));
    // accumulateRound folds into the harness accumulator just like the API one.
    const folded = accumulateRound(harnessAcc, RELAY_MINER, { observedDrops: 1, expectedSends: 100 });
    expect(folded.byRelay.get(RELAY_MINER)).toEqual({ drops: 1, sends: 100, rounds: 1 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (b) PURE SYNTHETIC verifier -> runTailSanityGate -> classifier chain.
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-041 — synthetic lossy/re-packetized chain: verifier -> runTailSanityGate -> classifier', () => {
  it('BENIGN absorbed: forwarded-intact canary frames pass the sanity gate and promote ZERO', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5];
    const input = verifyInput(ctrs);
    const seed = deriveCanarySeed(input.cellSecret);
    // Forward EVERY canary frame intact (a lossless honest forward).
    const captured: Buffer[] = [];
    for (const ctr of ctrs) {
      const frame = await recomputeCanaryFrame(input, seed, ctr);
      captured.push(wrapAsRtp(frame));
    }
    const vr = await verifyForwardedCanary(captured, input);
    expect(vr.divergences).toHaveLength(0); // all intact

    const gate = runTailSanityGate(captured, vr, ctrs.length);
    expect(gate.ok).toBe(true); // extraction healthy → classify on

    // No divergences → nothing to classify; benign, ZERO promoted.
    const perReceiver: PerReceiverDivergences = new Map([['v1', vr.divergences]]);
    const { roundAccumulator, classifierCfg, stunPacketLossBps } = buildClassifyArgs(0n, demoCfg());
    const res = classifyDivergences(perReceiver, stunPacketLossBps, roundAccumulator, classifierCfg);
    expect(res.promoted).toHaveLength(0);
  });

  it('W-M3-TAIL-ABORT: a re-packetized path (canary tail moved) → all-MISSING with broken extraction → gate ABORTS', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5];
    const input = verifyInput(ctrs);
    const seed = deriveCanarySeed(input.cellSecret);
    // RE-PACKETIZE: forward canary-SIZED packets, but with the fixed CANARY_SFRAME_LEN tail
    // SHIFTED (a trailing pad byte) so the verifier extracts NO parseable trailer — the
    // fragmentation-bug-masquerading-as-withholding signature the gate must catch.
    const captured: Buffer[] = [];
    for (const ctr of ctrs) {
      const frame = await recomputeCanaryFrame(input, seed, ctr);
      // append a pad byte → the fixed-length tail no longer holds the trailer at the end.
      const repacketized = Buffer.concat([wrapAsRtp(frame), Buffer.from([0xff])]);
      captured.push(repacketized);
    }
    const vr = await verifyForwardedCanary(captured, input);
    // All expected ctrs read as MISSING (the trailer moved off the fixed tail).
    expect(vr.divergences).toHaveLength(ctrs.length);
    expect(vr.divergences.every((d) => d.observedHash === OBSERVED_HASH_MISSING)).toBe(true);
    expect(vr.mediaPackets).toBe(0); // no parseable tail trailer on any canary-sized packet

    const gate = runTailSanityGate(captured, vr, ctrs.length);
    expect(gate.ok).toBe(false); // ABORT — extraction broke (W-M3-TAIL); do NOT classify/slash
    expect(gate.extractRate).toBeLessThan(0.5);
    expect(gate.forwardedCanarySizedPackets).toBeGreaterThan(0);
    expect(gate.reason).toMatch(/EXTRACTION BROKE/);
  });

  it('SUSTAINED-SUB-BUDGET-PROMOTED: a real DROP gap, gate healthy, cumulative crossed + >=k → promoted', async () => {
    // A genuine withholding profile: forward most frames intact (tail extraction stays healthy)
    // but DROP one targeted frameSeq. The gate must NOT abort (healthy extraction), and a
    // cumulatively-above-budget relay seen by >=k receivers must promote that one drop.
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const droppedSeq = 5;
    const input = verifyInput(ctrs);
    const seed = deriveCanarySeed(input.cellSecret);
    const captured: Buffer[] = [];
    for (const ctr of ctrs) {
      if (ctr === droppedSeq) continue; // withheld
      const frame = await recomputeCanaryFrame(input, seed, ctr);
      captured.push(wrapAsRtp(frame));
    }
    const vr = await verifyForwardedCanary(captured, input);
    // exactly the one withheld frame is MISSING.
    expect(vr.divergences.map((d) => d.frameSeq)).toEqual([droppedSeq]);
    expect(vr.divergences[0]?.observedHash).toBe(OBSERVED_HASH_MISSING);

    const gate = runTailSanityGate(captured, vr, ctrs.length);
    expect(gate.ok).toBe(true); // healthy extraction on the forwarded frames → classify on
    expect(gate.extractRate).toBeGreaterThanOrEqual(0.5);

    // Build a cumulatively-above-budget accumulator (sustained over the MIN_ROUNDS floor), then
    // classify the live drop seen by >=k DISTINCT receivers (the SECONDARY signal, simulated).
    const { classifierCfg, stunPacketLossBps } = buildClassifyArgs(0n, demoCfg());
    let acc: DropAccumulator = newDropAccumulator();
    for (let r = 0; r < 12; r++) {
      acc = accumulateRound(acc, RELAY_MINER, { observedDrops: 40, expectedSends: 100 }); // 40% >> budget
    }
    const perReceiver: PerReceiverDivergences = new Map([
      ['v1', vr.divergences],
      ['v2', vr.divergences.map((d) => ({ ...d }))], // a second distinct co-homed receiver → k=2 met
    ]);
    const res = classifyDivergences(perReceiver, stunPacketLossBps, acc, classifierCfg);
    expect(res.promoted.map((d) => d.frameSeq)).toEqual([droppedSeq]); // promoted exactly once
    expect(res.absorbed).toHaveLength(0);
  });

  it('sanity gate is keyed off CANARY_SFRAME_LEN-sized packets (a too-short packet is not counted)', async () => {
    // Defensive shape pin: packets too short to hold a canary body are excluded from the
    // canary-sized denominator (extractCanaryBody returns null below 12 + CANARY_SFRAME_LEN).
    const tiny = Buffer.alloc(12 + CANARY_SFRAME_LEN - 1, 0); // one byte short of canary-sized
    const vr = await verifyForwardedCanary([tiny], verifyInput([]));
    const gate = runTailSanityGate([tiny], vr, 0);
    expect(gate.forwardedCanarySizedPackets).toBe(0);
    expect(gate.ok).toBe(true); // nothing canary-sized forwarded → no extraction-broke signature
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// importing the harness must NOT bind ports / boot mediasoup (main() stays inert).
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-040 — importing the harness does NOT execute main() (RUN stays deferred)', () => {
  it('the deferred-run guard env is NOT set in this hermetic test process', () => {
    // If main() had auto-run on import it would have hit the guard and process.exit(2)'d,
    // killing this suite. Reaching this assertion proves main() stayed inert on import.
    expect(process.env['P11_I_ACKNOWLEDGE_DEFERRED_RUN']).not.toBe('yes');
    // touch a random byte so the import-side has no hidden global side effect we depend on.
    expect(randomBytes(1).length).toBe(1);
  });
});
