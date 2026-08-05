import { describe, it, expect, vi, beforeEach } from 'vitest';

// executeWithRetry is mocked so makeGovernanceSubmitter builds a PTB without a chain.
// QuorumSig + NetworkConfig stay real via importOriginal.
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, executeWithRetry: mockExecuteWithRetry };
});

import type { NetworkConfig, QuorumSig } from '@dvconf/shared';
import {
  GovernanceCoordinator,
  buildGovernanceCanonicalMsg,
  makeGovernanceSubmitter,
  ACTION_UPDATE_COOLDOWN,
  ACTION_UPDATE_MAX_IDLE,
  GOVERNANCE_MSG_LEN,
  type QuorumSignatureCollector,
} from '../governance-coordinator.js';

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
    signalingRegistryId: '0xsig',
    roleVoteBoxId: '0xvotebox',
    roleVotingPackageId: '0xrolevotingpkg',
    livenessVoteBoxId: '0xlivenessbox',
  } as NetworkConfig;
}

/** Pino-shaped logger stub (matches the daemon-wide convention). */
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

const SAMPLE_QS: QuorumSig = { signers: ['0xcp1', '0xcp2'], signatures: [[1, 2, 3], [4, 5, 6]] };
const SAMPLE_PUBKEYS = [[9, 9], [8, 8]];

// ── buildGovernanceCanonicalMsg — byte parity with Move build_governance_msg ──
describe('buildGovernanceCanonicalMsg', () => {
  it('produces the 25-byte [action || u64le(new_value) || u64le(nonce) || u64le(epoch)] layout', () => {
    const msg = buildGovernanceCanonicalMsg(ACTION_UPDATE_COOLDOWN, { newValue: 21n, nonce: 0n, epoch: 0n });
    expect(msg.length).toBe(GOVERNANCE_MSG_LEN);
    expect(msg[0]).toBe(1); // action
    expect([...msg.slice(1, 9)]).toEqual([21, 0, 0, 0, 0, 0, 0, 0]); // new_value LE
    expect([...msg.slice(9, 17)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // nonce LE
    expect([...msg.slice(17, 25)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]); // epoch LE
  });

  it('matches the Move-verified gen-governance-sig-fixture COOLDOWN vector byte-for-byte', () => {
    // fixture case COOLDOWN: action=1 new_value=21 nonce=0 epoch=0 — self-verified vs Move EXPECTED_MSG.
    const msg = buildGovernanceCanonicalMsg(1, { newValue: 21n, nonce: 0n, epoch: 0n });
    expect(Buffer.from(msg).toString('hex')).toBe(
      '01' + '1500000000000000' + '0000000000000000' + '0000000000000000',
    );
  });

  it('encodes MAX_IDLE action=2 + multi-byte little-endian values', () => {
    const msg = buildGovernanceCanonicalMsg(ACTION_UPDATE_MAX_IDLE, { newValue: 45n, nonce: 7n, epoch: 256n });
    expect(msg[0]).toBe(2);
    expect([...msg.slice(1, 9)]).toEqual([45, 0, 0, 0, 0, 0, 0, 0]);
    expect([...msg.slice(9, 17)]).toEqual([7, 0, 0, 0, 0, 0, 0, 0]);
    expect([...msg.slice(17, 25)]).toEqual([0, 1, 0, 0, 0, 0, 0, 0]); // 256 LE
  });
});

// ── GovernanceCoordinator — collect-then-submit orchestration ──
describe('GovernanceCoordinator', () => {
  function fakeCollector(qs: QuorumSig = SAMPLE_QS) {
    const calls: Array<{ msg: Uint8Array; threshold: number }> = [];
    const collector: QuorumSignatureCollector = {
      collectQuorumSignatures: vi.fn(async (msg: Uint8Array, threshold: number) => {
        calls.push({ msg, threshold });
        return { qs, pubkeys: SAMPLE_PUBKEYS };
      }),
    };
    return Object.assign(collector, { calls });
  }

  it('proposeCooldownUpdate collects quorum over the COOLDOWN canonical msg then submits (action=1)', async () => {
    const collector = fakeCollector();
    const submitter = vi.fn().mockResolvedValue(undefined);
    const coord = new GovernanceCoordinator(collector, submitter, mockLogger());
    await coord.proposeCooldownUpdate({ newValue: 21n, nonce: 3n, epoch: 100n });

    expect(collector.calls).toHaveLength(1);
    expect([...collector.calls[0]!.msg]).toEqual([
      ...buildGovernanceCanonicalMsg(ACTION_UPDATE_COOLDOWN, { newValue: 21n, nonce: 3n, epoch: 100n }),
    ]);
    expect(collector.calls[0]!.threshold).toBe(2); // default M=2
    expect(submitter).toHaveBeenCalledWith(
      ACTION_UPDATE_COOLDOWN,
      { newValue: 21n, nonce: 3n, epoch: 100n },
      SAMPLE_QS,
      SAMPLE_PUBKEYS,
      expect.any(String),
    );
  });

  it('proposeMaxIdleUpdate submits with action=2 and the collected aggregate sig', async () => {
    const collector = fakeCollector();
    const submitter = vi.fn().mockResolvedValue(undefined);
    await new GovernanceCoordinator(collector, submitter, mockLogger()).proposeMaxIdleUpdate({
      newValue: 45n,
      nonce: 0n,
      epoch: 0n,
    });
    expect(submitter).toHaveBeenCalledWith(
      ACTION_UPDATE_MAX_IDLE,
      expect.objectContaining({ newValue: 45n }),
      SAMPLE_QS,
      SAMPLE_PUBKEYS,
      expect.any(String),
    );
  });

  it('honours a custom quorum threshold', async () => {
    const collector = fakeCollector();
    const coord = new GovernanceCoordinator(collector, vi.fn().mockResolvedValue(undefined), mockLogger(), {
      quorumThreshold: 3,
    });
    await coord.proposeCooldownUpdate({ newValue: 1n, nonce: 0n, epoch: 0n });
    expect(collector.calls[0]!.threshold).toBe(3);
  });

  it('emits structured logs (module: governance-coordinator) with a trace_id on submit', async () => {
    const logger = mockLogger();
    await new GovernanceCoordinator(fakeCollector(), vi.fn().mockResolvedValue(undefined), logger).proposeCooldownUpdate(
      { newValue: 1n, nonce: 0n, epoch: 0n },
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        trace_id: expect.any(String),
        module: 'governance-coordinator',
        action: 'submit_governance',
      }),
      expect.any(String),
    );
  });

  it('propagates a quorum-collection failure and never submits', async () => {
    const collector = {
      collectQuorumSignatures: vi.fn().mockRejectedValue(new Error('quorum-timeout')),
    } as unknown as QuorumSignatureCollector;
    const submitter = vi.fn();
    await expect(
      new GovernanceCoordinator(collector, submitter, mockLogger()).proposeCooldownUpdate({
        newValue: 1n,
        nonce: 0n,
        epoch: 0n,
      }),
    ).rejects.toThrow(/quorum-timeout/);
    expect(submitter).not.toHaveBeenCalled();
  });
});

// ── makeGovernanceSubmitter — locks the PTB shape against role_voting.move ──
describe('makeGovernanceSubmitter', () => {
  // NOTE: block body so beforeEach returns undefined — `mockReset()` returns the
  // mock itself, which vitest would otherwise register as a test-teardown hook and
  // invoke with zero args after each test (spurious failure).
  beforeEach(() => {
    mockExecuteWithRetry.mockReset();
  });

  function captureBuilder(): () => any[] {
    let calls: any[] = [];
    mockExecuteWithRetry.mockImplementation(
      async (_c: unknown, _s: unknown, builder: (tx: any) => void) => {
        calls = [];
        const tx = {
          object: (x: string) => ({ kind: 'object', x }),
          pure: Object.assign((v: unknown) => ({ kind: 'pure', v }), {
            u64: (v: bigint) => ({ kind: 'u64', v }),
            vector: (t: string, v: unknown) => ({ kind: 'vector', t, v }),
          }),
          moveCall: (a: any) => {
            calls.push(a);
            return { kind: 'result', target: a.target };
          },
        };
        builder(tx);
      },
    );
    return () => calls;
  }

  it('builds new_quorum_sig then update_revote_cooldown_epochs with 9 Move args in order', async () => {
    const getCalls = captureBuilder();
    const submit = makeGovernanceSubmitter({} as any, {} as any, mockConfig(), '0xquorumstate', mockLogger());
    await submit(ACTION_UPDATE_COOLDOWN, { newValue: 21n, nonce: 3n, epoch: 100n }, SAMPLE_QS, [[9], [8]], 'trace-1');
    const calls = getCalls();

    expect(calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(calls[1].target).toBe('0xrolevotingpkg::role_voting::update_revote_cooldown_epochs');
    expect(calls[1].arguments).toHaveLength(9);
    expect(calls[1].arguments[0]).toEqual({ kind: 'object', x: '0xreg' }); // net_reg
    expect(calls[1].arguments[1]).toEqual({ kind: 'object', x: '0xvotebox' }); // vote_box
    expect(calls[1].arguments[2]).toEqual({ kind: 'object', x: '0xcp' }); // cp_reg
    expect(calls[1].arguments[3]).toEqual({ kind: 'object', x: '0xquorumstate' }); // quorum_state
    expect(calls[1].arguments[4]).toEqual({ kind: 'result', target: '0xpkg::cp_quorum_sig::new_quorum_sig' }); // qs
    expect(calls[1].arguments[5].kind).toBe('vector'); // signer_pubkeys: vector<vector<u8>>
    expect(calls[1].arguments[6]).toEqual({ kind: 'u64', v: 21n }); // new_value
    expect(calls[1].arguments[7]).toEqual({ kind: 'u64', v: 3n }); // nonce
    expect(calls[1].arguments[8]).toEqual({ kind: 'u64', v: 100n }); // epoch
  });

  it('targets update_max_idle_epochs with the full 9-arg order for ACTION_UPDATE_MAX_IDLE', async () => {
    const getCalls = captureBuilder();
    const submit = makeGovernanceSubmitter({} as any, {} as any, mockConfig(), '0xqs', mockLogger());
    await submit(ACTION_UPDATE_MAX_IDLE, { newValue: 45n, nonce: 1n, epoch: 10n }, SAMPLE_QS, [[1]], 't');
    const calls = getCalls();

    // Distinct values + full arg lock so a swap confined to the MAX_IDLE path cannot escape.
    expect(calls[0].target).toBe('0xpkg::cp_quorum_sig::new_quorum_sig');
    expect(calls[1].target).toBe('0xrolevotingpkg::role_voting::update_max_idle_epochs');
    expect(calls[1].arguments).toHaveLength(9);
    expect(calls[1].arguments[0]).toEqual({ kind: 'object', x: '0xreg' }); // net_reg
    expect(calls[1].arguments[1]).toEqual({ kind: 'object', x: '0xvotebox' }); // vote_box
    expect(calls[1].arguments[2]).toEqual({ kind: 'object', x: '0xcp' }); // cp_reg
    expect(calls[1].arguments[3]).toEqual({ kind: 'object', x: '0xqs' }); // quorum_state
    expect(calls[1].arguments[4]).toEqual({ kind: 'result', target: '0xpkg::cp_quorum_sig::new_quorum_sig' }); // qs
    expect(calls[1].arguments[5].kind).toBe('vector'); // signer_pubkeys
    expect(calls[1].arguments[6]).toEqual({ kind: 'u64', v: 45n }); // new_value
    expect(calls[1].arguments[7]).toEqual({ kind: 'u64', v: 1n }); // nonce
    expect(calls[1].arguments[8]).toEqual({ kind: 'u64', v: 10n }); // epoch
  });

  it('throws on an unknown governance action without submitting', async () => {
    const submit = makeGovernanceSubmitter({} as any, {} as any, mockConfig(), '0xqs', mockLogger());
    await expect(submit(99, { newValue: 1n, nonce: 0n, epoch: 0n }, SAMPLE_QS, [[1]], 't')).rejects.toThrow(
      /unknown governance action/,
    );
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });
});
