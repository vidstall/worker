import { describe, it, expect, vi } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';

// Manual mock (NO importOriginal): the root/scripts package does not declare
// @dvconf/shared, so vitest's resolver cannot load the real module from this
// context (matches the rotate-relay-secret / revoke-cap-token sibling tests). The
// builder under test never calls these; main() never runs here. The named exports
// exist so issue-cap-token-demo.ts's import binding resolves.
vi.mock('@dvconf/shared', () => ({
  executeWithRetry: vi.fn(),
  createSuiClient: vi.fn(),
  createLogger: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadKeypair: vi.fn(),
  extractCreatedObjectByType: vi.fn(),
}));

import { buildIssueDemoTx, buildIssueCanonicalMsg, type IssueDemoArgs } from '../issue-cap-token-demo.js';

const config = {
  packageId: '0x2',
  networkRegistryId: '0x0000000000000000000000000000000000000000000000000000000000000a01',
  cpRegistryId: '0x0000000000000000000000000000000000000000000000000000000000000a02',
  quorumStateId: '0x0000000000000000000000000000000000000000000000000000000000000a03',
} as const;
const args: IssueDemoArgs = {
  roomId: '0x0000000000000000000000000000000000000000000000000000000000000b01',
  peerPubkey: Array(32).fill(1),
  role: 0,
  expiresEpoch: 9999n,
  nonce: 1n,
  signerAddr: '0x0000000000000000000000000000000000000000000000000000000000000c01',
  signature: Array(64).fill(7),
  pubkey: Array(32).fill(9),
  aggregateSig: [0x01, ...Array(64).fill(7)],
};

describe('buildIssueDemoTx', () => {
  it('emits new_quorum_sig + issue_capability_token moveCalls (right targets)', () => {
    const tx = new Transaction();
    buildIssueDemoTx(tx, config, args);
    const moveCalls = tx.getData().commands.filter((c) => c.$kind === 'MoveCall');
    expect(moveCalls).toHaveLength(2);
    const fns = moveCalls.map((c) => (c as { MoveCall: { module: string; function: string } }).MoveCall);
    expect(fns.some((f) => f.module === 'cp_quorum_sig' && f.function === 'new_quorum_sig')).toBe(true);
    expect(fns.some((f) => f.module === 'room_capability' && f.function === 'issue_capability_token')).toBe(true);
  });
});

describe('buildIssueCanonicalMsg (golden vector — drift sentinel vs cap-token-issuer.ts + Move)', () => {
  it('produces the exact 81-byte layout id_to_bytes(roomId)||peerPubkey(32)||role(u8)||u64Le(expires)||u64Le(nonce)', () => {
    // Deterministic fixed input. expiresEpoch 258n = 0x0102 -> LE [2,1,0,0,0,0,0,0]
    // (pins u64Le little-endianness); nonce 3n -> LE [3,0,0,0,0,0,0,0].
    const msg = buildIssueCanonicalMsg({
      roomId: '0x' + '00'.repeat(31) + '01', // 32 bytes, last byte 0x01
      peerPubkey: Array(32).fill(2),
      role: 1,
      expiresEpoch: 258n,
      nonce: 3n,
    });
    const expected = [
      // id_to_bytes(roomId): 31 × 0x00 then 0x01 (32 bytes)
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
      // peerPubkey: 32 × 0x02
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
      2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
      // role: u8 = 1
      1,
      // u64Le(258n) = [2,1,0,0,0,0,0,0]
      2, 1, 0, 0, 0, 0, 0, 0,
      // u64Le(3n) = [3,0,0,0,0,0,0,0]
      3, 0, 0, 0, 0, 0, 0, 0,
    ];
    expect(expected).toHaveLength(81);
    expect(Array.from(msg)).toEqual(expected);
    expect(msg.length).toBe(81);
  });
});
