/*
 * Task 4 - cap-token follower (VM-2) attester bin - unit tests (TDD).
 *
 * REQ: postAttestation(board, signer, opts) must:
 *   - Find any open 'captoken-issue' cell on the board
 *   - Re-derive + sign (rebuildCanonicalAndSignIfMatches) independently
 *   - Post the attestation back with the signer's addr
 *   - Return true on success, false when no matching cell
 *
 * Test placement: bin/__tests__/ folder so vitest __tests__ include picks it up.
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { InMemoryGenericClaimBoard } from '@dvconf/shared';
import {
  buildCapTokenIssueBoardConfig,
  buildIssueCanonicalMsg,
  type CapTokenIssueClaim,
} from '../../cap-token-issuer.js';
import { postAttestation } from '../captoken-cosign-attester.js';

/**
 * Build a valid CapTokenIssueClaim, computing canonicalMsgHex via the SAME
 * buildIssueCanonicalMsg that the production predicate (rebuildCanonicalAndSignIfMatches
 * in cap-token-issuer.ts) re-derives with — pinning the fixture to the exact function
 * under test so the byte-match (G4) gate is verified, not merely coincidentally satisfied.
 */
function makeClaim(
  roomId: string,
  peerPubkey: number[],
  role: number,
  expiresEpoch: bigint,
  nonce: number,
): CapTokenIssueClaim {
  const msg = buildIssueCanonicalMsg({
    roomId,
    peerPubkey,
    role,
    expiresEpoch,
    nonce,
  });
  const hex = Buffer.from(msg).toString('hex');
  return {
    kind: 'captoken-issue',
    roomId,
    peerPubkey,
    role,
    expiresEpoch,
    nonce,
    canonicalMsgHex: hex,
  };
}

describe('postAttestation (cap-token follower)', () => {
  it('signs the open claim with CP#2 and posts an attestation carrying its own address', async () => {
    const board = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
    ]);
    const cp2 = Ed25519Keypair.generate();

    const roomId = '0x' + '22'.repeat(32);
    const claim = makeClaim(roomId, new Array(32).fill(7), 4, 100n, 1);

    // Post the leader's attestation first (round 0) - INV-C-valid (64-byte sig, 32-byte key)
    await board.post(
      'captoken-issue',
      claim,
      {
        signature: new Array(64).fill(9),
        pubkey: new Array(32).fill(8),
        addr: '0xleader',
      },
      0,
    );

    const posted = await postAttestation(board, cp2, { currentEpoch: 0n });
    expect(posted).toBe(true);

    const open = await board.listOpen();
    const cell = open.find((c) => c.kind === 'captoken-issue');
    expect(cell).toBeDefined();
    const addrs = (cell!.attestations as Array<{ addr: string }>).map((a) => a.addr);
    expect(addrs).toContain(cp2.toSuiAddress());
  });

  it('returns false when there is no open captoken-issue cell to attest', async () => {
    const board = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
    ]);
    const result = await postAttestation(board, Ed25519Keypair.generate(), { currentEpoch: 0n });
    expect(result).toBe(false);
  });

  it('coerces a wire-number expiresEpoch (JSON round-trip) and still signs — HTTP-board wire-safety', async () => {
    const board = new InMemoryGenericClaimBoard([
      buildCapTokenIssueBoardConfig({ minDistinct: 2, onUnquorumedExpiry: () => {} }),
    ]);
    const cp2 = Ed25519Keypair.generate();
    const roomId = '0x' + '44'.repeat(32);
    const peerPubkey = new Array(32).fill(7);
    const realExpires = 12345n;

    // Build the claim exactly the way the FIXED leader does: canonicalMsgHex from the REAL
    // bigint expiry, but expiresEpoch stored as a NUMBER so the claim is JSON-serializable.
    const msg = buildIssueCanonicalMsg({ roomId, peerPubkey, role: 4, expiresEpoch: realExpires, nonce: 1 });
    const leaderClaim: CapTokenIssueClaim = {
      kind: 'captoken-issue',
      roomId,
      peerPubkey,
      role: 4,
      expiresEpoch: Number(realExpires) as unknown as bigint,
      nonce: 1,
      canonicalMsgHex: Buffer.from(msg).toString('hex'),
    };

    // A raw bigint would throw here; the wire-safe claim round-trips and stays a number.
    const wireClaim = JSON.parse(JSON.stringify(leaderClaim)) as CapTokenIssueClaim;
    expect(typeof (wireClaim as unknown as { expiresEpoch: unknown }).expiresEpoch).toBe('number');

    await board.post(
      'captoken-issue',
      wireClaim,
      { signature: new Array(64).fill(9), pubkey: new Array(32).fill(8), addr: '0xleader' },
      0,
    );

    // Follower must coerce the wire number back to bigint, re-derive, byte-match, and sign.
    const posted = await postAttestation(board, cp2, { currentEpoch: 0n });
    expect(posted).toBe(true);

    const open = await board.listOpen();
    const cell = open.find((c) => c.kind === 'captoken-issue');
    const addrs = (cell!.attestations as Array<{ addr: string }>).map((a) => a.addr);
    expect(addrs).toContain(cp2.toSuiAddress());
  });
});
