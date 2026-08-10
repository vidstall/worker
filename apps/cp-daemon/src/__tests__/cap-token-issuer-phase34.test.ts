/**
 * F62 M1 Stage 3 / Phase 3.4 — cap-token-issuer tests (RED-first → GREEN).
 *
 * REQ-IDs:
 *   - REQ-ADM-013 — anti-replay nonce on refresh
 *   - REQ-ADM-014 — 60s grace timer with cancel-on-revert
 *   - REQ-ADM-015 — emergency rotation (bypasses grace timer)
 *   - REQ-ADM-005 — C4 cross-Wave inject (Case B: refresh + revoke-old TXs)
 *
 * Pattern follows turn-issuer.test.ts: SubmitFn DI + mockLogger() helper +
 * in-memory state assertions + vi.useFakeTimers() where time matters.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CapTokenIssuer,
  type SubmitFn,
  type SubmitResult,
  type CpKeystore,
  type RoleChangedEvent,
} from '../cap-token/index.js';

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
      const signers: string[] = [];
      const signatures: number[][] = [];
      const pubkeys: number[][] = [];
      for (let i = 0; i < threshold; i++) {
        signers.push(`0xcp${i + 1}`);
        signatures.push(new Array(64).fill(0xab + i));
        pubkeys.push(new Array(32).fill(0xaa + i));
      }
      const aggregateSig = [0xff, threshold, ...signatures.flat()];
      return { qs: { signers, signatures }, pubkeys, aggregateSig };
    },
  };
  return { keystore, collectCalls };
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

const ROLE_CHANGED: RoleChangedEvent = {
  minerId: '0xminer1',
  oldRole: 2, // relay
  newRole: 3, // cp
  newStake: '1000000000',
};

// ── Phase 3.4 — REQ-ADM-013 anti-replay nonce / REQ-ADM-014 60s grace / REQ-ADM-015 emergency / REQ-ADM-005 C4 inject ──

const EMERGENCY_EVENT = {
  peerPubkey: new Array(32).fill(0x11),
  reason: 'leaked-key',
  oldTokenId: '0xoldtok-emerg',
  roomId: '0xroom-emerg',
  role: 3, // cp
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
