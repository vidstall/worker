/**
 * Task 2 — Cap-token 2-of-2 live issue on a real localnet (gap #3, direct-sign).
 *
 * Proves the N-signer buildIssueQuorumTx path (captoken-issue-ptb.ts) end-to-end
 * at THRESHOLD=2 on a real Sui localnet:
 *
 *   1. Boot localnet + publish contracts.
 *   2. Deploy QuorumConfigState with min_quorum=2 (update_threshold(2)).
 *   3. Enroll TWO distinct CP operators (cpA, cpB via register_cp).
 *   4. Build canonical ISSUE msg; each CP signs it with raw ed25519.
 *   5. Build 2-of-2 QuorumSig PTB via buildIssueQuorumTx; submit signed by cpA.
 *   6. Assert on-chain CapabilityIssued.issuer_quorum carries BOTH distinct CP
 *      addresses — this is the chain-level proof of a 2-of-2 quorum issue.
 *
 * LOCALNET-BOOTING: runs ONLY via `pnpm test:integration cap-token-2of2-issue`
 * (vitest.integration.config.ts; glob pattern covers cp-daemon integration tests).
 * NEVER run under `pnpm test`.
 *
 * Address normalization: both sides of the distinctness check are normalized via
 * normalizeSuiAddress to guard against leading-zero / 0x-prefix differences
 * between the chain-returned addresses and the SDK's toSuiAddress() output.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { createLogger, type Logger } from '@dvconf/shared';
import { bootLocalnet, type LocalnetHandle, SUI_RPC_URL } from './localnet-fixture.js';
import type { BootstrapCpResult } from './revote-localnet-helpers.js';
import {
  loadDeployerSigner,
  findAdminCap,
  setupQuorumStateWithThreshold,
  enrollCp,
  pollForIssued,
} from './cap-token-live-helpers.js';
import {
  buildIssueCanonicalMsg,
  buildIssueQuorumTx,
  type IssueQuorum,
} from '../../captoken-issue-ptb.js';

const EPOCH_DURATION_MS = 2000;
const logger: Logger = createLogger('captoken-2of2-issue-e2e');

// ── raw ed25519 self-attestation over the canonical issue msg ─────────────────

async function attest(
  kp: Ed25519Keypair,
  canonicalMsg: Uint8Array,
): Promise<{ signature: number[]; pubkey: number[]; addr: string }> {
  const sig = await kp.sign(canonicalMsg);
  return {
    signature: Array.from(sig.slice(0, 64)),
    pubkey: Array.from(kp.getPublicKey().toRawBytes()),
    addr: kp.toSuiAddress(),
  };
}

// ── test suite ────────────────────────────────────────────────────────────────

describe('Cap-token 2-of-2 LIVE issue (gap #3, direct-sign)', () => {
  let handle: LocalnetHandle;
  let deployer: Ed25519Keypair;
  let quorumStateId: string;
  let cpA: BootstrapCpResult;
  let cpB: BootstrapCpResult;

  beforeAll(async () => {
    handle = await bootLocalnet({ epochDurationMs: EPOCH_DURATION_MS });

    deployer = await loadDeployerSigner();
    const adminCapId = await findAdminCap(
      handle.client,
      handle.config.packageId,
      deployer.toSuiAddress(),
    );

    // Set threshold=2 BEFORE enrolling CPs.
    // update_threshold only asserts new_threshold >= 1 (no active-CP-count check),
    // so this is safe here.
    quorumStateId = await setupQuorumStateWithThreshold(
      handle.client,
      deployer,
      handle.config.packageId,
      handle.config.networkRegistryId,
      adminCapId,
      2,
    );

    // Enroll two distinct CPs so verify_quorum sees both as registered operators.
    cpA = await enrollCp(handle.client, handle.config, logger);
    cpB = await enrollCp(handle.client, handle.config, logger);

    logger.info(
      { module: 'captoken-2of2-e2e', context: { cpA: cpA.minerId, cpB: cpB.minerId, quorumStateId } },
      'beforeAll complete: 2 CPs enrolled, threshold=2',
    );
  }, 300_000);

  afterAll(async () => {
    if (handle) await handle.teardown();
  });

  it('two distinct registered CPs co-sign -> CapabilityIssued.issuer_quorum has both addresses', async () => {
    const client = new SuiClient({ url: SUI_RPC_URL });

    // Generate a peer keypair (the room participant receiving the token).
    const peerKp = new Ed25519Keypair();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());

    // roomId: any valid 32-byte hex (Move `address` primitive).
    const roomId =
      '0x' + Buffer.from(new Ed25519Keypair().getPublicKey().toRawBytes()).toString('hex');

    // expiresEpoch = current epoch + 100 (well beyond current epoch, avoids E_TOKEN_EXPIRED).
    const expiresEpoch = BigInt((await client.getLatestSuiSystemState()).epoch) + 100n;
    const nonce = 1n;
    const role = 4; // signaling

    // ── Both CPs sign the canonical issue msg with raw ed25519 ──────────────
    const canonicalMsg = buildIssueCanonicalMsg({
      roomId,
      peerPubkey,
      role,
      expiresEpoch,
      nonce,
    });
    const attA = await attest(cpA.kp, canonicalMsg);
    const attB = await attest(cpB.kp, canonicalMsg);

    // ── Build 2-of-2 quorum ──────────────────────────────────────────────────
    // aggregateSig format: [0x01, sig_A (64 bytes), sig_B (64 bytes)] — audit blob.
    const quorum: IssueQuorum = {
      qs: {
        signers: [attA.addr, attB.addr],
        signatures: [attA.signature, attB.signature],
      },
      pubkeys: [attA.pubkey, attB.pubkey],
      aggregateSig: [0x01, ...attA.signature, ...attB.signature],
    };

    // ── Build + submit the PTB (signed by cpA as the TX sender) ─────────────
    const tx = new Transaction();
    buildIssueQuorumTx(
      tx,
      {
        packageId: handle.config.packageId,
        networkRegistryId: handle.config.networkRegistryId,
        cpRegistryId: handle.config.cpRegistryId,
        quorumStateId,
      },
      { roomId, peerPubkey, role, expiresEpoch, nonce },
      quorum,
    );
    tx.setGasBudget(100_000_000);

    const res = await client.signAndExecuteTransaction({
      signer: cpA.kp,
      transaction: tx,
      options: { showEffects: true, showEvents: true },
    });
    await client.waitForTransaction({ digest: res.digest });

    const txStatus = (res.effects?.status?.status as string) ?? 'unknown';
    expect(txStatus).toBe('success');

    logger.info(
      { module: 'captoken-2of2-e2e', context: { digest: res.digest, txStatus } },
      'issue_capability_token TX confirmed',
    );

    // ── Poll for the CapabilityIssued event ──────────────────────────────────
    const issued = await pollForIssued(client, handle.config.packageId, peerPubkey, 30_000);
    expect(issued).not.toBeNull();

    // ── Assert issuer_quorum contains BOTH distinct CP addresses ─────────────
    // Normalize both sides (chain may return addresses with/without 0x prefix
    // or different zero-padding from the SDK's toSuiAddress()).
    const chainAddrs = (issued!.issuerQuorum).map((a) => normalizeSuiAddress(a));
    const addrA = normalizeSuiAddress(cpA.kp.toSuiAddress());
    const addrB = normalizeSuiAddress(cpB.kp.toSuiAddress());

    expect(chainAddrs.length).toBe(2);
    const distinct = new Set(chainAddrs);
    expect(distinct.size).toBe(2);
    expect(distinct.has(addrA)).toBe(true);
    expect(distinct.has(addrB)).toBe(true);

    logger.info(
      { module: 'captoken-2of2-e2e', context: { tokenId: issued!.tokenId, issuerQuorum: chainAddrs } },
      'PASS: CapabilityIssued.issuer_quorum has 2 distinct CP addresses',
    );
  });

  it('board-path: leader collects the follower attestation then submits a 2-of-2 issue', async () => {
    const { InMemoryGenericClaimBoard } = await import('@dvconf/shared');
    const { buildCapTokenIssueBoardConfig } = await import('../../cap-token/index.js');
    const { collectIssueQuorum } = await import('../../bin/captoken-cosign-leader.js');
    const { postAttestation } = await import('../../bin/captoken-cosign-attester.js');
    const client = new SuiClient({ url: SUI_RPC_URL });

    const peerKp = new Ed25519Keypair();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());
    const roomId =
      '0x' + Buffer.from(new Ed25519Keypair().getPublicKey().toRawBytes()).toString('hex');
    const expiresEpoch = BigInt((await client.getLatestSuiSystemState()).epoch) + 100n;
    const req = { roomId, peerPubkey, role: 4, expiresEpoch, nonce: 2n };

    const board = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
    ]);
    const discoveredCps = [
      { minerId: cpA.kp.toSuiAddress(), operator: cpA.kp.toSuiAddress() },
      { minerId: cpB.kp.toSuiAddress(), operator: cpB.kp.toSuiAddress() },
    ];

    // Follower (cpB) polls the shared board and posts its attestation once the leader
    // has opened the cell. currentEpoch=0n → passes expiry check for expiresEpoch>0n.
    const followerJob = (async () => {
      for (let i = 0; i < 400; i++) {
        if (await postAttestation(board, cpB.kp, { currentEpoch: 0n })) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const quorum = await collectIssueQuorum({
      board,
      leaderKp: cpA.kp,
      discoveredCps,
      req,
      minQuorum: 2,
      pollIntervalMs: 5,
      maxPollRounds: 400,
    });
    await followerJob;

    // Submit the 2-of-2 issue TX.
    const tx = new Transaction();
    buildIssueQuorumTx(
      tx,
      {
        packageId: handle.config.packageId,
        networkRegistryId: handle.config.networkRegistryId,
        cpRegistryId: handle.config.cpRegistryId,
        quorumStateId,
      },
      req,
      quorum,
    );
    tx.setGasBudget(100_000_000);
    const res = await client.signAndExecuteTransaction({
      signer: cpA.kp,
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    expect((res.effects?.status?.status as string)).toBe('success');

    const issued = await pollForIssued(client, handle.config.packageId, peerPubkey, 30_000);
    expect(issued).not.toBeNull();
    expect(new Set(issued!.issuerQuorum).size).toBe(2);

    logger.info(
      {
        module: 'captoken-2of2-e2e',
        context: { digest: res.digest, issuerQuorum: issued!.issuerQuorum },
      },
      'PASS: board-path 2-of-2 issue TX confirmed',
    );
  });
});
