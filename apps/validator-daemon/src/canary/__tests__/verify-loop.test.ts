/**
 * REQ-CFA-042 / REQ-CFA-043 (M4a chunk 3, D-CFA-33) — verify/publish loop HERMETIC HALF.
 *
 * Closes W-M3-STUN-PATH; NARROWS (does NOT close) W-M3-SIM; AMPLIFIES W-M3-OFFCHAIN.
 *
 * The M3 verify chain (`verifyForwardedCanary -> classifyDivergences -> buildDivergenceProof
 * -> submitCanarySlash`) had ZERO production callers — every symbol was written-now/read-later.
 * `state.relayStunLossBps` (index.ts:154/306/850) was likewise WRITTEN with ZERO readers.
 * `startCanaryVerifyLoop` wires the chain behind an INJECTABLE `CanaryForwardCapture` + submit
 * seam so it is fully HERMETIC (no live media, no mediasoup, no publisher.publish(), no
 * `apps/relay/` edit — INV-B; no ports). These tests PIN:
 *
 *   (a) REQ-CFA-042 — the STUN value `state.relayStunLossBps.get(relayMinerId) ?? 0n` FLOWS
 *       into the classifier as its `stunPacketLossBps` arg (the FIRST real reader). A budget
 *       set entirely by the STUN prior (delta=0) gates a borderline drop: a HIGH STUN value
 *       absorbs a drop the SAME-rate accumulator promotes under a ZERO STUN value. If the loop
 *       did NOT read STUN, the two runs would be identical.
 *   (b) REQ-CFA-043 — a real `PerReceiverDivergences` Map is assembled from per-receiver
 *       `verifyForwardedCanary` outputs, and a per-relay `DropAccumulator` PERSISTS across
 *       >= 2 rounds (the cumulative tooth only fires after MIN_ROUNDS_FOR_CUMULATIVE history,
 *       so a single round cannot promote — persistence is observable as a state delta).
 *   (c) REQ-CFA-042 (crash-safe) — a round whose capture seam THROWS does not kill the loop:
 *       the next round still runs and reads STUN. (Mirrors startCanaryCellLoop's per-tick try.)
 *
 * Honest scope (on record, NOT overclaimed): "verify->classify->proof loop WIRED + STUN read
 * live + per-receiver Map assembled". This is NOT "live cross-receiver corroboration proven":
 * the >=2-distinct-Wallet-B co-sign protocol (W-M4-COSIGN) is UNBUILT (= M4b). The synthetic
 * peer Ed25519 keypairs only satisfy `buildDivergenceProof`'s MIN_ATTESTERS=2 floor; they are
 * NOT a real multi-validator quorum. W-M3-SIM is NARROWED not closed.
 *
 * All fixture-driven: synthetic captured Buffers + synthetic peer keypairs + injected seams.
 * No boot, no ports, no localnet, no mediasoup. The loop is stopped synchronously after each
 * deterministic round.
 */

import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  runCanaryVerifyRound,
  startCanaryVerifyLoop,
  type CanaryForwardCapture,
  type CanaryVerifyDeps,
  type CanarySlashSubmit,
} from '../verify-loop.js';
import {
  recomputeCanaryFrame,
  deriveCanarySeed,
  type VerifyInput,
} from '../verifier.js';
import { type CanaryValidator } from '../cell.js';
import { type DivergenceProof } from '../proof.js';

// ── shared synthetic keying (no live media — all frames are recomputed locally) ──────
const KROOM = new Uint8Array(32).fill(0x07);
const CELL_SECRET = new Uint8Array(16).fill(0x5a);
const CANARY_KID = 9;
const ROOM_ID = 'verify-loop-room';
const RELAY_MINER = 'relay-under-audit';

const verifyInput = (expectedCtrs: number[]): VerifyInput => ({
  kRoom: KROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  expectedCtrs,
});

/** A minimal VP8-ish RTP packet carrying a canary SFrame body in its fixed tail. */
const wrapAsRtp = (body: Uint8Array): Buffer => {
  const header = Buffer.alloc(12); // 12-byte RTP header stand-in (verifier reads the tail only)
  return Buffer.concat([header, Buffer.from(body)]);
};

/**
 * Build a synthetic forwarded-capture for ONE receiver: forward every ctr in `ctrs` EXCEPT the
 * ones in `dropped` (a withholding profile). Returns the captured Buffers the verifier reads.
 */
async function buildCapturedFrames(ctrs: number[], dropped: Set<number>): Promise<Buffer[]> {
  const input = verifyInput(ctrs);
  const seed = deriveCanarySeed(input.cellSecret);
  const captured: Buffer[] = [];
  for (const ctr of ctrs) {
    if (dropped.has(ctr)) continue; // withheld
    captured.push(wrapAsRtp(await recomputeCanaryFrame(input, seed, ctr)));
  }
  return captured;
}

/** Two distinct synthetic peer session keypairs satisfy buildDivergenceProof's MIN_ATTESTERS=2. */
function syntheticPeerKeypairs(): Ed25519Keypair[] {
  return [new Ed25519Keypair(), new Ed25519Keypair()];
}

const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };
const PEER: CanaryValidator = { minerId: 'peer-miner', sessionWallet: 'peer-session' };

/**
 * Assemble the deps for ONE round. `stunLossBps` is what `state.relayStunLossBps.get(relay)`
 * would return; `captured` is the synthetic per-receiver forwarded frames. The submit seam
 * records every submitted proof so tests can assert on promotions WITHOUT a chain.
 */
function makeDeps(opts: {
  ctrs: number[];
  dropped: Set<number>;
  stunLossBps: bigint;
  capturePerReceiver?: () => Promise<Map<string, Buffer[]>>;
  k?: number;
  deltaBps?: bigint;
}): {
  deps: CanaryVerifyDeps;
  submitted: DivergenceProof[];
  captureCalls: { count: number };
} {
  const submitted: DivergenceProof[] = [];
  const captureCalls = { count: 0 };

  const capture: CanaryForwardCapture = async (scope) => {
    captureCalls.count += 1;
    if (opts.capturePerReceiver) {
      return {
        relayId: scope.relayId,
        roomId: scope.roomId,
        canaryKid: CANARY_KID,
        expectedCtrs: opts.ctrs,
        kRoom: KROOM,
        cellSecret: CELL_SECRET,
        perReceiver: await opts.capturePerReceiver(),
      };
    }
    // Default: SELF + PEER each saw the SAME forwarded set (drops correlate across >=k receivers).
    const frames = await buildCapturedFrames(opts.ctrs, opts.dropped);
    return {
      relayId: scope.relayId,
      roomId: scope.roomId,
      canaryKid: CANARY_KID,
      expectedCtrs: opts.ctrs,
      kRoom: KROOM,
      cellSecret: CELL_SECRET,
      perReceiver: new Map([
        [SELF.minerId, frames],
        [PEER.minerId, frames.map((f) => Buffer.from(f))],
      ]),
    };
  };

  const submit: CanarySlashSubmit = async (proof) => {
    submitted.push(proof);
  };

  const deps: CanaryVerifyDeps = {
    getRelayRoomScopes: () => [{ relayId: RELAY_MINER, roomId: ROOM_ID }],
    getValidators: () => [SELF, PEER],
    getStunLossBps: (relayId) => (relayId === RELAY_MINER ? opts.stunLossBps : 0n),
    capture,
    syntheticPeerKeypairs,
    submit,
    config: { k: opts.k ?? 2, deltaBps: opts.deltaBps ?? 0n, sendRate: opts.ctrs.length },
  };
  return { deps, submitted, captureCalls };
}

// ─────────────────────────────────────────────────────────────────────────────────
// (a) REQ-CFA-042 — the STUN value flows into the classifier (FIRST real reader).
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-042 — state.relayStunLossBps is READ as the classifier stunPacketLossBps arg', () => {
  it('a HIGH STUN prior ABSORBS a drop that a ZERO STUN prior PROMOTES (same accumulator history)', async () => {
    // A withholding profile: 8 ctrs, drop seq 5; SELF+PEER both see it (>=k=2). Seed the per-relay
    // accumulator above the MIN_ROUNDS floor so the cumulative tooth is armed. The ONLY difference
    // between the two runs is the STUN prior the loop reads — proving it is read.
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);

    // ZERO STUN, delta 0 → budget 0 → a sustained-above-zero relay drop PROMOTES.
    const lowStun = makeDeps({ ctrs, dropped, stunLossBps: 0n });
    // HIGH STUN (50% in bps) → budget 5000 bps → a ~12.5% (1/8) cumulative rate sits BELOW
    // budget → ABSORBED. (delta stays 0 so the difference is purely the STUN read.)
    const highStun = makeDeps({ ctrs, dropped, stunLossBps: 5000n });

    // Run ENOUGH rounds to pass MIN_ROUNDS_FOR_CUMULATIVE (5). Each round drops 1/8 = 1250 bps.
    let lowAcc = undefined;
    let highAcc = undefined;
    let lowPromotedTotal = 0;
    let highPromotedTotal = 0;
    for (let r = 0; r < 7; r++) {
      const lowRes = await runCanaryVerifyRound(lowStun.deps, lowAcc, r);
      const highRes = await runCanaryVerifyRound(highStun.deps, highAcc, r);
      lowAcc = lowRes.accumulator;
      highAcc = highRes.accumulator;
      lowPromotedTotal += lowRes.promoted.length;
      highPromotedTotal += highRes.promoted.length;
    }

    // The ZERO-STUN run eventually promotes the sustained drop; the HIGH-STUN run never does.
    expect(lowPromotedTotal).toBeGreaterThan(0);
    expect(highPromotedTotal).toBe(0);
    // And the low-stun run actually submitted proofs (the chain wired through to the submit seam).
    expect(lowStun.submitted.length).toBeGreaterThan(0);
    expect(highStun.submitted.length).toBe(0);
  });

  it('the submitted proof carries the audited relay + the diverged frameSeq + >=2 attesters', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);
    const { deps, submitted } = makeDeps({ ctrs, dropped, stunLossBps: 0n });
    let acc = undefined;
    for (let r = 0; r < 7; r++) {
      const res = await runCanaryVerifyRound(deps, acc, r);
      acc = res.accumulator;
    }
    expect(submitted.length).toBeGreaterThan(0);
    const proof = submitted[0]!;
    expect(proof.relayMinerId).toBe(RELAY_MINER);
    expect(proof.frameSeq).toBe(5);
    expect(proof.attestations.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (b) REQ-CFA-043 — per-receiver Map assembled + per-relay accumulator PERSISTS across rounds.
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-043 — per-receiver Map + persisted per-relay DropAccumulator across >=2 rounds', () => {
  it('the accumulator persists drop history across rounds (cumulative state grows)', async () => {
    const ctrs = [0, 1, 2, 3];
    const dropped = new Set([2]); // one drop / 4 sends per round
    const { deps } = makeDeps({ ctrs, dropped, stunLossBps: 0n });

    const round0 = await runCanaryVerifyRound(deps, undefined, 0);
    const after0 = round0.accumulator.byRelay.get(RELAY_MINER);
    expect(after0).toBeDefined();
    expect(after0!.rounds).toBe(1);
    expect(after0!.drops).toBe(1);
    expect(after0!.sends).toBe(4);

    const round1 = await runCanaryVerifyRound(deps, round0.accumulator, 1);
    const after1 = round1.accumulator.byRelay.get(RELAY_MINER);
    // PERSISTENCE: round 1 folded ON TOP of round 0 (not a fresh accumulator).
    expect(after1!.rounds).toBe(2);
    expect(after1!.drops).toBe(2);
    expect(after1!.sends).toBe(8);

    // Immutability: round 0's accumulator was NOT mutated by round 1 (crash-safe state).
    expect(round0.accumulator.byRelay.get(RELAY_MINER)!.rounds).toBe(1);
  });

  it('assembles a real PerReceiverDivergences Map (>=2 distinct receivers feed the SECONDARY signal)', async () => {
    const ctrs = [0, 1, 2, 3];
    const dropped = new Set([2]);
    const { deps } = makeDeps({ ctrs, dropped, stunLossBps: 0n });
    const res = await runCanaryVerifyRound(deps, undefined, 0);
    // Both SELF and PEER reported the same MISSING frame → the per-receiver Map carried >=2 keys.
    expect(res.perReceiverCount).toBeGreaterThanOrEqual(2);
    // The diverged frame was observed (absorbed this single round — cumulative floor not yet met).
    expect(res.absorbed.map((d) => d.frameSeq)).toContain(2);
    expect(res.promoted).toHaveLength(0); // 1 round < MIN_ROUNDS → never promoted yet
  });

  it('a SINGLE-receiver drop is NOT correlated (k=2 SECONDARY signal not met) even above budget', async () => {
    // Only SELF sees the drop; PEER forwards everything → the drop is MISSING in ONE receiver.
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const capturePerReceiver = async (): Promise<Map<string, Buffer[]>> => {
      const selfFrames = await buildCapturedFrames(ctrs, new Set([5]));
      const peerFrames = await buildCapturedFrames(ctrs, new Set()); // PEER saw all frames
      return new Map([
        [SELF.minerId, selfFrames],
        [PEER.minerId, peerFrames],
      ]);
    };
    const { deps, submitted } = makeDeps({ ctrs, dropped: new Set([5]), stunLossBps: 0n, capturePerReceiver });
    let acc = undefined;
    for (let r = 0; r < 7; r++) {
      const res = await runCanaryVerifyRound(deps, acc, r);
      acc = res.accumulator;
    }
    // Even though SELF's cumulative drop history crosses the budget, only ONE distinct receiver
    // saw each drop → SECONDARY (>=k distinct) never met → NOTHING promoted (W-M3-SIM narrowed).
    expect(submitted).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (c) REQ-CFA-042 (crash-safe) — a thrown round does not kill the loop.
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-042 — startCanaryVerifyLoop survives a thrown round (crash-safe)', () => {
  it('a capture that throws on the FIRST round does NOT stop the next round from running', async () => {
    const ctrs = [0, 1, 2, 3];
    // The FIRST capture invocation throws; every later one succeeds — independent of the loop's
    // internal round counter (the loop fires round 0 immediately, so we key off call ordinal).
    const captureOrdinals: number[] = [];
    const capture: CanaryForwardCapture = async (scope) => {
      const ordinal = captureOrdinals.length;
      captureOrdinals.push(ordinal);
      if (ordinal === 0) throw new Error('synthetic capture failure (first round)');
      const frames = await buildCapturedFrames(ctrs, new Set([2]));
      return {
        relayId: scope.relayId,
        roomId: scope.roomId,
        canaryKid: CANARY_KID,
        expectedCtrs: ctrs,
        kRoom: KROOM,
        cellSecret: CELL_SECRET,
        perReceiver: new Map([[SELF.minerId, frames]]),
      };
    };
    let stunReads = 0;
    const deps: CanaryVerifyDeps = {
      getRelayRoomScopes: () => [{ relayId: RELAY_MINER, roomId: ROOM_ID }],
      getValidators: () => [SELF, PEER],
      getStunLossBps: () => {
        stunReads += 1;
        return 0n;
      },
      capture,
      syntheticPeerKeypairs,
      submit: async () => {},
      config: { k: 2, deltaBps: 0n, sendRate: ctrs.length },
    };

    // The loop fires the first round immediately (it throws, caught). Drive one MORE round
    // explicitly — the crash-safe try must let it run despite the prior throw.
    const handle = startCanaryVerifyLoop({ deps, intervalMs: 1_000_000, logger: undefined });
    await handle.runRoundForTest(); // the immediate fire may already be settled; this is the survivor
    await handle.runRoundForTest(); // guarantee a post-throw round runs
    handle.stop();

    // The first capture threw; at least one later capture ran (the loop survived the throw).
    expect(captureOrdinals.length).toBeGreaterThanOrEqual(2);
    expect(captureOrdinals[0]).toBe(0);
    // STUN was read on a surviving round (the chain ran past the throw to the classifier).
    expect(stunReads).toBeGreaterThan(0);
  });
});
