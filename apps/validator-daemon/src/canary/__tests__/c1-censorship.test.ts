/**
 * C1 censorship-resistance (PLAN-m4b-hermetic.md Leg 1; ADR-0021 "Censorship-resistance (C1)") —
 * the redundant self-submit mechanism that lifts off-chain collection LIVENESS to the on-chain
 * >=2-distinct bound. HERMETIC: simulated `InMemoryClaimBoard`s, no WAN, no ops, no live media.
 *
 * THE VECTOR (PLAN §3.1): pre-C1, `runCanaryVerifyRound` polls ONE shared board. In topology A1
 * that board lives on the assembler host. A colluding assembler can (a) drop a validator's `post`
 * and (b) suppress its own self-submit -> no honest validator ever sees >=2 -> a guilty relay
 * escapes slash. The on-chain `miner_id` dedup protects SAFETY (no double-slash) but does NOTHING
 * for this LIVENESS gap.
 *
 * THE FIX (PLAN §3.2): no designated assembler. Each co-observer reads its OWN `localBoard`, and on
 * self-attest / corroborate fans the attestation out to `[localBoard, ...coObserverBoards]`
 * (fail-OPEN per board). Each honest board independently accrues >=2 and submits (after a jitter).
 * Censoring now requires compromising ALL >=2 honest co-observers = the on-chain threshold.
 *
 * These tests PIN:
 *   (load-bearing) one-censor-cannot-suppress: N=3 daemons each own board, cross-post wired; daemon-1
 *     is a colluding assembler (drops every inbound post AND never self-submits). A real divergence is
 *     observed by all 3. ASSERT >=1 HONEST daemon still submits a well-formed >=2-distinct proof.
 *   double-submit absorption: jitter collision -> 2 honest daemons both submit; both proofs are
 *     well-formed >=2-distinct (the on-chain idempotency that absorbs them is proven elsewhere — we
 *     assert ONLY the seam contract here, per PLAN §7).
 *   jitter de-sync: an injected deterministic jitter orders the submits; the LATER submitter still
 *     produces a valid proof (no lost slash if the first is dropped).
 *   vanilla byte-identical: `coObserverBoards=[]` + no-op jitter -> the singleton path is unchanged
 *     (a self-only loop fails closed, a >=2-distinct shared-board quorum submits) — the existing
 *     151-test canary suite is the broader guard; this file pins the default-empty contract directly.
 */

import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  runCanaryVerifyRound,
  type CanaryForwardCapture,
  type CanaryVerifyDeps,
  type CanarySlashSubmit,
} from '../verify-loop.js';
import { recomputeCanaryFrame, deriveCanarySeed, type VerifyInput } from '../verifier.js';
import { type CanaryValidator } from '../cell.js';
import { type DivergenceProof } from '../proof.js';
import { InMemoryClaimBoard, type ClaimBoard, type OpenClaimCell } from '../claim-board.js';

// ── shared synthetic keying (recomputed locally — no live media) ─────────────────────
const KROOM = new Uint8Array(32).fill(0x07);
const CELL_SECRET = new Uint8Array(16).fill(0x5a);
const CANARY_KID = 9;
const ROOM_ID = 'c1-room';
const RELAY_MINER = 'relay-under-audit';

const verifyInput = (expectedCtrs: number[]): VerifyInput => ({
  kRoom: KROOM,
  roomId: ROOM_ID,
  cellSecret: CELL_SECRET,
  canaryKid: CANARY_KID,
  expectedCtrs,
});

const wrapAsRtp = (body: Uint8Array): Buffer =>
  Buffer.concat([Buffer.alloc(12), Buffer.from(body)]);

/** Forward every ctr EXCEPT those in `dropped` (a withholding profile). */
async function buildCapturedFrames(ctrs: number[], dropped: Set<number>): Promise<Buffer[]> {
  const input = verifyInput(ctrs);
  const seed = deriveCanarySeed(input.cellSecret);
  const captured: Buffer[] = [];
  for (const ctr of ctrs) {
    if (dropped.has(ctr)) continue;
    captured.push(wrapAsRtp(await recomputeCanaryFrame(input, seed, ctr)));
  }
  return captured;
}

const SELF: CanaryValidator = { minerId: 'self-miner', sessionWallet: 'self-session' };
const PEER: CanaryValidator = { minerId: 'peer-miner', sessionWallet: 'peer-session' };

/**
 * A colluding-assembler board: DROPS every inbound `post` (its own self-attestation included) so its
 * `listOpen` never accrues anything -> models a host that censors the collection it assembles.
 */
class CensoringClaimBoard implements ClaimBoard {
  async post(): Promise<void> {
    /* censored — every post silently discarded */
  }
  async listOpen(): Promise<OpenClaimCell[]> {
    return [];
  }
  async get(): Promise<OpenClaimCell | undefined> {
    return undefined;
  }
  async markSubmitted(): Promise<void> {
    /* nothing to mark */
  }
  async gc(): Promise<void> {
    /* nothing to GC */
  }
}

/** A capture that withholds ctr 5 (a sustained drop both SELF and PEER observe). */
function divergentCapture(ctrs: number[], dropped: Set<number>): CanaryForwardCapture {
  return async (scope) => {
    const frames = await buildCapturedFrames(ctrs, dropped);
    return {
      relayId: scope.relayId,
      roomId: scope.roomId,
      canaryKid: CANARY_KID,
      expectedCtrs: ctrs,
      kRoom: KROOM,
      cellSecret: CELL_SECRET,
      perReceiver: new Map([
        [SELF.minerId, frames],
        [PEER.minerId, frames.map((f) => Buffer.from(f))],
      ]),
    };
  };
}

/** Build one daemon's deps over its OWN local board + injected co-observer boards + jitter. */
function makeDaemon(opts: {
  localBoard: ClaimBoard;
  coObserverBoards: ClaimBoard[];
  selfSessionKeypair: Ed25519Keypair;
  submitted: DivergenceProof[];
  ctrs: number[];
  dropped: Set<number>;
  jitter?: () => Promise<void>;
  suppressSubmit?: boolean;
}): CanaryVerifyDeps {
  const submit: CanarySlashSubmit = async (proof) => {
    if (opts.suppressSubmit) return; // colluding assembler never submits its own proof
    opts.submitted.push(proof);
  };
  return {
    getRelayRoomScopes: () => [{ relayId: RELAY_MINER, roomId: ROOM_ID }],
    getValidators: () => [SELF, PEER],
    getStunLossBps: () => 0n,
    capture: divergentCapture(opts.ctrs, opts.dropped),
    localBoard: opts.localBoard,
    coObserverBoards: opts.coObserverBoards,
    jitter: opts.jitter ?? (async () => {}),
    selfSessionKeypair: opts.selfSessionKeypair,
    submit,
    config: { k: 2, deltaBps: 0n, sendRate: opts.ctrs.length },
  };
}

/** Run `rounds` rounds for a set of daemons, threading each daemon's own accumulator. */
async function runMesh(daemons: CanaryVerifyDeps[], rounds: number): Promise<void> {
  const accs: (undefined | Awaited<ReturnType<typeof runCanaryVerifyRound>>['accumulator'])[] =
    daemons.map(() => undefined);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < daemons.length; i++) {
      const res = await runCanaryVerifyRound(daemons[i]!, accs[i], r);
      accs[i] = res.accumulator;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// (load-bearing) one colluding assembler cannot suppress a valid slash.
// ─────────────────────────────────────────────────────────────────────────────────

describe('C1 — one censor cannot suppress a valid slash (PLAN §3.2, load-bearing)', () => {
  it('N=3, daemon-1 colludes (censors its board + suppresses its self-submit); >=1 HONEST daemon still submits a >=2-distinct proof', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);

    // Each daemon has its OWN board. Daemon-1 is the colluding ASSEMBLER: its board CENSORS every
    // post and it NEVER cross-posts to the honest boards + NEVER self-submits. So the honest boards
    // get NOTHING from the colluder — the ONLY way board2/board3 reach >=2 distinct is the honest
    // daemons' mutual cross-post fan-out (C1). That is precisely what makes the singleton-revert
    // mutation (coObserverBoards=[]) FAIL: without the fan-out each honest board holds 1 distinct.
    const board1 = new CensoringClaimBoard(); // colluding assembler's board (drops everything)
    const board2 = new InMemoryClaimBoard({ wCorr: 100 });
    const board3 = new InMemoryClaimBoard({ wCorr: 100 });

    const submitted: DivergenceProof[] = []; // honest daemons' submits land here
    const key1 = new Ed25519Keypair();
    const key2 = new Ed25519Keypair();
    const key3 = new Ed25519Keypair();

    // Colluder: censoring local board, NO cross-post to honest boards, suppress self-submit.
    const d1 = makeDaemon({
      localBoard: board1,
      coObserverBoards: [], // colluder does NOT prop up the honest boards
      selfSessionKeypair: key1,
      submitted,
      ctrs,
      dropped,
      suppressSubmit: true, // colluder never submits
    });
    // Honest daemons cross-post ONLY to EACH OTHER (the C1 fan-out). Neither posts to the colluder's
    // censoring board (it would be discarded anyway). board2 accrues d2.self + d3.cross = 2 distinct.
    const d2 = makeDaemon({
      localBoard: board2,
      coObserverBoards: [board3],
      selfSessionKeypair: key2,
      submitted,
      ctrs,
      dropped,
    });
    const d3 = makeDaemon({
      localBoard: board3,
      coObserverBoards: [board2],
      selfSessionKeypair: key3,
      submitted,
      ctrs,
      dropped,
    });

    await runMesh([d1, d2, d3], 7);

    // The colluding assembler censored its own board + suppressed its self-submit, yet the honest
    // daemons' mutual cross-post let board2/board3 each independently reach >=2 distinct -> a slash
    // is submitted. Censoring would now require compromising BOTH honest co-observers (the on-chain
    // >=2-distinct bound) — exactly C1's guarantee.
    expect(submitted.length).toBeGreaterThan(0);
    const proof = submitted[0]!;
    expect(proof.relayMinerId).toBe(RELAY_MINER);
    expect(proof.frameSeq).toBe(5);
    expect(proof.attestations.length).toBeGreaterThanOrEqual(2);
    const distinct = new Set(
      proof.attestations.map((at) => Buffer.from(at.sessionPublicKey).toString('hex')),
    );
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });

  it('MUTATION TEETH — singleton (coObserverBoards=[]) + same colluder lets the censor suppress the slash (NO submit)', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);

    // Singleton topology: every honest daemon reads ONLY its own board, no cross-post fan-out, and
    // the colluding assembler's board is the SHARED collection point (the pre-C1 A1 vector). With no
    // co-observer redundancy the censor's drop-everything board hides the cell from everyone.
    const censorBoard = new CensoringClaimBoard();
    const submitted: DivergenceProof[] = [];

    const d1 = makeDaemon({
      localBoard: censorBoard,
      coObserverBoards: [], // singleton: NO redundancy
      selfSessionKeypair: new Ed25519Keypair(),
      submitted,
      ctrs,
      dropped,
      suppressSubmit: true,
    });
    const d2 = makeDaemon({
      localBoard: censorBoard, // honest daemons post ONLY to the shared (censoring) board
      coObserverBoards: [],
      selfSessionKeypair: new Ed25519Keypair(),
      submitted,
      ctrs,
      dropped,
    });
    const d3 = makeDaemon({
      localBoard: censorBoard,
      coObserverBoards: [],
      selfSessionKeypair: new Ed25519Keypair(),
      submitted,
      ctrs,
      dropped,
    });

    await runMesh([d1, d2, d3], 7);

    // Singleton-on-the-censor-board: the slash IS suppressed. This is the teeth: revert the fix
    // (no co-observer redundancy) and the censor wins.
    expect(submitted).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// double-submit absorption (assert the SEAM contract; on-chain idempotency proven elsewhere).
// ─────────────────────────────────────────────────────────────────────────────────

describe('C1 — double-submit absorption (seam contract only; on-chain dedup proven by the slash E2E)', () => {
  it('two HONEST daemons each submit a well-formed >=2-distinct proof for the SAME divergence (the chain dedups by miner_id)', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);

    const board1 = new InMemoryClaimBoard({ wCorr: 100 });
    const board2 = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const k1 = new Ed25519Keypair();
    const k2 = new Ed25519Keypair();

    // No jitter de-sync (both no-op) -> both honest boards reach >=2 and both submit (collision).
    const d1 = makeDaemon({ localBoard: board1, coObserverBoards: [board2], selfSessionKeypair: k1, submitted, ctrs, dropped });
    const d2 = makeDaemon({ localBoard: board2, coObserverBoards: [board1], selfSessionKeypair: k2, submitted, ctrs, dropped });

    await runMesh([d1, d2], 7);

    // BOTH submitted (double-submit). The seam contract: each proof is independently well-formed
    // >=2-distinct. We do NOT re-prove the on-chain dedup here (that is the slash-E2E's job, PLAN §7).
    expect(submitted.length).toBeGreaterThanOrEqual(2);
    for (const proof of submitted) {
      expect(proof.relayMinerId).toBe(RELAY_MINER);
      expect(proof.frameSeq).toBe(5);
      const distinct = new Set(
        proof.attestations.map((at) => Buffer.from(at.sessionPublicKey).toString('hex')),
      );
      expect(distinct.size).toBeGreaterThanOrEqual(2);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// jitter de-sync — injected jitter orders submits; the later submitter still produces a valid proof.
// ─────────────────────────────────────────────────────────────────────────────────

describe('C1 — jitter de-syncs the submitters (the later one still produces a valid proof)', () => {
  it('an injected jitter delays daemon-2; daemon-1 submits first but daemon-2 still builds a valid >=2-distinct proof', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);
    const order: string[] = [];

    const board1 = new InMemoryClaimBoard({ wCorr: 100 });
    const board2 = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];

    // Deterministic jitter: daemon-1 no delay (submits first), daemon-2 yields a microtask FIRST so
    // it is ordered AFTER daemon-1 — modelling the de-sync without a real timer.
    const d1 = makeDaemon({
      localBoard: board1,
      coObserverBoards: [board2],
      selfSessionKeypair: new Ed25519Keypair(),
      submitted,
      ctrs,
      dropped,
      jitter: async () => { order.push('d1'); },
    });
    const d2 = makeDaemon({
      localBoard: board2,
      coObserverBoards: [board1],
      selfSessionKeypair: new Ed25519Keypair(),
      submitted,
      ctrs,
      dropped,
      jitter: async () => { await Promise.resolve(); order.push('d2'); },
    });

    await runMesh([d1, d2], 7);

    // Jitter ran (de-sync seam exercised) and the later submitter (d2) still produced a valid proof.
    expect(order).toContain('d1');
    expect(order).toContain('d2');
    expect(submitted.length).toBeGreaterThanOrEqual(2);
    const last = submitted[submitted.length - 1]!;
    expect(last.frameSeq).toBe(5);
    expect(last.attestations.length).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────
// vanilla byte-identical — coObserverBoards=[] default => the singleton path is preserved.
// ─────────────────────────────────────────────────────────────────────────────────

describe('C1 — vanilla byte-identical: coObserverBoards=[] + no-op jitter preserves the singleton path', () => {
  it('a SELF-ONLY daemon (empty co-observers) over its own board FAILS CLOSED (<2 distinct -> no submit)', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const d = makeDaemon({
      localBoard: board,
      coObserverBoards: [],
      selfSessionKeypair: new Ed25519Keypair(),
      submitted,
      ctrs,
      dropped,
    });
    let acc = undefined;
    for (let r = 0; r < 7; r++) {
      const res = await runCanaryVerifyRound(d, acc, r);
      acc = res.accumulator;
    }
    // 1 distinct attester -> fail-closed, exactly as the pre-C1 singleton path.
    expect(submitted).toHaveLength(0);
    expect((await board.listOpen()).length).toBeGreaterThan(0); // cell opened but sub-quorum
  });

  it('two daemons sharing ONE board with coObserverBoards=[] still reach >=2 and submit (singleton-shared, unchanged)', async () => {
    const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
    const dropped = new Set([5]);
    const shared = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const d1 = makeDaemon({ localBoard: shared, coObserverBoards: [], selfSessionKeypair: new Ed25519Keypair(), submitted, ctrs, dropped });
    const d2 = makeDaemon({ localBoard: shared, coObserverBoards: [], selfSessionKeypair: new Ed25519Keypair(), submitted, ctrs, dropped });
    await runMesh([d1, d2], 7);
    expect(submitted.length).toBeGreaterThan(0);
    expect(submitted[0]!.frameSeq).toBe(5);
  });
});
