/**
 * REQ-CFA-042/043 (M4a chunk 3) + REQ-CFA-052 (W-M4-COSIGN seam swap, D-CFA-42) — the verify/publish
 * loop HERMETIC HALF, now driving the PULL-CORROBORATION claim board instead of synthetic peer keypairs.
 *
 * Closes W-M3-STUN-PATH; NARROWS (does NOT close) W-M3-SIM; AMPLIFIES W-M3-OFFCHAIN.
 *
 * SEAM SWAP (D-CFA-42): `CanaryVerifyDeps` dropped `syntheticPeerKeypairs` and gained
 * `localBoard: ClaimBoard` + `selfSessionKeypair` (the field was renamed `claimBoard -> localBoard`
 * by C1, PLAN-m4b-hermetic.md Leg 1). The promote block is now
 *   publish-own (signSelfAttestation -> localBoard.post)
 *     -> poll-corroborate (attestIfIndependentlyObserved on open cells)
 *       -> assemble+submit ONLY when a cell holds >=2 DISTINCT sessionPublicKeys.
 * A >=2-distinct quorum is modelled HERMETICALLY by running TWO in-process validator loops (distinct
 * selfSessionKeypairs) over a SHARED in-memory board — each publishes its OWN independent observation,
 * exactly as two real daemons would. A self-only run FAILS CLOSED (1 distinct -> no proof, no submit).
 *
 * These tests PIN:
 *   (a) REQ-CFA-042 — the STUN value `state.relayStunLossBps.get(relay) ?? 0n` FLOWS into the
 *       classifier (a HIGH prior ABSORBS a drop a ZERO prior PROMOTES) — the FIRST real reader.
 *   (b) REQ-CFA-043 — a real `PerReceiverDivergences` Map + a per-relay `DropAccumulator` PERSIST
 *       across rounds.
 *   (c) REQ-CFA-052 — a >=2-distinct quorum on the shared board submits; a self-only loop does NOT
 *       (fail-closed); a single-receiver drop never even promotes (W-M3-SIM narrowed).
 *   (d) REQ-CFA-042 (crash-safe) — a round whose capture THROWS does not kill the loop.
 *
 * Honest scope (on record, NOT overclaimed): "loop WIRED + STUN read live + per-receiver Map +
 * pull-board collection proven over SYNTHETIC captures". This is NOT "live cross-receiver corroboration":
 * the live cross-validator media plane + carrier are M4b (W-M3-SIM narrowed, not closed).
 *
 * All fixture-driven: synthetic captured Buffers + an in-memory board + injected seams. No boot, no
 * ports, no localnet, no mediasoup.
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
import { recomputeCanaryFrame, deriveCanarySeed, type VerifyInput } from '../verifier.js';
import { type CanaryValidator } from '../cell.js';
import { type DivergenceProof } from '../proof.js';
import { InMemoryClaimBoard, type ClaimBoard } from '../claim-board.js';

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

/** Forward every ctr in `ctrs` EXCEPT those in `dropped` (a withholding profile). */
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

const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };
const PEER: CanaryValidator = { minerId: 'peer-miner', sessionWallet: 'peer-session' };

/**
 * Assemble the deps for ONE in-process validator loop. The board + submit recorder may be SHARED
 * across two loops (distinct `selfSessionKeypair`s) to model a real >=2-distinct quorum forming.
 */
function makeDeps(opts: {
  ctrs: number[];
  dropped: Set<number>;
  stunLossBps: bigint;
  capturePerReceiver?: () => Promise<Map<string, Buffer[]>>;
  k?: number;
  deltaBps?: bigint;
  board?: ClaimBoard;
  submitted?: DivergenceProof[];
  selfSessionKeypair?: Ed25519Keypair;
}): {
  deps: CanaryVerifyDeps;
  submitted: DivergenceProof[];
  captureCalls: { count: number };
  board: ClaimBoard;
} {
  const submitted = opts.submitted ?? [];
  const board = opts.board ?? new InMemoryClaimBoard({ wCorr: 100 });
  const selfSessionKeypair = opts.selfSessionKeypair ?? new Ed25519Keypair();
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
    localBoard: board,
    selfSessionKeypair,
    submit,
    config: { k: opts.k ?? 2, deltaBps: opts.deltaBps ?? 0n, sendRate: opts.ctrs.length },
  };
  return { deps, submitted, captureCalls, board };
}

/** Run `rounds` rounds for one or two loops sharing a board; returns the shared submitted list. */
async function runShared(
  loops: ReturnType<typeof makeDeps>[],
  rounds: number,
): Promise<void> {
  const accs: (undefined | Awaited<ReturnType<typeof runCanaryVerifyRound>>['accumulator'])[] =
    loops.map(() => undefined);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < loops.length; i++) {
      const res = await runCanaryVerifyRound(loops[i]!.deps, accs[i], r);
      accs[i] = res.accumulator;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// (a) REQ-CFA-042 — the STUN value flows into the classifier (FIRST real reader).
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-042 — state.relayStunLossBps is READ as the classifier stunPacketLossBps arg', () => {
  it('a HIGH STUN prior ABSORBS a drop that a ZERO STUN prior PROMOTES (two-validator quorum on a shared board)', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);

    // ZERO STUN, delta 0 → budget 0 → a sustained drop PROMOTES; two daemons corroborate → SLASH.
    const lowBoard = new InMemoryClaimBoard({ wCorr: 100 });
    const lowSubmitted: DivergenceProof[] = [];
    const lowA = makeDeps({ ctrs, dropped, stunLossBps: 0n, board: lowBoard, submitted: lowSubmitted, selfSessionKeypair: new Ed25519Keypair() });
    const lowB = makeDeps({ ctrs, dropped, stunLossBps: 0n, board: lowBoard, submitted: lowSubmitted, selfSessionKeypair: new Ed25519Keypair() });
    await runShared([lowA, lowB], 7);

    // HIGH STUN (50% in bps) → budget 5000 bps → ~12.5% cumulative rate sits BELOW budget → ABSORBED.
    const highBoard = new InMemoryClaimBoard({ wCorr: 100 });
    const highSubmitted: DivergenceProof[] = [];
    const highA = makeDeps({ ctrs, dropped, stunLossBps: 5000n, board: highBoard, submitted: highSubmitted, selfSessionKeypair: new Ed25519Keypair() });
    const highB = makeDeps({ ctrs, dropped, stunLossBps: 5000n, board: highBoard, submitted: highSubmitted, selfSessionKeypair: new Ed25519Keypair() });
    await runShared([highA, highB], 7);

    // ZERO STUN run promotes + corroborates + submits; HIGH STUN run never promotes → board empty.
    expect(lowSubmitted.length).toBeGreaterThan(0);
    expect(highSubmitted.length).toBe(0);
  });

  it('the submitted proof carries the audited relay + the diverged frameSeq + >=2 DISTINCT attesters', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const a = makeDeps({ ctrs, dropped, stunLossBps: 0n, board, submitted, selfSessionKeypair: new Ed25519Keypair() });
    const b = makeDeps({ ctrs, dropped, stunLossBps: 0n, board, submitted, selfSessionKeypair: new Ed25519Keypair() });
    await runShared([a, b], 7);

    expect(submitted.length).toBeGreaterThan(0);
    const proof = submitted[0]!;
    expect(proof.relayMinerId).toBe(RELAY_MINER);
    expect(proof.frameSeq).toBe(5);
    expect(proof.attestations.length).toBeGreaterThanOrEqual(2);
    // The two attesters are DISTINCT Wallet-B session pubkeys.
    const distinct = new Set(proof.attestations.map((at) => Buffer.from(at.sessionPublicKey).toString('hex')));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
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
    expect(res.perReceiverCount).toBeGreaterThanOrEqual(2);
    expect(res.absorbed.map((d) => d.frameSeq)).toContain(2);
    expect(res.promoted).toHaveLength(0); // 1 round < MIN_ROUNDS → never promoted yet
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (c) REQ-CFA-052 — the pull-board quorum gates submission (fail-closed under-quorum).
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-052 — pull-corroboration claim board gates the slash on a >=2-distinct quorum', () => {
  it('a SELF-ONLY loop FAILS CLOSED: a sustained drop is published but never reaches >=2 distinct → NO submit', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);
    // One loop only → its own self-attestation is the ONLY attester → 1 distinct → fail-closed.
    const { deps, submitted, board } = makeDeps({ ctrs, dropped, stunLossBps: 0n });
    let acc = undefined;
    for (let r = 0; r < 7; r++) {
      const res = await runCanaryVerifyRound(deps, acc, r);
      acc = res.accumulator;
    }
    expect(submitted).toHaveLength(0); // fail-closed: <2 distinct → no proof
    // The cell WAS opened (the drop was promoted + published) but stays sub-quorum.
    const open = await board.listOpen();
    expect(open.length).toBeGreaterThan(0);
  });

  it('a SINGLE-receiver drop is NOT correlated (k=2 SECONDARY not met) → never even promoted', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const capturePerReceiver = async (): Promise<Map<string, Buffer[]>> => {
      const selfFrames = await buildCapturedFrames(ctrs, new Set([5]));
      const peerFrames = await buildCapturedFrames(ctrs, new Set()); // PEER saw all frames
      return new Map([
        [SELF.minerId, selfFrames],
        [PEER.minerId, peerFrames],
      ]);
    };
    const { deps, submitted, board } = makeDeps({ ctrs, dropped: new Set([5]), stunLossBps: 0n, capturePerReceiver });
    let acc = undefined;
    for (let r = 0; r < 7; r++) {
      const res = await runCanaryVerifyRound(deps, acc, r);
      acc = res.accumulator;
    }
    expect(submitted).toHaveLength(0);
    expect((await board.listOpen()).length).toBe(0); // nothing even published
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// (d) REQ-CFA-042 (crash-safe) — a thrown round does not kill the loop.
// ─────────────────────────────────────────────────────────────────────────────────

describe('REQ-CFA-042 — startCanaryVerifyLoop survives a thrown round (crash-safe)', () => {
  it('a capture that throws on the FIRST round does NOT stop the next round from running', async () => {
    const ctrs = [0, 1, 2, 3];
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
      localBoard: new InMemoryClaimBoard({ wCorr: 100 }),
      selfSessionKeypair: new Ed25519Keypair(),
      submit: async () => {},
      config: { k: 2, deltaBps: 0n, sendRate: ctrs.length },
    };

    const handle = startCanaryVerifyLoop({ deps, intervalMs: 1_000_000, logger: undefined });
    await handle.runRoundForTest(); // the immediate fire may already be settled; this is the survivor
    await handle.runRoundForTest(); // guarantee a post-throw round runs
    handle.stop();

    expect(captureOrdinals.length).toBeGreaterThanOrEqual(2);
    expect(captureOrdinals[0]).toBe(0);
    expect(stunReads).toBeGreaterThan(0);
  });
});
