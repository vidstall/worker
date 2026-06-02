/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer tests (RED-first → GREEN).
 *
 * REQ-IDs:
 *   - REQ-ADM-001 — token issuance on RoomAssigned (real event name per D-010-A)
 *   - REQ-ADM-003 — M-of-N quorum collection (M=2/N=3 per D-B4)
 *   - REQ-ADM-006 — structured JSON logging via pino
 *
 * Real event names per DECISIONS § D-010-A + CONTRACTS § 4.6:
 *   - room_manager::RoomAssigned      (NOT "PairingProposalFinalized")
 *   - miner::registration::RoleChanged
 *   - role_voting::RoleAssigned
 *   - economic_layer::RelaySlashed
 *
 * Pattern follows turn-issuer.test.ts: SubmitFn DI + mockLogger() helper +
 * in-memory state assertions + vi.useFakeTimers() where time matters.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CapTokenIssuer,
  type SubmitFn,
  type SubmitResult,
  type CpKeystore,
  type RoomAssignedEvent,
  type RoleChangedEvent,
  type RoleAssignedEvent,
  type RelaySlashedEvent,
} from '../cap-token-issuer.js';

/** Match the existing cp-daemon test convention (turn-issuer/event-handler/role-voter style). */
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

/** Build a CpKeystore mock that collects M-of-N signatures successfully. */
function makeKeystoreOk(opts?: {
  cpAddress?: string;
  threshold?: number;
}): { keystore: CpKeystore; collectCalls: Array<{ msg: Uint8Array; threshold: number }> } {
  const collectCalls: Array<{ msg: Uint8Array; threshold: number }> = [];
  const keystore: CpKeystore = {
    async sign(message) {
      return {
        signature: Array.from(message.slice(0, 64)),
        pubkey: new Array(32).fill(0xaa),
        addr: opts?.cpAddress ?? '0xcp1',
      };
    },
    getCpAddress() {
      return opts?.cpAddress ?? '0xcp1';
    },
    async collectQuorumSignatures(canonicalMsg, threshold) {
      collectCalls.push({ msg: canonicalMsg, threshold });
      // Synthesize a valid M=threshold quorum: build (threshold) signers + sigs + pubkeys.
      const signers: string[] = [];
      const signatures: number[][] = [];
      const pubkeys: number[][] = [];
      for (let i = 0; i < threshold; i++) {
        signers.push(`0xcp${i + 1}`);
        signatures.push(new Array(64).fill(0xab + i));
        pubkeys.push(new Array(32).fill(0xaa + i));
      }
      // D-011: aggregate_sig is the BCS-serialized QuorumSig blob stored on-chain.
      // Production keystores will use @mysten/bcs to encode the real struct; tests
      // use a deterministic synthetic blob distinct from any single signature so
      // assertions can verify the issuer is forwarding it (not duplicating sig[0]).
      const aggregateSig = [0xff, threshold, ...signatures.flat()];
      return { qs: { signers, signatures }, pubkeys, aggregateSig };
    },
  };
  return { keystore, collectCalls };
}

/** Build a CpKeystore mock that fails to collect quorum (returns < M signers). */
function makeKeystoreInsufficient(): CpKeystore {
  return {
    async sign(message) {
      return {
        signature: Array.from(message.slice(0, 64)),
        pubkey: new Array(32).fill(0xaa),
        addr: '0xcp1',
      };
    },
    getCpAddress() {
      return '0xcp1';
    },
    async collectQuorumSignatures(_canonicalMsg, _threshold) {
      // Simulate only 1 CP reachable when 2 required: throw the standard timeout error.
      throw new Error('quorum collection timeout: only 1/2 CPs responded');
    },
  };
}

function mkSubmit(): {
  submitFn: SubmitFn;
  calls: Array<{ label: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ label: string; args: Record<string, unknown> }> = [];
  const submitFn: SubmitFn = vi.fn(
    async (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult> => {
      calls.push({ label: opts.label, args: opts.args });
      return { digest: `tx-${calls.length}` };
    },
  );
  return { submitFn, calls };
}

function mkIssuer(overrides?: {
  submitFn?: SubmitFn;
  keystore?: CpKeystore;
  logger?: any;
}): CapTokenIssuer {
  const submitFn = overrides?.submitFn ?? mkSubmit().submitFn;
  const keystore = overrides?.keystore ?? makeKeystoreOk().keystore;
  return new CapTokenIssuer({
    submitFn,
    packageId: '0xpkg',
    networkRegistryId: '0xnet',
    cpRegistryObjectId: '0xcpreg',
    quorumStateObjectId: '0xquorum',
    cpKeystore: keystore,
    logger: overrides?.logger ?? mockLogger(),
    quorumThreshold: 2, // M=2 per D-B4
  });
}

// ── Test data fixtures ───────────────────────────────────────────────────

const ROOM_ASSIGNED: RoomAssignedEvent = {
  roomId: '0xroom1',
  relayIds: ['0xrelay1', '0xrelay2'],
  signalingId: '0xsig1',
  relayMode: 1, // SFU
  verifiedScore: '950',
  consensusReached: true,
  winningCp: '0xcp1',
  validatorIds: ['0xval1', '0xval2'],
};

const ROLE_CHANGED: RoleChangedEvent = {
  minerId: '0xminer1',
  oldRole: 2, // relay
  newRole: 4, // signaling
  newStake: '1000000000',
};

const ROLE_ASSIGNED: RoleAssignedEvent = {
  minerId: '0xminer1',
  role: 4, // signaling
  voteCount: '3',
  threshold: '2',
};

const RELAY_SLASHED: RelaySlashedEvent = {
  roomId: '0xroom1',
  relayMinerId: '0xrelay-bad',
  slashAmount: '500000000',
};

// ── REQ-ADM-001 — Issuance on RoomAssigned ───────────────────────────────

describe('CapTokenIssuer.onRoomAssigned (REQ-ADM-001)', () => {
  it('issues capability tokens on RoomAssigned — one TX per peer (relays + signaling + validators)', async () => {
    const { submitFn, calls } = mkSubmit();
    const issuer = mkIssuer({ submitFn });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-001');

    // 2 relays + 1 signaling + 2 validators = 5 peers
    expect(calls).toHaveLength(5);
    // All calls target issue_capability_token
    for (const c of calls) {
      expect(c.label).toBe('issue-capability-token');
      expect(c.args.target).toBe('0xpkg::room_capability::issue_capability_token');
      expect(c.args.roomId).toBe('0xroom1');
    }
  });

  it('emits structured info log on event received with trace_id + module + context', async () => {
    const logger = mockLogger();
    const issuer = mkIssuer({ logger });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-002');

    // First info call should carry trace_id + module + event_name
    expect(logger.info).toHaveBeenCalled();
    const firstCall = (logger.info.mock.calls as any[]).find(
      (c) => c[1] === 'RoomAssigned received',
    );
    expect(firstCall).toBeDefined();
    expect(firstCall[0]).toMatchObject({
      trace_id: 'trace-002',
      module: 'cap-token-issuer',
    });
  });

  it('skips silently on duplicate RoomAssigned event (idempotency by room_id::pairing-finalize key)', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-003a');
    expect(calls).toHaveLength(5);

    // Same event delivered again
    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-003b');
    expect(calls).toHaveLength(5); // no new TXs

    // Dedupe warn log emitted
    const dedupeWarn = (logger.warn.mock.calls as any[]).find(
      (c) =>
        c[0]?.context?.dedupe_key === '0xroom1::pairing-finalize' ||
        c[0]?.dedupe_key === '0xroom1::pairing-finalize',
    );
    expect(dedupeWarn).toBeDefined();
  });
});

// ── REQ-ADM-003 — M-of-N quorum collection ───────────────────────────────

describe('CapTokenIssuer M-of-N quorum (REQ-ADM-003, M=2/N=3 default per D-B4)', () => {
  it('calls cpKeystore.collectQuorumSignatures with threshold=M (default 2) before TX submit', async () => {
    const { keystore, collectCalls } = makeKeystoreOk();
    const issuer = mkIssuer({ keystore });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-q1');

    // collect called once per peer (5 peers)
    expect(collectCalls).toHaveLength(5);
    for (const c of collectCalls) {
      expect(c.threshold).toBe(2);
      expect(c.msg).toBeInstanceOf(Uint8Array);
    }
  });

  it('TX args include QuorumSig (signers + signatures) and pubkeys from collectQuorumSignatures', async () => {
    const { submitFn, calls } = mkSubmit();
    const issuer = mkIssuer({ submitFn });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-q2');

    expect(calls[0]!.args).toMatchObject({
      target: '0xpkg::room_capability::issue_capability_token',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
    });

    const qs = calls[0]!.args.cpQuorumProof as { signers: string[]; signatures: number[][] };
    expect(qs.signers.length).toBe(2); // M=2
    expect(qs.signatures.length).toBe(2);

    const pubkeys = calls[0]!.args.signerPubkeys as number[][];
    expect(pubkeys.length).toBe(2);
  });

  it('D-011: issue TX args include aggregateSig (BCS-serialized QuorumSig for on-chain audit storage)', async () => {
    const { submitFn, calls } = mkSubmit();
    const issuer = mkIssuer({ submitFn });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-d011');

    // Move issue_capability_token param 11 (between signer_pubkeys and ctx)
    // requires `aggregate_sig: vector<u8>` per dvconf-contracts e3780d3 + D-011.
    // Issuer must forward the keystore's aggregateSig output verbatim.
    const aggregateSig = calls[0]!.args.aggregateSig as number[];
    expect(aggregateSig).toBeDefined();
    expect(Array.isArray(aggregateSig)).toBe(true);
    expect(aggregateSig.length).toBeGreaterThan(0);
    // Synthetic blob shape in makeKeystoreOk: [0xff, threshold, ...sigsFlat]
    expect(aggregateSig[0]).toBe(0xff);
    expect(aggregateSig[1]).toBe(2); // threshold = M = 2
    // Distinct from any individual signature (regression guard against
    // accidentally piping a signature as the aggregate blob).
    const qs = calls[0]!.args.cpQuorumProof as { signatures: number[][] };
    expect(JSON.stringify(aggregateSig)).not.toBe(JSON.stringify(qs.signatures[0]));
  });

  it('on quorum collection failure: logs error + DOES NOT submit TX + does NOT crash the daemon', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({
      submitFn,
      keystore: makeKeystoreInsufficient(),
      logger,
    });

    // Should not throw — issuer must absorb errors and keep daemon alive.
    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-q3');

    expect(calls).toHaveLength(0); // no TX submitted on failure
    expect(logger.error).toHaveBeenCalled();
    // Confirm error log carries the dedupe key for retry-correlation per § 4.4 mandate
    const errCall = (logger.error.mock.calls as any[]).find(
      (c) => (c[0]?.context?.dedupe_key ?? c[0]?.dedupe_key) === '0xroom1::pairing-finalize',
    );
    expect(errCall).toBeDefined();
  });
});

// ── REQ-ADM-006 — Structured logging ─────────────────────────────────────

describe('CapTokenIssuer structured logging (REQ-ADM-006)', () => {
  it('every handler invocation generates a fresh log carrying trace_id + module field', async () => {
    const logger = mockLogger();
    const issuer = mkIssuer({ logger });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-a');
    await issuer.onRelaySlashed(RELAY_SLASHED, 'trace-b');

    const seenTraceIds = new Set<string>();
    for (const call of logger.info.mock.calls as any[]) {
      if (call[0]?.trace_id) {
        seenTraceIds.add(call[0].trace_id);
        expect(call[0].module).toBe('cap-token-issuer');
      }
    }
    expect(seenTraceIds.has('trace-a')).toBe(true);
    expect(seenTraceIds.has('trace-b')).toBe(true);
  });

  it('logs TX submitted with digest + handler name for downstream correlation', async () => {
    const { submitFn } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    await issuer.onRoomAssigned(ROOM_ASSIGNED, 'trace-log-1');

    const txLog = (logger.info.mock.calls as any[]).find((c) => c[1] === 'TX submitted');
    expect(txLog).toBeDefined();
    expect(txLog[0]).toMatchObject({
      trace_id: 'trace-log-1',
      module: 'cap-token-issuer',
    });
    expect(txLog[0].context.tx_digest).toBeTruthy();
    expect(txLog[0].context.handler).toBe('onRoomAssigned');
  });
});

// ── Additional listener coverage — onRoleChanged / onRoleAssigned / onRelaySlashed ─

describe('CapTokenIssuer.onRoleChanged + onRoleAssigned + onRelaySlashed', () => {
  it('onRoleChanged dedupes by (miner_id, new_role, "role-change") key', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    await issuer.onRoleChanged(ROLE_CHANGED, 'trace-rc-1');
    const firstCount = calls.length;
    await issuer.onRoleChanged(ROLE_CHANGED, 'trace-rc-2'); // duplicate
    expect(calls.length).toBe(firstCount);

    const dedupeWarn = (logger.warn.mock.calls as any[]).find(
      (c) =>
        (c[0]?.context?.dedupe_key ?? c[0]?.dedupe_key) ===
        '0xminer1::4::role-change',
    );
    expect(dedupeWarn).toBeDefined();
  });

  it('onRoleAssigned dedupes by (miner_id, role, "role-assigned") key', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    await issuer.onRoleAssigned(ROLE_ASSIGNED, 'trace-ra-1');
    const firstCount = calls.length;
    await issuer.onRoleAssigned(ROLE_ASSIGNED, 'trace-ra-2');
    expect(calls.length).toBe(firstCount);

    const dedupeWarn = (logger.warn.mock.calls as any[]).find(
      (c) =>
        (c[0]?.context?.dedupe_key ?? c[0]?.dedupe_key) ===
        '0xminer1::4::role-assigned',
    );
    expect(dedupeWarn).toBeDefined();
  });

  it('onRelaySlashed submits revoke TX via M-of-N quorum + dedupes by (room_id, relay_miner_id, "slash") key', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    await issuer.onRelaySlashed(RELAY_SLASHED, 'trace-s-1');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.label).toBe('revoke-capability-token-via-quorum');

    const firstCount = calls.length;
    await issuer.onRelaySlashed(RELAY_SLASHED, 'trace-s-2'); // duplicate
    expect(calls.length).toBe(firstCount);

    const dedupeWarn = (logger.warn.mock.calls as any[]).find(
      (c) =>
        (c[0]?.context?.dedupe_key ?? c[0]?.dedupe_key) ===
        '0xroom1::0xrelay-bad::slash',
    );
    expect(dedupeWarn).toBeDefined();
  });
});

// ── Phase 3.4 — REQ-ADM-013 anti-replay nonce / REQ-ADM-014 60s grace / REQ-ADM-015 emergency / REQ-ADM-005 C4 inject ──

const EMERGENCY_EVENT = {
  peerPubkey: new Array(32).fill(0x11),
  reason: 'leaked-key',
  oldTokenId: '0xoldtok-emerg',
  roomId: '0xroom-emerg',
  role: 4, // signaling
};

/** Build a RoleChangedEvent populated with Phase 3.4 fields so the issuer can
 *  perform refresh without a chain lookup. Tests inject this map via the
 *  optional `roleChangeContext` overload of onRoleChanged / onRoleAssigned (Phase 3.4 extension). */
function rcWithToken(token: string, override?: Partial<RoleChangedEvent>): RoleChangedEvent {
  return {
    ...ROLE_CHANGED,
    affectedTokenId: token,
    roomId: '0xroom-emerg',
    peerPubkey: new Array(32).fill(0x11),
    ...override,
  } as RoleChangedEvent;
}

describe('Phase 3.4 — REQ-ADM-013 anti-replay nonce on refresh', () => {
  it('refresh dispatch increments per-(room,peer) nonce monotonically + rejects replay attempts', async () => {
    vi.useFakeTimers();
    try {
      const { submitFn, calls } = mkSubmit();
      const logger = mockLogger();
      const issuer = mkIssuer({ submitFn, logger });

      // First refresh — schedule + advance past grace.
      await issuer.onRoleChanged(rcWithToken('0xtok-A'), 'trace-n1');
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.runAllTicks();

      // After the grace fires, expect refresh TX (CASE B: + revoke-old TX).
      // Phase 3.4 must dispatch at least the refresh; revoke-old is Case-B branch.
      const refreshCalls = calls.filter((c) => c.label === 'refresh-capability-token');
      expect(refreshCalls.length).toBeGreaterThan(0);

      // Now try to externally invoke refresh with a stale nonce — issuer must
      // reject it. Test seam: _attemptRefreshWithNonceForTest(roomId, peerHex, nonce).
      // Initial nonce stored after first refresh is `1` (D-010-B starts at 1). A
      // replay with `1` (== current) must be rejected; a replay with `0` (< current)
      // must also be rejected. Both emit nonce-replay WARN.
      const replayResult1 = (issuer as any)._attemptRefreshWithNonceForTest(
        '0xroom-emerg',
        '11'.repeat(32),
        1,
        'trace-n1-replay-eq',
      );
      const replayResult2 = (issuer as any)._attemptRefreshWithNonceForTest(
        '0xroom-emerg',
        '11'.repeat(32),
        0,
        'trace-n1-replay-lt',
      );

      expect(replayResult1).toBe(false);
      expect(replayResult2).toBe(false);

      const replayWarn = (logger.warn.mock.calls as any[]).find(
        (c) => c[0]?.context?.reason === 'nonce-replay',
      );
      expect(replayWarn).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Phase 3.4 — REQ-ADM-014 60s grace timer with cancel-on-revert', () => {
  it('cancels pending refresh when role-change reverts before grace window elapses', async () => {
    vi.useFakeTimers();
    try {
      const { submitFn, calls } = mkSubmit();
      const logger = mockLogger();
      const issuer = mkIssuer({ submitFn, logger });

      // Schedule A→B grace
      await issuer.onRoleChanged(
        rcWithToken('0xtok-revert', { oldRole: 2, newRole: 4 }),
        'trace-revert-1',
      );

      // Before 60s elapses, role reverts (B→A) → must cancel pending timer
      await vi.advanceTimersByTimeAsync(30_000);
      await issuer.onRoleChanged(
        // Different newRole so dedupe key differs; but same minerId so cancel-on-revert kicks in
        rcWithToken('0xtok-revert', { oldRole: 4, newRole: 2 }),
        'trace-revert-2',
      );

      // Advance past the original 60s window. No TX should fire — both timers cancelled.
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.runAllTicks();

      const refreshCalls = calls.filter((c) => c.label === 'refresh-capability-token');
      expect(refreshCalls.length).toBe(0);

      // Cancellation INFO log present
      const cancelLog = (logger.info.mock.calls as any[]).find(
        (c) => c[1] === 'grace timer cancelled — role reverted before 60s window',
      );
      expect(cancelLog).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Phase 3.4 — REQ-ADM-015 emergency rotation', () => {
  it('onEmergencyRotation: bypasses grace timer + idempotent on second invocation', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    // First emergency rotation — fires refresh immediately (and Case-B revoke-old).
    await (issuer as any).onEmergencyRotation(EMERGENCY_EVENT, 'trace-em-1');

    const refreshCallsFirst = calls.filter((c) => c.label === 'refresh-capability-token');
    expect(refreshCallsFirst.length).toBe(1);

    // Reason is logged as WARN with `reason` field
    const reasonWarn = (logger.warn.mock.calls as any[]).find(
      (c) => c[0]?.context?.reason === 'leaked-key',
    );
    expect(reasonWarn).toBeDefined();

    // Replay the same event — must be deduped
    await (issuer as any).onEmergencyRotation(EMERGENCY_EVENT, 'trace-em-2');
    const refreshCallsSecond = calls.filter((c) => c.label === 'refresh-capability-token');
    expect(refreshCallsSecond.length).toBe(1); // unchanged

    const dedupeWarn = (logger.warn.mock.calls as any[]).find(
      (c) =>
        (c[0]?.context?.dedupe_key ?? c[0]?.dedupe_key) ===
        '11'.repeat(32) + '::emergency-rotate',
    );
    expect(dedupeWarn).toBeDefined();
  });
});

describe('Phase 3.4 — REQ-ADM-005 C4 cross-Wave inject (Case B: refresh + revoke-old TXs)', () => {
  it('Case B chosen: refresh TX is followed by revoke-old TX with reason=4 for cache fast-path eviction', async () => {
    vi.useFakeTimers();
    try {
      const { submitFn, calls } = mkSubmit();
      const logger = mockLogger();
      const issuer = mkIssuer({ submitFn, logger });

      await issuer.onRoleChanged(rcWithToken('0xtok-c4'), 'trace-c4-1');
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.runAllTicks();

      // CASE B: must see BOTH a refresh TX AND a revoke-old TX (reason=4 refresh-driven)
      const refreshCalls = calls.filter((c) => c.label === 'refresh-capability-token');
      const revokeCalls = calls.filter((c) => c.label === 'revoke-capability-token-via-quorum');

      expect(refreshCalls.length).toBe(1);
      expect(revokeCalls.length).toBe(1);

      // Refresh TX target + new_role + new_expires fields
      expect(refreshCalls[0]!.args.target).toBe(
        '0xpkg::room_capability::refresh_capability_token',
      );
      expect(refreshCalls[0]!.args.oldTokenId).toBe('0xtok-c4');
      // D-011: aggregate_sig param present on refresh TX
      expect((refreshCalls[0]!.args.aggregateSig as number[]).length).toBeGreaterThan(0);

      // Revoke-old TX targets the old token with reason=4 (refresh-driven, not in 0/1/2 base enum)
      expect(revokeCalls[0]!.args.target).toBe(
        '0xpkg::room_capability::revoke_capability_token_via_quorum',
      );
      expect(revokeCalls[0]!.args.capObjectId).toBe('0xtok-c4');
      expect(revokeCalls[0]!.args.reason).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
