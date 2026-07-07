/**
 * Unit test: collectIssueQuorum (leader board-path collector).
 *
 * TDD RED → GREEN: verifies that once the follower has posted its attestation
 * to the SAME InMemoryGenericClaimBoard the leader is polling, collectIssueQuorum
 * assembles a 2-of-2 IssueQuorum with both distinct CP operator addresses.
 *
 * Uses REAL claim data (not advisory) so postAttestation can re-derive +
 * G4 byte-match + sign successfully.
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { InMemoryGenericClaimBoard } from '@dvconf/shared';
import { buildCapTokenIssueBoardConfig } from '../../cap-token-issuer.js';
import { buildIssueCanonicalMsg } from '../../captoken-issue-ptb.js';
import { collectIssueQuorum, type IssueRequest } from '../captoken-cosign-leader.js';
import { postAttestation } from '../captoken-cosign-attester.js';

describe('collectIssueQuorum (leader)', () => {
  it('assembles a 2-of-2 once the follower has posted its attestation', async () => {
    const board = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
    ]);
    const leaderKp = Ed25519Keypair.generate();
    const followerKp = Ed25519Keypair.generate();
    const req: IssueRequest = {
      roomId: '0x' + '33'.repeat(32),
      peerPubkey: new Array(32).fill(5),
      role: 4,
      expiresEpoch: 100n,
      nonce: 1n,
    };
    const discoveredCps = [
      { minerId: leaderKp.toSuiAddress(), operator: leaderKp.toSuiAddress() },
      { minerId: followerKp.toSuiAddress(), operator: followerKp.toSuiAddress() },
    ];

    // Follower polls the shared in-memory board and posts its attestation once
    // the leader has opened the cell (currentEpoch=0n → passes expiry check for
    // claim.expiresEpoch=100n since 100n > 0n).
    const followerJob = (async () => {
      for (let i = 0; i < 200; i++) {
        if (await postAttestation(board, followerKp, { currentEpoch: 0n })) return;
        await new Promise((r) => setTimeout(r, 5));
      }
    })();

    const quorum = await collectIssueQuorum({
      board,
      leaderKp,
      discoveredCps,
      req,
      minQuorum: 2,
      pollIntervalMs: 5,
      maxPollRounds: 400,
    });
    await followerJob;

    expect(quorum.qs.signers.length).toBe(2);
    expect(new Set(quorum.qs.signers).size).toBe(2);
    expect(quorum.qs.signers).toContain(leaderKp.toSuiAddress());
    expect(quorum.qs.signers).toContain(followerKp.toSuiAddress());
    // Canonical msg is 32+32+1+8+8 = 81 bytes.
    expect(buildIssueCanonicalMsg(req).length).toBe(81);
  });
});
