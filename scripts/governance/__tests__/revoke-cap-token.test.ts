import { describe, it, expect, vi, beforeEach } from 'vitest';

// Manual mock (NO importOriginal): the root/scripts package does not declare
// @dvconf/shared, so vitest's resolver cannot load the real module from this
// context. We only need executeWithRetry at runtime; the other named exports exist
// so revoke-cap-token.ts's import binding resolves (its main() never runs here).
// QuorumSig is a type-only import (erased) -> no runtime mock entry needed.
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', () => ({
  executeWithRetry: mockExecuteWithRetry,
  createSuiClient: vi.fn(),
  createLogger: vi.fn(),
  loadNetworkConfig: vi.fn(),
  loadKeypair: vi.fn(),
}));

import type { NetworkConfig } from '@dvconf/shared';
import {
  REVOKE_REASON,
  assertValidRevokeReason,
  buildRevokeCanonicalMsg,
  buildRevokeCapTokenTx,
  submitRevokeCapToken,
  makeSingleCpKeystore,
  parseFlag,
} from '../revoke-cap-token.js';

function mockConfig(): NetworkConfig {
  return {
    rpcUrl: 'http://localhost:9000',
    packageId: '0xpkg',
    networkRegistryId: '0xreg',
    minerStoreId: '0xstore',
    cpRegistryId: '0xcp',
    relayRegistryId: '0xrelay',
    validatorRegistryId: '0xval',
    userRegistryId: '0xuser',
    roomManagerId: '0xroom',
    roleVoteBoxId: '0xvotebox',
    roleVotingPackageId: '0xrolevotingpkg',
    livenessVoteBoxId: '0xlivenessbox',
  } as NetworkConfig;
}

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

// A PTB fake that records moveCalls and returns a threadable sentinel for each
// (so a result threaded into a later call's arguments is identity-comparable).
function fakeTx() {
  const calls: any[] = [];
  const tx = {
    object: (x: string) => ({ kind: 'object', x }),
    pure: {
      u8: (v: number) => ({ kind: 'pure', t: 'u8', v }),
      vector: (t: string, v: unknown) => ({ kind: 'pure', t: `vector<${t}>`, v }),
    },
    moveCall: (a: any) => {
      calls.push(a);
      return { kind: 'result', of: a.target };
    },
  } as any;
  return { tx, calls };
}

const SAMPLE_QS = { signers: ['0xcp1'], signatures: [[1, 2, 3]] };
const SAMPLE_PUBKEYS = [[9, 9, 9]];

// ── assertValidRevokeReason (REQ-CRR-002: reason maps the enum 0/1/2) ──
describe('assertValidRevokeReason', () => {
  it('accepts the three enum values 0=normal/1=slash/2=admin', () => {
    expect(() => assertValidRevokeReason(REVOKE_REASON.NORMAL)).not.toThrow();
    expect(() => assertValidRevokeReason(REVOKE_REASON.SLASH)).not.toThrow();
    expect(() => assertValidRevokeReason(REVOKE_REASON.ADMIN)).not.toThrow();
  });
  it('rejects out-of-enum / non-integer reasons before submit', () => {
    expect(() => assertValidRevokeReason(3)).toThrow();
    expect(() => assertValidRevokeReason(-1)).toThrow();
    expect(() => assertValidRevokeReason(1.5)).toThrow();
    expect(() => assertValidRevokeReason(Number.NaN)).toThrow();
  });
});

// ── buildRevokeCanonicalMsg: BCS(cap_object_id || reason), byte-parity w/ Move ──
// (room_capability.move:601-605: id_to_bytes(cap) ++ [reason])
describe('buildRevokeCanonicalMsg', () => {
  it('produces 32-byte cap id followed by the 1-byte reason', () => {
    const capId = '0x' + 'ab'.repeat(32); // 32 bytes
    const msg = buildRevokeCanonicalMsg(capId, REVOKE_REASON.ADMIN);
    expect(msg.length).toBe(33);
    expect(Array.from(msg.slice(0, 32))).toEqual(new Array(32).fill(0xab));
    expect(msg[32]).toBe(REVOKE_REASON.ADMIN); // 2
  });
});

// ── buildRevokeCapTokenTx — locks the PTB shape vs room_capability.move:586 ──
describe('buildRevokeCapTokenTx', () => {
  it('builds new_quorum_sig then revoke_capability_token_via_quorum with the 7 args in exact order', () => {
    const { tx, calls } = fakeTx();
    buildRevokeCapTokenTx(tx, mockConfig(), {
      quorumStateId: '0xquorum',
      capId: '0xcap',
      reason: REVOKE_REASON.SLASH,
      qs: SAMPLE_QS,
      signerPubkeys: SAMPLE_PUBKEYS,
    });

    // First call constructs the QuorumSig value from parallel arrays.
    expect(calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(calls[0].arguments).toEqual([
      { kind: 'pure', t: 'vector<address>', v: SAMPLE_QS.signers },
      { kind: 'pure', t: 'vector<vector<u8>>', v: SAMPLE_QS.signatures },
    ]);

    // Second call: the revoke entry, threading the QuorumSig result at arg 6.
    expect(calls[1].target).toBe('0xpkg::room_capability::revoke_capability_token_via_quorum');
    expect(calls[1].arguments).toEqual([
      { kind: 'object', x: '0xreg' }, // registry: &NetworkRegistry
      { kind: 'object', x: '0xcp' }, // cp_reg: &ControlPlaneRegistry
      { kind: 'object', x: '0xquorum' }, // quorum_state: &QuorumConfigState
      { kind: 'object', x: '0xcap' }, // cap: &mut RoomCapability
      { kind: 'pure', t: 'u8', v: REVOKE_REASON.SLASH }, // reason: u8
      { kind: 'result', of: '0xpkg::cp_quorum_sig::new_quorum_sig' }, // qs: QuorumSig (threaded)
      { kind: 'pure', t: 'vector<vector<u8>>', v: SAMPLE_PUBKEYS }, // signer_pubkeys
    ]);
  });

  it('throws on an out-of-enum reason before emitting any moveCall', () => {
    const { tx, calls } = fakeTx();
    expect(() =>
      buildRevokeCapTokenTx(tx, mockConfig(), {
        quorumStateId: '0xquorum',
        capId: '0xcap',
        reason: 7,
        qs: SAMPLE_QS,
        signerPubkeys: SAMPLE_PUBKEYS,
      }),
    ).toThrow();
    expect(calls).toHaveLength(0);
  });
});

// ── submitRevokeCapToken — collect quorum -> build -> submit -> structured log ──
describe('submitRevokeCapToken', () => {
  beforeEach(() => {
    mockExecuteWithRetry.mockReset();
  });

  it('collects the quorum over the revoke canonical msg, submits the correct PTB, logs structured confirmation', async () => {
    let captured: { calls: any[]; label: string } | undefined;
    mockExecuteWithRetry.mockImplementation(
      async (_c: unknown, _s: unknown, builder: (tx: any) => void, label: string) => {
        const { tx, calls } = fakeTx();
        builder(tx);
        captured = { calls, label };
      },
    );
    const keystore = {
      collectQuorumSignatures: vi.fn(async () => ({ qs: SAMPLE_QS, pubkeys: SAMPLE_PUBKEYS })),
    };
    const logger = mockLogger();
    await submitRevokeCapToken(
      {} as any,
      {} as any,
      mockConfig(),
      { quorumStateId: '0xquorum', capId: '0xcap', reason: REVOKE_REASON.NORMAL, threshold: 1 },
      keystore,
      logger,
    );

    // quorum collected over the revoke canonical message (reason as the trailing
    // byte) at threshold 1. Byte-length parity is pinned by the buildRevokeCanonicalMsg
    // test with a real 32-byte id; here capId is a short stub.
    const [msgArg, thrArg] = keystore.collectQuorumSignatures.mock.calls[0];
    expect(msgArg).toBeInstanceOf(Uint8Array);
    expect((msgArg as Uint8Array)[(msgArg as Uint8Array).length - 1]).toBe(REVOKE_REASON.NORMAL);
    expect(thrArg).toBe(1);

    expect(captured!.label).toBe('revoke-cap-token');
    expect(captured!.calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(captured!.calls[1].target).toBe(
      '0xpkg::room_capability::revoke_capability_token_via_quorum',
    );

    // REQ-CRR-002 exact log shape.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: expect.any(String),
        module: 'cap-token-revoke',
        action: 'revoke_cap_token',
        context: expect.objectContaining({ capId: '0xcap', reason: REVOKE_REASON.NORMAL }),
      }),
      expect.any(String),
    );
  });

  it('propagates an executeWithRetry rejection (e.g. on-chain E_TOKEN_ALREADY_REVOKED=907) without swallowing it', async () => {
    // Simulate the on-chain idempotency abort surfacing through executeWithRetry.
    mockExecuteWithRetry.mockRejectedValue(
      new Error('MoveAbort in room_capability::revoke_capability_token_via_quorum: e_token_already_revoked (907)'),
    );
    const keystore = {
      collectQuorumSignatures: vi.fn(async () => ({ qs: SAMPLE_QS, pubkeys: SAMPLE_PUBKEYS })),
    };
    const logger = mockLogger();
    await expect(
      submitRevokeCapToken(
        {} as any,
        {} as any,
        mockConfig(),
        { quorumStateId: '0xquorum', capId: '0xcap', reason: REVOKE_REASON.NORMAL, threshold: 1 },
        keystore,
        logger,
      ),
    ).rejects.toThrow(/907|already_revoked/);
    // the success confirmation log MUST NOT fire when the submit aborts (not swallowed).
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('rejects an out-of-enum reason before collecting signatures or submitting', async () => {
    const keystore = { collectQuorumSignatures: vi.fn() };
    await expect(
      submitRevokeCapToken(
        {} as any,
        {} as any,
        mockConfig(),
        { quorumStateId: '0xquorum', capId: '0xcap', reason: 9, threshold: 1 },
        keystore,
        mockLogger(),
      ),
    ).rejects.toThrow();
    expect(keystore.collectQuorumSignatures).not.toHaveBeenCalled();
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });
});

// ── makeSingleCpKeystore — single-CP path signs raw ed25519; >=2 throws (D-014) ──
describe('makeSingleCpKeystore', () => {
  function mockSigner() {
    return {
      // raw 64-byte ed25519 sig (NO Sui intent wrap) — matches Move verify_quorum
      // and gen-governance-sig-fixture.ts:76, NOT index.ts signPersonalMessage.
      sign: vi.fn(async (_msg: Uint8Array) => new Uint8Array(64).fill(7)),
      getPublicKey: () => ({ toRawBytes: () => new Uint8Array(32).fill(9) }),
      toSuiAddress: () => '0xcpaddr',
    } as any;
  }

  it('signs the canonical msg with the local CP key for a single-CP (threshold 1) quorum', async () => {
    const signer = mockSigner();
    const ks = makeSingleCpKeystore(signer);
    const { qs, pubkeys } = await ks.collectQuorumSignatures(new Uint8Array([1, 2, 3]), 1);
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(qs.signers).toEqual(['0xcpaddr']);
    expect(qs.signatures).toEqual([new Array(64).fill(7)]);
    expect(pubkeys).toEqual([new Array(32).fill(9)]);
  });

  it('throws cleanly when threshold >= 2 (multi-CP peer discovery deferred, D-014)', async () => {
    const ks = makeSingleCpKeystore(mockSigner());
    await expect(ks.collectQuorumSignatures(new Uint8Array([1]), 2)).rejects.toThrow(/D-014|peer-CP|multi-CP/);
  });
});

// ── parseFlag — generic CLI flag extraction ──
describe('parseFlag', () => {
  it('extracts the value following a flag', () => {
    expect(parseFlag(['--cap-token', '0xabc'], '--cap-token')).toBe('0xabc');
    expect(parseFlag(['--reason', '2'], '--reason')).toBe('2');
  });
  it('returns null when the flag is absent', () => {
    expect(parseFlag(['--other', 'x'], '--cap-token')).toBeNull();
  });
  it('returns null when the flag has no following value', () => {
    expect(parseFlag(['--cap-token', '--next'], '--cap-token')).toBeNull();
  });
});
