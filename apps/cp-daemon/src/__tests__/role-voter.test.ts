import { describe, it, expect, vi, beforeEach } from 'vitest';

// executeWithRetry mocked so the poll loop's castVote can be exercised without a chain.
// MinerRole stays real via importOriginal.
const { mockExecuteWithRetry } = vi.hoisted(() => ({ mockExecuteWithRetry: vi.fn() }));
vi.mock('@dvconf/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dvconf/shared')>();
  return { ...actual, executeWithRetry: mockExecuteWithRetry };
});

import { MinerRole, type NetworkConfig } from '@dvconf/shared';
import {
  trackRevoteCandidate,
  clearRevoteCandidate,
  getRevoteCandidates,
  computeBestRoleForRevote,
  startRoleVoting,
  type RegistryCounts,
} from '../role-voter.js';

function mockLogger() {
  return {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    fatal: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(), level: 'info',
  } as any;
}

function mockConfig(): NetworkConfig {
  return {
    rpcUrl: 'http://localhost:9000', packageId: '0xpkg', networkRegistryId: '0xreg',
    minerStoreId: '0xstore', cpRegistryId: '0xcp', relayRegistryId: '0xrelay',
    validatorRegistryId: '0xval', userRegistryId: '0xuser', roomManagerId: '0xroom',
    signalingRegistryId: '0xsig', roleVoteBoxId: '0xvotebox',
    roleVotingPackageId: '0xrolevotingpkg',
    livenessVoteBoxId: '0xlivenessbox',
  };
}

// ── revoteCandidates tracking (RV-010 done-criteria #1 + #2) ───────────────────
describe('RevoteCandidates tracking (RV-010)', () => {
  it('trackRevoteCandidate adds a miner (simulates RevoteEligibleMarked)', () => {
    trackRevoteCandidate('0xcand-a');
    expect(getRevoteCandidates()).toContain('0xcand-a');
    clearRevoteCandidate('0xcand-a');
  });

  it('clearRevoteCandidate removes a miner (simulates RoleTransitioned cleanup)', () => {
    trackRevoteCandidate('0xcand-b');
    clearRevoteCandidate('0xcand-b');
    expect(getRevoteCandidates()).not.toContain('0xcand-b');
  });

  it('is idempotent on duplicate track + safe when clearing an absent id', () => {
    trackRevoteCandidate('0xcand-c');
    trackRevoteCandidate('0xcand-c');
    expect(getRevoteCandidates().filter((id) => id === '0xcand-c')).toHaveLength(1);
    clearRevoteCandidate('0xcand-c');
    expect(() => clearRevoteCandidate('0xnever')).not.toThrow();
  });
});

// ── computeBestRoleForRevote (RV-010 done-criterion #3, reuses scarcity logic) ──
describe('computeBestRoleForRevote (RV-010)', () => {
  it('returns the scarcest role given registry counts', () => {
    const counts: RegistryCounts = { relay: 10n, validator: 0n, cp: 3n, signaling: 4n };
    expect(computeBestRoleForRevote(counts)).toBe(MinerRole.Validator); // validator scarcest (0)
  });

  it('breaks ties by priority validator > signaling > relay > cp', () => {
    const counts: RegistryCounts = { relay: 5n, validator: 5n, cp: 5n, signaling: 5n };
    expect(computeBestRoleForRevote(counts)).toBe(MinerRole.Validator);
  });

  it('picks signaling when it is the sole scarcest', () => {
    const counts: RegistryCounts = { relay: 9n, validator: 7n, cp: 8n, signaling: 1n };
    expect(computeBestRoleForRevote(counts)).toBe(MinerRole.Signaling);
  });
});

// ── re-vote cast pass through the live poll loop (RV-010 done-criterion: "cast on candidates") ──
describe('startRoleVoting re-vote pass (RV-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRevoteCandidates().forEach(clearRevoteCandidate); // clean module singleton
  });

  /** devInspect returns a BCS u64 (LE) for every active_count read. */
  function clientReturning(count: number): any {
    return {
      devInspectTransactionBlock: vi.fn().mockResolvedValue({
        results: [{ returnValues: [[[count, 0, 0, 0, 0, 0, 0, 0], 'u64']] }],
      }),
    };
  }

  it('casts the scarcest role for a queued re-vote candidate (cast-role-vote TX)', async () => {
    const signer = { toSuiAddress: () => '0xsender' } as any;
    let capturedRole: number | undefined;
    let capturedTarget: string | undefined;
    mockExecuteWithRetry.mockImplementation(
      async (_c: unknown, _s: unknown, builder: (tx: any) => void, label: string) => {
        const calls: any[] = [];
        const tx = {
          object: (x: string) => ({ o: x }),
          pure: { id: (x: string) => ({ id: x }), u8: (n: number) => ({ u8: n }) },
          moveCall: (m: any) => calls.push(m),
        };
        builder(tx);
        capturedTarget = calls[0].target;
        capturedRole = calls[0].arguments[calls[0].arguments.length - 1].u8; // last arg = role u8
        expect(label).toBe('cast-role-vote');
      },
    );

    trackRevoteCandidate('0xrv-poll'); // all counts equal → tie → validator wins
    const stop = startRoleVoting(clientReturning(5), signer, mockConfig(), '0xcap', mockLogger(), 60_000);
    await vi.waitFor(() => expect(mockExecuteWithRetry).toHaveBeenCalled());
    stop();

    expect(capturedTarget).toBe('0xrolevotingpkg::role_voting::cast_role_vote');
    expect(capturedRole).toBe(MinerRole.Validator);
    clearRevoteCandidate('0xrv-poll');
  });

  it('skips the re-vote cast when there are no candidates (no TX)', async () => {
    const signer = { toSuiAddress: () => '0xsender' } as any;
    const stop = startRoleVoting(clientReturning(5), signer, mockConfig(), '0xcap', mockLogger(), 60_000);
    // give the immediate poll a chance to run
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });
});

// ── reconciliation against on-chain truth (self-heal when a MinerRegistered
// event was missed, e.g. this daemon started after the event fired) ──
describe('startRoleVoting on-chain reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getRevoteCandidates().forEach(clearRevoteCandidate);
  });

  const MINER_ID = '0x' + '7'.repeat(64);
  const U64_BYTES = (n: number) => [n, 0, 0, 0, 0, 0, 0, 0];
  // BCS vector<address>: ULEB128 length prefix (1) + one 32-byte address.
  const idVectorBytes = () => [1, ...Array.from({ length: 32 }, () => 0x77)];

  it('backfills and votes a miner discovered only via on-chain reconciliation', async () => {
    const signer = { toSuiAddress: () => '0xsender' } as any;
    let capturedTarget: string | undefined;
    let capturedMinerIdArg: string | undefined;
    mockExecuteWithRetry.mockImplementation(
      async (_c: unknown, _s: unknown, builder: (tx: any) => void, label: string) => {
        const calls: any[] = [];
        const tx = {
          object: (x: string) => ({ o: x }),
          pure: { id: (x: string) => ({ id: x }), u8: (n: number) => ({ u8: n }) },
          moveCall: (m: any) => calls.push(m),
        };
        builder(tx);
        capturedTarget = calls[0].target;
        capturedMinerIdArg = calls[0].arguments[calls[0].arguments.length - 2].id; // second-to-last = miner_id
        expect(label).toBe('cast-role-vote');
      },
    );

    const devInspectTransactionBlock = vi
      .fn()
      // 0. reconcile: get_unassigned_miners -> one miner
      .mockResolvedValueOnce({ results: [{ returnValues: [[idVectorBytes(), 'vector<address>']] }] })
      // 1-4. readRegistryCounts (relay/validator/cp/signaling)
      .mockResolvedValueOnce({ results: [{ returnValues: [[U64_BYTES(5), 'u64']] }] })
      .mockResolvedValueOnce({ results: [{ returnValues: [[U64_BYTES(5), 'u64']] }] })
      .mockResolvedValueOnce({ results: [{ returnValues: [[U64_BYTES(5), 'u64']] }] })
      .mockResolvedValueOnce({ results: [{ returnValues: [[U64_BYTES(5), 'u64']] }] })
      // 5. readMinerBandwidth -> 0 (not relay)
      .mockResolvedValueOnce({ results: [{ returnValues: [[U64_BYTES(0), 'u64']] }] })
      // 6. readMinerCpuCores -> 0 (validator)
      .mockResolvedValueOnce({ results: [{ returnValues: [[U64_BYTES(0), 'u64']] }] });

    const client = { devInspectTransactionBlock } as any;
    const stop = startRoleVoting(client, signer, mockConfig(), '0xcap', mockLogger(), 60_000);
    await vi.waitFor(() => expect(mockExecuteWithRetry).toHaveBeenCalled());
    stop();

    expect(capturedTarget).toBe('0xrolevotingpkg::role_voting::cast_role_vote');
    expect(capturedMinerIdArg?.toLowerCase()).toBe(MINER_ID.toLowerCase());
  });

  it('does not resubmit a vote for a miner already tracked/voted (dedup against reconciliation)', async () => {
    const signer = { toSuiAddress: () => '0xsender' } as any;
    const devInspectTransactionBlock = vi.fn().mockResolvedValue({
      results: [{ returnValues: [[[0], 'vector<address>']] }], // empty vector<ID>
    });
    const client = { devInspectTransactionBlock } as any;
    const stop = startRoleVoting(client, signer, mockConfig(), '0xcap', mockLogger(), 60_000);
    await new Promise((r) => setTimeout(r, 20));
    stop();
    expect(mockExecuteWithRetry).not.toHaveBeenCalled();
  });
});
