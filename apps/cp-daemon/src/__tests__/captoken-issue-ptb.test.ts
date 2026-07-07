// TDD Task 1: N-signer issue PTB builder (buildIssueQuorumTx).
// Spec: 2026-07-06-captoken-cosign-live-run-design section 6.
// Path adjustment vs plan: test lives in __tests__/ because vitest.config.ts
// include pattern only matches **/__tests__/**/*.test.ts (no co-located tests).
// Import adjusted to '../captoken-issue-ptb.js'.
import { describe, it, expect } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { buildIssueCanonicalMsg, buildIssueQuorumTx } from '../captoken-issue-ptb.js';

describe('buildIssueCanonicalMsg', () => {
  it('produces the 81-byte room||peer||role||expires||nonce concat (little-endian u64)', () => {
    const roomId = '0x' + '11'.repeat(32);
    const peerPubkey = new Array(32).fill(0xaa);
    const msg = buildIssueCanonicalMsg({ roomId, peerPubkey, role: 4, expiresEpoch: 1n, nonce: 1n });
    expect(msg.length).toBe(32 + 32 + 1 + 8 + 8);
    expect(msg[32]).toBe(0xaa);      // first peer byte
    expect(msg[64]).toBe(4);         // role
    expect(msg[65]).toBe(1);         // expiresEpoch LSB
    expect(msg[73]).toBe(1);         // nonce LSB
  });
});

describe('buildIssueQuorumTx', () => {
  it('emits exactly two moveCalls (new_quorum_sig -> issue_capability_token) for a 2-of-2 quorum', () => {
    const tx = new Transaction();
    buildIssueQuorumTx(
      tx,
      { packageId: '0x2', networkRegistryId: '0x3', cpRegistryId: '0x4', quorumStateId: '0x5' },
      { roomId: '0x' + '11'.repeat(32), peerPubkey: new Array(32).fill(1), role: 4, expiresEpoch: 100n, nonce: 1n },
      {
        qs: { signers: ['0xa', '0xb'], signatures: [new Array(64).fill(1), new Array(64).fill(2)] },
        pubkeys: [new Array(32).fill(3), new Array(32).fill(4)],
        aggregateSig: [0x01, ...new Array(64).fill(1), ...new Array(64).fill(2)],
      },
    );
    const data = tx.getData();
    // KNOWN RISK (plan): commands.length is SDK-version-sensitive — filter for
    // MoveCall commands only to match the invariant from the existing
    // buildIssueDemoTx test (scripts/governance/__tests__/issue-cap-token-demo.test.ts).
    const moveCalls = data.commands.filter((c) => c.$kind === 'MoveCall');
    expect(moveCalls.length).toBe(2);
  });

  it('rejects a mismatched signers/signatures/pubkeys length', () => {
    const tx = new Transaction();
    expect(() =>
      buildIssueQuorumTx(
        tx,
        { packageId: '0x2', networkRegistryId: '0x3', cpRegistryId: '0x4', quorumStateId: '0x5' },
        { roomId: '0x' + '11'.repeat(32), peerPubkey: new Array(32).fill(1), role: 4, expiresEpoch: 100n, nonce: 1n },
        { qs: { signers: ['0xa'], signatures: [new Array(64).fill(1)] }, pubkeys: [new Array(32).fill(3), new Array(32).fill(4)], aggregateSig: [0x01] },
      ),
    ).toThrow(/length/i);
  });
});
