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
  type SecretRotatedEvent,
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
      return { qs: { signers, signatures }, pubkeys };
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

const SECRET_ROTATED: SecretRotatedEvent = {
  rotationId: '0xrot-1',
  newKeyEpoch: '42',
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

// ── Additional listener coverage — onRoleChanged / onRoleAssigned / onRelaySlashed / onSecretRotated ─

describe('CapTokenIssuer.onRoleChanged + onRoleAssigned + onRelaySlashed + onSecretRotated', () => {
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

  it('onSecretRotated is a stub: logs WARN + emits no TX (F8 not yet shipped)', async () => {
    const { submitFn, calls } = mkSubmit();
    const logger = mockLogger();
    const issuer = mkIssuer({ submitFn, logger });

    await issuer.onSecretRotated(SECRET_ROTATED, 'trace-sr-1');

    expect(calls).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalled();
    const stubWarn = (logger.warn.mock.calls as any[]).find(
      (c) => c[1] === 'SecretRotated stub — F8 not yet shipped',
    );
    expect(stubWarn).toBeDefined();
    expect(stubWarn[0]).toMatchObject({
      trace_id: 'trace-sr-1',
      module: 'cap-token-issuer',
    });
  });
});
