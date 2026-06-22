/**
 * REQ-RMS-017 — Byzantine relay attribution reuses the SHIPPED canary lane.
 *
 * Worked example (DESIGN §4.5): relay R overclaims capacity then UNDER-SERVES.
 * Under-serving manifests as DROPPED canary frames (capacity overclaim per se is
 * INVISIBLE to the classifier — it only sees forwarding divergence). We feed the
 * mesh's per-(relay,room) RoundObservations into the UNCHANGED runCanaryVerifyRound
 * capture seam and assert:
 *   (a) R's sustained drops cross the cumulative bound and a slash is SUBMITTED;
 *   (b) the slash is pinned to R's miner_id (NOT R2, the honest co-relay, NOT the
 *       network) — per-relay isolation via the relayMinerId-keyed accumulator;
 *   (c) the honest co-relay R2 (zero drops, same rounds) is NEVER slashed.
 *
 * HERMETIC (on record, mirrors verify-loop.test.ts): the cross-validator media
 * capture is synthetic; SECONDARY >=k is SIMULATED (W-M3-SIM); live transport is
 * canary-M4b. The mesh reuses a hermetically-proven pipeline, not a live one.
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { runCanaryVerifyRound, isRelayFlaggedByCanary, type CanaryForwardCapture, type CanaryVerifyDeps } from '../verify-loop.js';
import { recomputeCanaryFrame, deriveCanarySeed, type VerifyInput } from '../verifier.js';
import { type CanaryValidator, type RelayRoomScope } from '../cell.js';
import { type DivergenceProof } from '../proof.js';
import { InMemoryClaimBoard, type ClaimBoard } from '../claim-board.js';
import { MIN_ROUNDS_FOR_CUMULATIVE } from '../loss-classifier.js';

const KROOM = new Uint8Array(32).fill(0x07);
const CELL_SECRET = new Uint8Array(16).fill(0x5a);
const CANARY_KID = 9;
const ROOM_ID = 'mesh-room';
const RELAY_R = 'relay-byzantine-R';   // overclaims -> under-serves
const RELAY_R2 = 'relay-honest-R2';    // forwards everything
const SELF: CanaryValidator = { minerId: 'val-self', sessionWallet: 's-self' };
const PEER: CanaryValidator = { minerId: 'val-peer', sessionWallet: 's-peer' };

const verifyInput = (ctrs: number[]): VerifyInput => ({ kRoom: KROOM, roomId: ROOM_ID, cellSecret: CELL_SECRET, canaryKid: CANARY_KID, expectedCtrs: ctrs });
const wrapAsRtp = (body: Uint8Array): Buffer => Buffer.concat([Buffer.alloc(12), Buffer.from(body)]);
async function buildCaptured(ctrs: number[], dropped: Set<number>): Promise<Buffer[]> {
  const input = verifyInput(ctrs); const seed = deriveCanarySeed(input.cellSecret);
  const out: Buffer[] = [];
  for (const ctr of ctrs) { if (dropped.has(ctr)) continue; out.push(wrapAsRtp(await recomputeCanaryFrame(input, seed, ctr))); }
  return out;
}

/**
 * Mesh capture: relay R under-serves (drops ctr 5 every round); honest R2 forwards
 * everything. Both co-auditors (SELF+PEER) see the SAME forwarded set per relay so
 * the SECONDARY >=k correlates. This is the adapter the mesh telemetry collector
 * supplies in place of the M4b live media plane.
 */
function meshCapture(): CanaryForwardCapture {
  const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
  return async (scope: RelayRoomScope) => {
    const dropped = scope.relayId === RELAY_R ? new Set([5]) : new Set<number>();
    const frames = await buildCaptured(ctrs, dropped);
    return {
      relayId: scope.relayId, roomId: scope.roomId, canaryKid: CANARY_KID, expectedCtrs: ctrs,
      kRoom: KROOM, cellSecret: CELL_SECRET,
      perReceiver: new Map([[SELF.minerId, frames], [PEER.minerId, frames.map((f) => Buffer.from(f))]]),
    };
  };
}

function makeMeshDeps(board: ClaimBoard, submitted: DivergenceProof[], self: Ed25519Keypair): CanaryVerifyDeps {
  return {
    getRelayRoomScopes: () => [{ relayId: RELAY_R, roomId: ROOM_ID }, { relayId: RELAY_R2, roomId: ROOM_ID }],
    getValidators: () => [SELF, PEER],
    getStunLossBps: () => 0n,
    capture: meshCapture(),
    claimBoard: board,
    selfSessionKeypair: self,
    submit: async (proof) => { submitted.push(proof); },
    config: { k: 2, deltaBps: 0n, sendRate: 8 },
  };
}

describe('REQ-RMS-017 — Byzantine under-server attributed to R via the SHIPPED canary pipeline', () => {
  it('R (overclaim->under-serve) is slashed pinned to its miner_id; honest R2 is never slashed', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const a = makeMeshDeps(board, submitted, new Ed25519Keypair());
    const b = makeMeshDeps(board, submitted, new Ed25519Keypair());

    let accA = undefined; let accB = undefined;
    for (let r = 0; r < 7; r++) { // > MIN_ROUNDS_FOR_CUMULATIVE (5)
      const ra = await runCanaryVerifyRound(a, accA, r); accA = ra.accumulator;
      const rb = await runCanaryVerifyRound(b, accB, r); accB = rb.accumulator;
    }

    // (a) a slash was submitted; (b) every submitted proof targets RELAY_R only.
    expect(submitted.length).toBeGreaterThan(0);
    for (const p of submitted) expect(p.relayMinerId).toBe(RELAY_R);
    // (c) honest R2 is never the slash target.
    expect(submitted.some((p) => p.relayMinerId === RELAY_R2)).toBe(false);
    // attribution carries the diverged frame + >=2 distinct attesters (quorum).
    expect(submitted[0]!.frameSeq).toBe(5);
    const distinct = new Set(submitted[0]!.attestations.map((at) => Buffer.from(at.sessionPublicKey).toString('hex')));
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  }, 30_000);

  it('the per-relay accumulator isolates R from R2 (R2 has zero drops, never crosses the bound)', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    const deps = makeMeshDeps(board, submitted, new Ed25519Keypair());
    let acc = undefined;
    for (let r = 0; r < 7; r++) { const res = await runCanaryVerifyRound(deps, acc, r); acc = res.accumulator; }
    const stateR = acc!.byRelay.get(RELAY_R);
    const stateR2 = acc!.byRelay.get(RELAY_R2);
    expect(stateR!.drops).toBeGreaterThan(0);  // R under-served
    expect(stateR2!.drops).toBe(0);            // R2 forwarded everything
  }, 30_000);

  it('NEGATIVE control — an all-honest mesh (R also forwards everything) produces NO slash', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const submitted: DivergenceProof[] = [];
    // Override capture so R drops NOTHING.
    const honestCapture: CanaryForwardCapture = async (scope) => {
      const ctrs = [0, 1, 2, 3, 4, 5, 6, 7];
      const frames = await buildCaptured(ctrs, new Set());
      return { relayId: scope.relayId, roomId: scope.roomId, canaryKid: CANARY_KID, expectedCtrs: ctrs, kRoom: KROOM, cellSecret: CELL_SECRET, perReceiver: new Map([[SELF.minerId, frames], [PEER.minerId, frames.map((f) => Buffer.from(f))]]) };
    };
    const deps: CanaryVerifyDeps = { ...makeMeshDeps(board, submitted, new Ed25519Keypair()), capture: honestCapture };
    let acc = undefined;
    for (let r = 0; r < 7; r++) { const res = await runCanaryVerifyRound(deps, acc, r); acc = res.accumulator; }
    expect(submitted).toHaveLength(0); // no divergence -> no slash (no false positive)
  }, 30_000);
});

describe('REQ-RMS-015 — isRelayFlaggedByCanary mirrors the classifier cumulative gate', () => {
  it('flags R (sustained drops) and not R2 (zero drops) after >= MIN_ROUNDS', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const deps = makeMeshDeps(board, [], new Ed25519Keypair());
    let acc = undefined;
    for (let r = 0; r < 7; r++) { const res = await runCanaryVerifyRound(deps, acc, r); acc = res.accumulator; }
    expect(isRelayFlaggedByCanary(acc!, RELAY_R, 0n, MIN_ROUNDS_FOR_CUMULATIVE)).toBe(true);
    expect(isRelayFlaggedByCanary(acc!, RELAY_R2, 0n, MIN_ROUNDS_FOR_CUMULATIVE)).toBe(false);
  }, 30_000);
  it('does NOT flag before MIN_ROUNDS of history (one unlucky round must not slash)', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const deps = makeMeshDeps(board, [], new Ed25519Keypair());
    const res = await runCanaryVerifyRound(deps, undefined, 0);
    expect(isRelayFlaggedByCanary(res.accumulator, RELAY_R, 0n, MIN_ROUNDS_FOR_CUMULATIVE)).toBe(false);
  }, 30_000);
});
