/**
 * REQ-CFA-047/050/051/053 (W-M4-COSIGN, DESIGN-COSIGN.md D-CFA-38/41/43/44/46) — the pull-corroboration
 * claim board: `cellKey` (4-field key), `attestIfIndependentlyObserved` (the anti-fabrication gate),
 * the `InMemoryClaimBoard` (dedup-by-pubkey, fail-closed GC), and the INV-C wire-shape assertion
 * (no Wallet-A / no secret on the board). All hermetic — fixed synthetic keypairs, no ports.
 */

import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  cellKey,
  InMemoryClaimBoard,
  attestIfIndependentlyObserved,
} from '../claim-board.js';
import {
  signSelfAttestation,
  canonicalProofMessage,
  distinctAttesterCount,
  OBSERVED_HASH_MISSING,
  type DivergenceClaim,
} from '../proof.js';
import type { CanaryDivergence } from '../verifier.js';

const CLAIM: DivergenceClaim = {
  roomId: '0x' + '11'.repeat(32),
  relayMinerId: '0x' + '22'.repeat(32),
  canaryId: 9,
  frameSeq: 5,
  expectedHash: '33'.repeat(32),
  observedHash: OBSERVED_HASH_MISSING,
};

const msgFor = (c: DivergenceClaim): Uint8Array => canonicalProofMessage({ ...c, sessionKeypairs: [] });
const localDiv = (frameSeq: number, expectedHash: string, observedHash: string): CanaryDivergence => ({
  frameSeq,
  expectedHash,
  observedHash,
});

describe('REQ-CFA-047 — cellKey keys on the 4 IDENTIFYING fields only (D-CFA-38)', () => {
  it('the same (room,relay,canary,frameSeq) → the SAME key even if expected/observed differ', () => {
    const k1 = cellKey(CLAIM);
    const k2 = cellKey({ ...CLAIM, expectedHash: 'ff'.repeat(32), observedHash: 'aa'.repeat(32) });
    expect(k2).toBe(k1); // expected/observed are carried in the claim, NOT the key
  });

  it('a different frameSeq / relay / room / canary → a DIFFERENT key', () => {
    expect(cellKey({ ...CLAIM, frameSeq: 6 })).not.toBe(cellKey(CLAIM));
    expect(cellKey({ ...CLAIM, relayMinerId: '0x' + '44'.repeat(32) })).not.toBe(cellKey(CLAIM));
    expect(cellKey({ ...CLAIM, roomId: '0x' + '55'.repeat(32) })).not.toBe(cellKey(CLAIM));
    expect(cellKey({ ...CLAIM, canaryId: 10 })).not.toBe(cellKey(CLAIM));
  });
});

describe('REQ-CFA-050 — attestIfIndependentlyObserved signs ONLY on a local byte-match (anti-fabrication)', () => {
  it('a local divergence matching (frameSeq,expectedHash,observedHash) → returns a Wallet-B attestation', async () => {
    const kp = new Ed25519Keypair();
    const local = [localDiv(5, '33'.repeat(32), OBSERVED_HASH_MISSING)];
    const att = await attestIfIndependentlyObserved(CLAIM, local, kp);
    expect(att).not.toBeNull();
    expect(Array.from(att!.sessionPublicKey)).toEqual(Array.from(kp.getPublicKey().toRawBytes()));
  });

  it('a DISAGREEING local observation (different expectedHash for the same frame) → null (cannot be coerced)', async () => {
    const local = [localDiv(5, 'ee'.repeat(32), OBSERVED_HASH_MISSING)];
    const att = await attestIfIndependentlyObserved(CLAIM, local, new Ed25519Keypair());
    expect(att).toBeNull();
  });

  it('NO local observation of the frame → null', async () => {
    const local = [localDiv(7, '33'.repeat(32), OBSERVED_HASH_MISSING)];
    const att = await attestIfIndependentlyObserved(CLAIM, local, new Ed25519Keypair());
    expect(att).toBeNull();
  });

  it('a TAMPER claim (observedHash a real hash) matches only an identical local tamper observation', async () => {
    const tamper: DivergenceClaim = { ...CLAIM, observedHash: 'cc'.repeat(32) };
    const matching = [localDiv(5, '33'.repeat(32), 'cc'.repeat(32))];
    const wrong = [localDiv(5, '33'.repeat(32), 'dd'.repeat(32))];
    expect(await attestIfIndependentlyObserved(tamper, matching, new Ed25519Keypair())).not.toBeNull();
    expect(await attestIfIndependentlyObserved(tamper, wrong, new Ed25519Keypair())).toBeNull();
  });
});

describe('REQ-CFA-051 — InMemoryClaimBoard: dedup-by-pubkey, fail-closed GC, submit gating', () => {
  it('accrues distinct attesters and dedups a re-posted pubkey (idempotent)', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    const kpA = new Ed25519Keypair();
    const kpB = new Ed25519Keypair();
    const attA = await signSelfAttestation(msgFor(CLAIM), kpA);
    const attB = await signSelfAttestation(msgFor(CLAIM), kpB);
    await board.post(CLAIM, attA, 0);
    await board.post(CLAIM, attA, 1); // duplicate pubkey — idempotent
    await board.post(CLAIM, attB, 1);
    const cell = await board.get(cellKey(CLAIM));
    expect(cell).toBeDefined();
    expect(distinctAttesterCount(cell!.attestations)).toBe(2); // not 3
  });

  it('markSubmitted removes the cell from listOpen (exactly-once assembly)', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 100 });
    await board.post(CLAIM, await signSelfAttestation(msgFor(CLAIM), new Ed25519Keypair()), 0);
    expect((await board.listOpen()).length).toBe(1);
    await board.markSubmitted(cellKey(CLAIM));
    expect((await board.listOpen()).length).toBe(0);
    expect(await board.get(cellKey(CLAIM))).toBeUndefined();
  });

  it('FAILS CLOSED: a cell that never reaches >=2 distinct is GC\'d after W_corr (no slash)', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 3 });
    await board.post(CLAIM, await signSelfAttestation(msgFor(CLAIM), new Ed25519Keypair()), 0);
    await board.gc(2); // within window → retained
    expect((await board.listOpen()).length).toBe(1);
    await board.gc(3); // window expired, still <2 distinct → dropped un-fired
    expect((await board.listOpen()).length).toBe(0);
  });

  it('a cell that DID reach >=2 distinct is NOT GC\'d by the window (it is still assemblable)', async () => {
    const board = new InMemoryClaimBoard({ wCorr: 3 });
    await board.post(CLAIM, await signSelfAttestation(msgFor(CLAIM), new Ed25519Keypair()), 0);
    await board.post(CLAIM, await signSelfAttestation(msgFor(CLAIM), new Ed25519Keypair()), 0);
    await board.gc(10); // far past the window, but quorum was met → retained
    const open = await board.listOpen();
    expect(open.length).toBe(1);
    expect(distinctAttesterCount(open[0]!.attestations)).toBe(2);
  });
});

describe('REQ-CFA-053 — INV-C: nothing on the board carries an auditing validator Wallet-A or a secret', () => {
  it('a posted cell + attestation expose ONLY the accused relay public id + Wallet-B pubkey/sig', async () => {
    const board = new InMemoryClaimBoard();
    const kp = new Ed25519Keypair();
    await board.post(CLAIM, await signSelfAttestation(msgFor(CLAIM), kp), 0);
    const cell = (await board.listOpen())[0]!;
    // The attestation shape is Wallet-B ONLY — exactly two fields, no Wallet-A leg.
    expect(Object.keys(cell.attestations[0]!).sort()).toEqual(['sessionPublicKey', 'signature']);
    // The claim's only miner id is the ACCUSED relay (public) — no auditing-validator identity.
    expect(cell.claim.relayMinerId).toBe(CLAIM.relayMinerId);
    const wire = JSON.stringify({ claim: cell.claim, pub: Array.from(cell.attestations[0]!.sessionPublicKey) });
    // No `assignmentSecret`/`cellSecret` key, no `minerId`/`sessionWallet` of an auditor on the wire.
    expect(wire).not.toMatch(/assignmentSecret|cellSecret|sessionWallet|"minerId"/);
  });
});
