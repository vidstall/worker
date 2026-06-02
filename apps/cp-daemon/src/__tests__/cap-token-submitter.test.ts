import { describe, it, expect, vi, beforeEach } from 'vitest';

// executeWithRetry is mocked so the submitter builds a PTB without a chain.
// QuorumSig + the rest of @dvconf/shared stay real via importOriginal.
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, executeWithRetry: mockExecuteWithRetry };
});

import {
  CAP_TOKEN_LABELS,
  buildIssueCapTokenTx,
  buildRefreshCapTokenTx,
  buildRevokeCapTokenTx,
  makeCapTokenSubmitter,
} from '../cap-token-submitter.js';

/** Pino-shaped logger stub (daemon-wide convention). */
function mockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  } as any;
}

// PTB fake: records moveCalls, returns a threadable sentinel per call (so a result
// threaded into a later call's arguments is identity-comparable). Mirrors the
// governance-coordinator + revoke-cap-token test fakes. `pure.address` added for the
// issue entry's `room_id: address` Move param.
function fakeTx() {
  const calls: any[] = [];
  const tx = {
    object: (x: string) => ({ kind: 'object', x }),
    pure: {
      u8: (v: number) => ({ kind: 'pure', t: 'u8', v }),
      u64: (v: bigint) => ({ kind: 'pure', t: 'u64', v }),
      address: (v: string) => ({ kind: 'pure', t: 'address', v }),
      vector: (t: string, v: unknown) => ({ kind: 'pure', t: `vector<${t}>`, v }),
    },
    moveCall: (a: any) => {
      calls.push(a);
      return { kind: 'result', of: a.target };
    },
  } as any;
  return { tx, calls };
}

const PKG = '0xpkg';
const SAMPLE_QS = { signers: ['0xcp1'], signatures: [[7, 7, 7]] };
const SAMPLE_PUBKEYS = [[9, 9]];
const SAMPLE_AGG = [0x01, 7, 7, 7];

const ISSUE_ARGS = {
  target: `${PKG}::room_capability::issue_capability_token`,
  networkRegistryId: '0xreg',
  cpRegistryObjectId: '0xcp',
  quorumStateObjectId: '0xquorum',
  roomId: '0xroom',
  peerId: '0xpeerid',
  peerPubkey: [1, 2, 3],
  role: 2,
  expiresEpoch: 100n,
  nonce: 1,
  cpQuorumProof: SAMPLE_QS,
  signerPubkeys: SAMPLE_PUBKEYS,
  aggregateSig: SAMPLE_AGG,
  canonicalMsg: [4, 5, 6],
};

const REFRESH_ARGS = {
  target: `${PKG}::room_capability::refresh_capability_token`,
  networkRegistryId: '0xreg',
  cpRegistryObjectId: '0xcp',
  quorumStateObjectId: '0xquorum',
  oldTokenId: '0xtoken',
  newRole: 3,
  newExpiresEpoch: 100n,
  refreshNonce: 2,
  cpQuorumProof: SAMPLE_QS,
  signerPubkeys: SAMPLE_PUBKEYS,
  aggregateSig: SAMPLE_AGG,
  canonicalMsg: [4, 5, 6],
};

const REVOKE_ARGS = {
  target: `${PKG}::room_capability::revoke_capability_token_via_quorum`,
  networkRegistryId: '0xreg',
  cpRegistryObjectId: '0xcp',
  quorumStateObjectId: '0xquorum',
  capObjectId: '0xcap',
  reason: 1,
  cpQuorumProof: SAMPLE_QS,
  signerPubkeys: SAMPLE_PUBKEYS,
  canonicalMsg: [4, 5, 6],
};

// ── buildIssueCapTokenTx — locks the 11-arg PTB vs room_capability.move:444 ──
describe('buildIssueCapTokenTx', () => {
  it('builds new_quorum_sig then issue_capability_token with the 11 args in exact Move order', () => {
    const { tx, calls } = fakeTx();
    buildIssueCapTokenTx(tx, ISSUE_ARGS);

    expect(calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(calls[0].arguments).toEqual([
      { kind: 'pure', t: 'vector<address>', v: SAMPLE_QS.signers },
      { kind: 'pure', t: 'vector<vector<u8>>', v: SAMPLE_QS.signatures },
    ]);

    expect(calls[1].target).toBe('0xpkg::room_capability::issue_capability_token');
    expect(calls[1].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // registry: &NetworkRegistry
      { kind: 'object', x: '0xcp' }, // cp_reg: &ControlPlaneRegistry
      { kind: 'object', x: '0xquorum' }, // quorum_state: &QuorumConfigState
      { kind: 'pure', t: 'address', v: '0xroom' }, // room_id: address (NOT tx.object)
      { kind: 'pure', t: 'vector<u8>', v: [1, 2, 3] }, // peer_pubkey: vector<u8>
      { kind: 'pure', t: 'u8', v: 2 }, // role: u8
      { kind: 'pure', t: 'u64', v: 100n }, // expires_epoch: u64
      { kind: 'pure', t: 'u64', v: 1n }, // nonce: u64 (coerced from number)
      { kind: 'result', of: '0xpkg::cp_quorum_sig::new_quorum_sig' }, // qs: QuorumSig (threaded)
      { kind: 'pure', t: 'vector<vector<u8>>', v: SAMPLE_PUBKEYS }, // signer_pubkeys
      { kind: 'pure', t: 'vector<u8>', v: SAMPLE_AGG }, // aggregate_sig
    ]);
  });
});

// ── buildRefreshCapTokenTx — locks the 9-arg PTB vs room_capability.move:975 ──
// NOTE: refresh takes NO nonce PTB arg (on-chain reads the stored token nonce);
// refreshNonce only feeds the off-chain canonical message.
describe('buildRefreshCapTokenTx', () => {
  it('builds new_quorum_sig then refresh_capability_token with the 9 args in exact order (no nonce arg)', () => {
    const { tx, calls } = fakeTx();
    buildRefreshCapTokenTx(tx, REFRESH_ARGS);

    expect(calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(calls[1].target).toBe('0xpkg::room_capability::refresh_capability_token');
    expect(calls[1].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // registry
      { kind: 'object', x: '0xcp' }, // cp_reg
      { kind: 'object', x: '0xquorum' }, // quorum_state
      { kind: 'object', x: '0xtoken' }, // old_token: &mut RoomCapability
      { kind: 'pure', t: 'u8', v: 3 }, // new_role: u8
      { kind: 'pure', t: 'u64', v: 100n }, // new_expires_epoch: u64
      { kind: 'result', of: '0xpkg::cp_quorum_sig::new_quorum_sig' }, // cp_quorum_proof
      { kind: 'pure', t: 'vector<vector<u8>>', v: SAMPLE_PUBKEYS }, // signer_pubkeys
      { kind: 'pure', t: 'vector<u8>', v: SAMPLE_AGG }, // aggregate_sig
    ]);
  });
});

// ── buildRevokeCapTokenTx — locks the 7-arg PTB vs room_capability.move:586 ──
// NOTE: revoke takes NO aggregate_sig (D-011); only issue + refresh do.
describe('buildRevokeCapTokenTx', () => {
  it('builds new_quorum_sig then revoke_capability_token_via_quorum with the 7 args in exact order (no aggregate_sig)', () => {
    const { tx, calls } = fakeTx();
    buildRevokeCapTokenTx(tx, REVOKE_ARGS);

    expect(calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(calls[1].target).toBe('0xpkg::room_capability::revoke_capability_token_via_quorum');
    expect(calls[1].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // registry
      { kind: 'object', x: '0xcp' }, // cp_reg
      { kind: 'object', x: '0xquorum' }, // quorum_state
      { kind: 'object', x: '0xcap' }, // cap: &mut RoomCapability
      { kind: 'pure', t: 'u8', v: 1 }, // reason: u8
      { kind: 'result', of: '0xpkg::cp_quorum_sig::new_quorum_sig' }, // qs
      { kind: 'pure', t: 'vector<vector<u8>>', v: SAMPLE_PUBKEYS }, // signer_pubkeys
    ]);
  });
});

// ── makeCapTokenSubmitter — dispatch by label, return digest, surface errors ──
describe('makeCapTokenSubmitter', () => {
  // block body so beforeEach returns undefined (mockReset() returns the mock, which
  // vitest would otherwise treat as a teardown hook).
  beforeEach(() => {
    mockExecuteWithRetry.mockReset();
  });

  /** Capture the PTB the submitter builds + the label passed to executeWithRetry. */
  function captureBuilder(returnVal: unknown = { digest: '0xdigest' }) {
    let captured: { calls: any[]; label: string } | undefined;
    mockExecuteWithRetry.mockImplementation(
      async (_c: unknown, _s: unknown, builder: (tx: any) => void, label: string) => {
        const { tx, calls } = fakeTx();
        builder(tx);
        captured = { calls, label };
        return returnVal;
      },
    );
    return () => captured!;
  }

  it('dispatches the issue label to the issue PTB and returns the on-chain digest', async () => {
    const get = captureBuilder({ digest: '0xissue' });
    const submit = makeCapTokenSubmitter({} as any, {} as any, mockLogger());
    const res = await submit({ label: CAP_TOKEN_LABELS.ISSUE, args: ISSUE_ARGS });

    expect(res).toEqual({ digest: '0xissue' });
    expect(get().label).toBe('cap-token-issue-capability-token');
    expect(get().calls[1].target).toBe('0xpkg::room_capability::issue_capability_token');
  });

  it('dispatches the refresh label to the refresh PTB', async () => {
    const get = captureBuilder();
    const submit = makeCapTokenSubmitter({} as any, {} as any, mockLogger());
    await submit({ label: CAP_TOKEN_LABELS.REFRESH, args: REFRESH_ARGS });
    expect(get().calls[1].target).toBe('0xpkg::room_capability::refresh_capability_token');
  });

  it('dispatches the revoke label to the revoke PTB', async () => {
    const get = captureBuilder();
    const submit = makeCapTokenSubmitter({} as any, {} as any, mockLogger());
    await submit({ label: CAP_TOKEN_LABELS.REVOKE, args: REVOKE_ARGS });
    expect(get().calls[1].target).toBe('0xpkg::room_capability::revoke_capability_token_via_quorum');
  });

  it('emits a structured confirmation log (module: cap-token-submitter, trace_id) on success', async () => {
    captureBuilder({ digest: '0xdig' });
    const logger = mockLogger();
    await makeCapTokenSubmitter({} as any, {} as any, logger)({
      label: CAP_TOKEN_LABELS.ISSUE,
      args: ISSUE_ARGS,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: expect.any(String),
        module: 'cap-token-submitter',
        action: 'submit_cap_token',
        context: expect.objectContaining({ label: CAP_TOKEN_LABELS.ISSUE, digest: '0xdig' }),
      }),
      expect.any(String),
    );
  });

  it('throws on an unknown label without ever calling executeWithRetry', async () => {
    const submit = makeCapTokenSubmitter({} as any, {} as any, mockLogger());
    await expect(submit({ label: 'mint-the-moon', args: {} })).rejects.toThrow(/unknown.*label|mint-the-moon/);
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });

  it('throws when executeWithRetry exhausts retries (returns null)', async () => {
    mockExecuteWithRetry.mockResolvedValue(null);
    const submit = makeCapTokenSubmitter({} as any, {} as any, mockLogger());
    await expect(submit({ label: CAP_TOKEN_LABELS.ISSUE, args: ISSUE_ARGS })).rejects.toThrow(
      /retr|exhaust/i,
    );
  });

  it('propagates an executeWithRetry rejection (e.g. on-chain MoveAbort) without swallowing it', async () => {
    mockExecuteWithRetry.mockRejectedValue(
      new Error('MoveAbort in room_capability::issue_capability_token: e_token_already_revoked (907)'),
    );
    const logger = mockLogger();
    await expect(
      makeCapTokenSubmitter({} as any, {} as any, logger)({
        label: CAP_TOKEN_LABELS.ISSUE,
        args: ISSUE_ARGS,
      }),
    ).rejects.toThrow(/907|already_revoked/);
    expect(logger.info).not.toHaveBeenCalled(); // no success log when the submit aborts
  });
});
