/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer tests (RED-first → GREEN).
 *
 * REQ-IDs covered in this split: onRoleChanged / onRoleAssigned / onRelaySlashed
 * listener coverage (dedupe-key checks, quorum-driven revoke TX).
 *
 * Real event names per DECISIONS § D-010-A + CONTRACTS § 4.6:
 *   - miner::registration::RoleChanged
 *   - role_voting::RoleAssigned
 *   - economic_layer::RelaySlashed
 *
 * Pattern follows turn-issuer.test.ts: SubmitFn DI + mockLogger() helper +
 * in-memory state assertions.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CapTokenIssuer,
  type SubmitFn,
  type SubmitResult,
  type CpKeystore,
  type RoleChangedEvent,
  type RoleAssignedEvent,
  type RelaySlashedEvent,
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

const ROLE_ASSIGNED: RoleAssignedEvent = {
  minerId: '0xminer1',
  role: 3, // cp
  voteCount: '3',
  threshold: '2',
};

const RELAY_SLASHED: RelaySlashedEvent = {
  roomId: '0xroom1',
  relayMinerId: '0xrelay-bad',
  slashAmount: '500000000',
};

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
        '0xminer1::3::role-change',
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
        '0xminer1::3::role-assigned',
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
