/**
 * Canary forwarding-audit ON-CHAIN SLASH leg — localnet E2E (Phase 4.1 CAPSTONE).
 * REQ-CFA-006 (slash entry fires) / REQ-CFA-007 (NxM attribution) / REQ-CFA-008
 * (no-false-positive) / INV-A (receiver-side divergence) / INV-C (Wallet-B-only quorum).
 *
 * This is the integration capstone that wires a REAL proof.ts proof into the DEPLOYED
 * Move entry `canary_audit::slash_for_canary_divergence` and proves a real, isolated,
 * bond-decreasing slash on a live localnet.
 *
 * ── THE DIVERGENCE IS REAL (INV-A) ─────────────────────────────────────────────────
 * We do NOT hand-craft hashes. We run the SHIPPED pipeline end-to-end on bytes:
 *   1. CanaryPublisher.produce() emits the canonical canary SFrame stream from cellSecret.
 *   2. We wrap each frame in a 12-byte RTP header (the wire shape verifier.ts scans), then
 *      TAMPER one frame's ciphertext byte (keeping its trailer ctr intact → classified as
 *      a TAMPER, not a drop).
 *   3. verifyForwardedCanary() recomputes each expected C_i LOCALLY and byte-compares →
 *      yields a real CanaryDivergence { frameSeq, expectedHash, observedHash }.
 *   4. buildDivergenceProof() turns it into a >=2 Wallet-B attestation proof.
 * The proof is then submitted on-chain.
 *
 * ── THE BOND REALITY: approach (b), the W-E9 owner-signs limitation (ON RECORD) ──────
 * The DESIGN's "hermetic shared StakePosition" relied on staking::share_for_testing /
 * create_for_testing — both `#[test_only]` and STRIPPED from the DEPLOYED localnet
 * package. A StakePosition `has key` (no store); registration mints one OWNED by the
 * miner wallet, and an owned `&mut` arg can only be passed by its OWNER in a PTB. So the
 * slash tx is SIGNED BY THE RELAY (the bond owner) itself. This still proves the ENTRY
 * MECHANISM end-to-end — the >=2 distinct Wallet-B quorum cannot be forged by the relay,
 * the divergence/room/wrong-bond asserts all execute, the bond is debited, the event
 * fires. The "bond owner signs its own slash" gap is EXACTLY W-E9: production needs a
 * protocol-controlled bond so a validator tx can slash without the owner's cooperation.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration` (the canary glob in
 * vitest.integration.config.ts), never `pnpm test`. ONE localnet at a time; the fixture
 * boots + (taskkill-tree) tears down cleanly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { createLogger, type Logger } from '@dvconf/shared';
import { CanaryPublisher } from '../../canary/publisher.js';
import { verifyForwardedCanary, type VerifyInput } from '../../canary/verifier.js';
import { buildDivergenceProof, OBSERVED_HASH_MISSING, type DivergenceProof } from '../../canary/proof.js';
// The submitter wires the proof → the Move entry. It does NOT exist yet (RED): the GREEN
// step creates apps/validator-daemon/src/canary/slash-submitter.ts.
import { submitCanarySlash } from '../../canary/slash-submitter.js';
import { bootLocalnet, type LocalnetHandle } from './localnet-fixture.js';
import {
  bootstrapCp,
  registerRelay,
  registerValidatorWithSession,
  createRoomWithRelay,
  readStakeAmount,
  expectMoveAbort,
  type CpResult,
  type RelayResult,
  type ValidatorResult,
} from './canary-localnet-helpers.js';

/** Short epoch so the role-vote→apply lifecycle settles quickly (2000ms stable on Windows). */
const EPOCH_DURATION_MS = 2000;

/** Deployed canary_audit error codes (canary_audit.move:49-67). */
const E_NO_DIVERGENCE = 686;
const E_WRONG_STAKE = 687;

/** The canary stream parameters (arbitrary but fixed; cellSecret is the covert factor). */
const CANARY_KID = 7;
const CTRS = [0, 1, 2, 3, 4];
const TAMPER_CTR = 2;
const K_ROOM = new Uint8Array(32).fill(0xab);
const CELL_SECRET = new Uint8Array(16).fill(0xcd);

/** Wrap a canary SFrame body in a minimal 12-byte RTP header (the wire shape the verifier scans). */
function toRtpPacket(body: Uint8Array): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2
  header[1] = 96; // dynamic PT
  return Buffer.concat([header, Buffer.from(body)]);
}

/**
 * Produce a REAL forwarding divergence: build the canonical canary stream, then TAMPER one
 * frame's ciphertext (a single byte inside the body, after the RTP header + before the
 * trailer, so its trailer ctr stays intact → TAMPER classification). Returns the verifier's
 * detected divergence (frameSeq/expectedHash/observedHash) for the given roomId/relay.
 */
async function produceRealDivergence(
  roomId: string,
): Promise<{ frameSeq: number; expectedHash: string; observedHash: string }> {
  const publisher = new CanaryPublisher();
  const frames = await publisher.produce({
    kRoom: K_ROOM,
    roomId,
    cellSecret: CELL_SECRET,
    canaryKid: CANARY_KID,
    ctrs: CTRS,
  });

  const wire: Buffer[] = frames.map((f, i) => {
    const pkt = toRtpPacket(f);
    if (CTRS[i] === TAMPER_CTR) {
      // Flip a byte in the ciphertext region: after the 12-byte RTP header, well before the
      // 14-byte trailer at the end (so the trailer ctr is preserved → TAMPER, not DROP).
      const flipAt = 12 + 4;
      pkt[flipAt] = pkt[flipAt]! ^ 0xff;
    }
    return pkt;
  });

  const input: VerifyInput = {
    kRoom: K_ROOM,
    roomId,
    cellSecret: CELL_SECRET,
    canaryKid: CANARY_KID,
    expectedCtrs: CTRS,
  };
  const result = await verifyForwardedCanary(wire, input);
  const div = result.divergences.find((d) => d.frameSeq === TAMPER_CTR);
  if (!div) {
    throw new Error(
      `produceRealDivergence: expected a tamper divergence at ctr ${TAMPER_CTR}, got ${JSON.stringify(result.divergences)}`,
    );
  }
  // Sanity: the divergence is a real present-but-different (tamper), not a drop.
  if (div.observedHash === OBSERVED_HASH_MISSING || div.expectedHash === div.observedHash) {
    throw new Error(`produceRealDivergence: not a real tamper divergence: ${JSON.stringify(div)}`);
  }
  return div;
}

interface SlashCallOpts {
  packageId: string;
  netReg: string;
  validatorReg: string;
  roomMgr: string;
  relayBondId: string;
}

describe('Canary divergence on-chain slash — localnet E2E (REQ-CFA-006/007/008, INV-A/C)', () => {
  let handle: LocalnetHandle;
  let cp: CpResult;
  let relayK: RelayResult; // the culprit relay (R_k)
  let v1: ValidatorResult;
  let v2: ValidatorResult;
  let roomId: string;
  const logger: Logger = createLogger('canary-slash-e2e');

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });
    cp = await bootstrapCp(handle.client, handle.config, logger);

    // The culprit relay owns its bond (approach (b)).
    relayK = await registerRelay(handle.client, cp, handle.config, logger);

    // Two DISTINCT validators with bound Wallet-B session wallets (INV-C >=2 quorum).
    v1 = await registerValidatorWithSession(handle.client, cp, handle.config, logger);
    v2 = await registerValidatorWithSession(handle.client, cp, handle.config, logger);

    // A registered user creates a room; R_k is AdminCap-assigned to it.
    const userKp = (await import('@mysten/sui/keypairs/ed25519')).Ed25519Keypair.generate();
    roomId = await createRoomWithRelay(
      handle.client,
      userKp,
      handle.deployer,
      handle.adminCapId,
      relayK.minerId,
      handle.config,
      logger,
    );
  }, 600_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('HAPPY: real divergence + 2 Wallet-B sigs → CanaryDivergenceSlashed fires AND R_k bond decreases', async () => {
    const div = await produceRealDivergence(roomId);

    const proof = await buildDivergenceProof({
      roomId,
      relayMinerId: relayK.minerId,
      canaryId: CANARY_KID,
      frameSeq: div.frameSeq,
      expectedHash: div.expectedHash,
      observedHash: div.observedHash,
      sessionKeypairs: [v1.sessionKp, v2.sessionKp],
    });

    const bondBefore = await readStakeAmount(handle.client, relayK.kp, relayK.stakeId, handle.config);
    expect(bondBefore).toBeGreaterThan(0n);

    // The slash tx is SIGNED BY THE RELAY (the bond owner) — approach (b) / W-E9.
    const slashResult = await submitCanarySlash.submit(
      handle.client,
      relayK.kp,
      proof,
      {
        packageId: handle.config.packageId,
        netReg: handle.config.networkRegistryId,
        validatorReg: handle.config.validatorRegistryId,
        roomMgr: handle.config.roomManagerId,
        relayBondId: relayK.stakeId,
      },
      logger,
    );

    // ── Assertion A: the CanaryDivergenceSlashed event fired with the right attribution ──
    const slashed = (slashResult.events ?? []).find((e) =>
      (e.type ?? '').includes('::canary_audit::CanaryDivergenceSlashed'),
    );
    expect(slashed).toBeDefined();
    const ev = slashed!.parsedJson as {
      relay_miner_id: string;
      frame_seq: string | number;
      attester_count: string | number;
      slash_amount: string | number;
      attester_ids: string[];
    };
    expect(normalizeSuiAddress(ev.relay_miner_id)).toBe(relayK.minerId);
    expect(Number(ev.frame_seq)).toBe(div.frameSeq);
    expect(Number(ev.attester_count)).toBe(2);
    expect(BigInt(ev.slash_amount)).toBeGreaterThan(0n);
    // The two distinct attesters are exactly v1 + v2 (resolved from session pubkeys).
    const attesters = new Set(ev.attester_ids.map((a) => normalizeSuiAddress(a)));
    expect(attesters.has(v1.minerId)).toBe(true);
    expect(attesters.has(v2.minerId)).toBe(true);

    // ── Assertion B: the bond ACTUALLY decreased (before > after, by slash_amount) ──
    const bondAfter = await readStakeAmount(handle.client, relayK.kp, relayK.stakeId, handle.config);
    logger.info(
      {
        module: 'canary-slash-e2e',
        action: 'bond_delta_happy',
        context: {
          bondBefore: bondBefore.toString(),
          bondAfter: bondAfter.toString(),
          slashAmount: String(ev.slash_amount),
          delta: (bondBefore - bondAfter).toString(),
        },
      },
      'EVIDENCE: R_k bond before/after slash',
    );
    expect(bondAfter).toBeLessThan(bondBefore);
    expect(bondBefore - bondAfter).toBe(BigInt(ev.slash_amount));
  });

  it('NO-FALSE-POSITIVE (REQ-CFA-008): an honest run (expected==observed) aborts E_NO_DIVERGENCE → no slash', async () => {
    // An honest forward: observed == expected, observed present. The proof is still
    // structurally valid (2 Wallet-B sigs) but the entry MUST abort on the divergence guard.
    const honestHash = 'e'.repeat(64);
    const proof = await buildDivergenceProof({
      roomId,
      relayMinerId: relayK.minerId,
      canaryId: CANARY_KID,
      frameSeq: 0,
      expectedHash: honestHash,
      observedHash: honestHash, // identical → NOT a divergence
      sessionKeypairs: [v1.sessionKp, v2.sessionKp],
    });

    const opts: SlashCallOpts = {
      packageId: handle.config.packageId,
      netReg: handle.config.networkRegistryId,
      validatorReg: handle.config.validatorRegistryId,
      roomMgr: handle.config.roomManagerId,
      relayBondId: relayK.stakeId,
    };
    const bondBefore = await readStakeAmount(handle.client, relayK.kp, relayK.stakeId, handle.config);
    await expectMoveAbort(
      handle.client,
      relayK.kp,
      (tx) => submitCanarySlash.addMoveCall(tx, proof, opts),
      E_NO_DIVERGENCE,
      'honest-run-no-divergence',
      logger,
    );
    const bondAfter = await readStakeAmount(handle.client, relayK.kp, relayK.stakeId, handle.config);
    expect(bondAfter).toBe(bondBefore); // bond UNCHANGED
  });

  it('NxM ATTRIBUTION (REQ-CFA-007): R2 proof slashes ONLY R2; submitting it against R1 aborts E_WRONG_STAKE', async () => {
    // Register a SECOND relay R2 + assign it to its own room. R1 = relayK from beforeAll.
    const r1 = relayK;
    const r2 = await registerRelay(handle.client, cp, handle.config, logger);
    const userKp = (await import('@mysten/sui/keypairs/ed25519')).Ed25519Keypair.generate();
    const room2 = await createRoomWithRelay(
      handle.client,
      userKp,
      handle.deployer,
      handle.adminCapId,
      r2.minerId,
      handle.config,
      logger,
    );

    const div = await produceRealDivergence(room2);
    const proofR2 = await buildDivergenceProof({
      roomId: room2,
      relayMinerId: r2.minerId,
      canaryId: CANARY_KID,
      frameSeq: div.frameSeq,
      expectedHash: div.expectedHash,
      observedHash: div.observedHash,
      sessionKeypairs: [v1.sessionKp, v2.sessionKp],
    });

    const r1Before = await readStakeAmount(handle.client, r1.kp, r1.stakeId, handle.config);
    const r2Before = await readStakeAmount(handle.client, r2.kp, r2.stakeId, handle.config);

    // Wrong-bond teeth: submit the R2 proof but pass R1's bond → E_WRONG_STAKE (the entry
    // binds proof.relay_miner_id to the passed StakePosition's miner_id). R1 signs because
    // R1 owns R1's bond. NOTE: relay_bond is R1's stake, but the proof names R2 → mismatch.
    const wrongBondOpts: SlashCallOpts = {
      packageId: handle.config.packageId,
      netReg: handle.config.networkRegistryId,
      validatorReg: handle.config.validatorRegistryId,
      roomMgr: handle.config.roomManagerId,
      relayBondId: r1.stakeId, // R1's bond — but proofR2 names R2
    };
    await expectMoveAbort(
      handle.client,
      r1.kp,
      (tx) => submitCanarySlash.addMoveCall(tx, proofR2, wrongBondOpts),
      E_WRONG_STAKE,
      'wrong-bond-r2-proof-against-r1',
      logger,
    );

    // Now the CORRECT submission: R2 proof against R2's bond, signed by R2.
    const slashResult = await submitCanarySlash.submit(
      handle.client,
      r2.kp,
      proofR2,
      {
        packageId: handle.config.packageId,
        netReg: handle.config.networkRegistryId,
        validatorReg: handle.config.validatorRegistryId,
        roomMgr: handle.config.roomManagerId,
        relayBondId: r2.stakeId,
      },
      logger,
    );
    const slashed = (slashResult.events ?? []).find((e) =>
      (e.type ?? '').includes('::canary_audit::CanaryDivergenceSlashed'),
    );
    expect(slashed).toBeDefined();
    expect(normalizeSuiAddress((slashed!.parsedJson as { relay_miner_id: string }).relay_miner_id)).toBe(r2.minerId);

    const r1After = await readStakeAmount(handle.client, r1.kp, r1.stakeId, handle.config);
    const r2After = await readStakeAmount(handle.client, r2.kp, r2.stakeId, handle.config);
    logger.info(
      {
        module: 'canary-slash-e2e',
        action: 'bond_delta_nxm',
        context: {
          r1Before: r1Before.toString(),
          r1After: r1After.toString(),
          r2Before: r2Before.toString(),
          r2After: r2After.toString(),
        },
      },
      'EVIDENCE: NxM attribution — only R2 slashed, R1 untouched',
    );

    // ONLY R2 was slashed; R1 is untouched (isolated attribution).
    expect(r2After).toBeLessThan(r2Before);
    expect(r1After).toBe(r1Before);
  });
});
