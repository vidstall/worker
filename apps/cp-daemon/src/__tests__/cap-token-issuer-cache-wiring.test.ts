/**
 * F62 M1 Stage 4 / Item #3 — Issuer↔Cache wiring tests (TDD RED → GREEN).
 *
 * Spec sources:
 *   - STATUS.md § Stage 4 readiness #3 + DECISIONS.md D-012 Addendum
 *   - CONTRACTS § 4.7 LOC matrix
 *
 * Contract: when constructed with `cache?: CapTokenCacheLike`, the issuer's
 * `onEmergencyRotation` handler MUST call `cache.emergencyInvalidate(oldTokenId,
 * 'rotation-<reason>')` BEFORE submitting the rotation TX (per D-012 Addendum:
 * "cache.emergencyInvalidate(...) immediately before issuer.onEmergencyRotation(...)").
 *
 * Loose-coupling guarantee: the test uses a structural mock implementing only
 * the `emergencyInvalidate(tokenId, reason)` method — no signaling/src import.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  CapTokenIssuer,
  type SubmitFn,
  type SubmitResult,
  type CpKeystore,
  type CapTokenCacheLike,
  type EmergencyRotationEvent,
} from '../cap-token/index.js';

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

function mkKeystore(): CpKeystore {
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
    async collectQuorumSignatures(_msg, threshold) {
      const signers: string[] = [];
      const signatures: number[][] = [];
      const pubkeys: number[][] = [];
      for (let i = 0; i < threshold; i++) {
        signers.push(`0xcp${i + 1}`);
        signatures.push(new Array(64).fill(0xab + i));
        pubkeys.push(new Array(32).fill(0xaa + i));
      }
      return { qs: { signers, signatures }, pubkeys, aggregateSig: [0xff, threshold] };
    },
  };
}

function mkSubmitWithLog(eventLog: string[]): {
  submitFn: SubmitFn;
  calls: Array<{ label: string; args: Record<string, unknown> }>;
} {
  const calls: Array<{ label: string; args: Record<string, unknown> }> = [];
  const submitFn: SubmitFn = vi.fn(
    async (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult> => {
      calls.push({ label: opts.label, args: opts.args });
      eventLog.push(`submit:${opts.label}`);
      return { digest: `tx-${calls.length}` };
    },
  );
  return { submitFn, calls };
}

function mkCacheMock(eventLog: string[]): CapTokenCacheLike & {
  invalidations: Array<{ tokenId: string; reason: string }>;
} {
  const invalidations: Array<{ tokenId: string; reason: string }> = [];
  return {
    invalidations,
    emergencyInvalidate(tokenId: string, reason: string): void {
      invalidations.push({ tokenId, reason });
      eventLog.push(`cache:${tokenId}:${reason}`);
    },
  };
}

const EMERGENCY_EVENT: EmergencyRotationEvent = {
  peerPubkey: new Array(32).fill(0x11),
  reason: 'leaked-key',
  oldTokenId: '0xtoken-old-em',
  roomId: '0xroom-em',
  role: 2,
};

describe('CapTokenIssuer Item #3 — issuer↔cache wiring (D-012 Addendum)', () => {
  it('constructor accepts CapTokenCacheLike via the optional `cache` option', () => {
    const cache = mkCacheMock([]);
    const submit = mkSubmitWithLog([]);
    const issuer = new CapTokenIssuer({
      submitFn: submit.submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      cpKeystore: mkKeystore(),
      logger: mockLogger(),
      quorumThreshold: 2,
      cache,
    });
    expect(issuer).toBeDefined();
  });

  it('when cache is injected, onEmergencyRotation calls cache.emergencyInvalidate exactly once with reason "rotation-<event.reason>"', async () => {
    const cache = mkCacheMock([]);
    const submit = mkSubmitWithLog([]);
    const issuer = new CapTokenIssuer({
      submitFn: submit.submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      cpKeystore: mkKeystore(),
      logger: mockLogger(),
      quorumThreshold: 2,
      cache,
    });

    await issuer.onEmergencyRotation(EMERGENCY_EVENT, 'trace-cache-1');

    expect(cache.invalidations).toHaveLength(1);
    expect(cache.invalidations[0]!.tokenId).toBe(EMERGENCY_EVENT.oldTokenId);
    expect(cache.invalidations[0]!.reason).toBe('rotation-leaked-key');
  });

  it('cache.emergencyInvalidate fires BEFORE the refresh + revoke-old TXs are submitted (D-012 Addendum ordering)', async () => {
    const eventLog: string[] = [];
    const cache = mkCacheMock(eventLog);
    const submit = mkSubmitWithLog(eventLog);
    const issuer = new CapTokenIssuer({
      submitFn: submit.submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      cpKeystore: mkKeystore(),
      logger: mockLogger(),
      quorumThreshold: 2,
      cache,
    });

    await issuer.onEmergencyRotation(EMERGENCY_EVENT, 'trace-cache-order');

    // Cache invalidate must happen first, then both TXs.
    expect(eventLog[0]).toMatch(/^cache:/);
    const submitIdxes = eventLog
      .map((e, i) => (e.startsWith('submit:') ? i : -1))
      .filter((i) => i >= 0);
    expect(submitIdxes.length).toBeGreaterThanOrEqual(2);
    expect(eventLog.indexOf(eventLog[0]!)).toBeLessThan(submitIdxes[0]!);
  });

  it('when cache is NOT injected, onEmergencyRotation still submits TXs (cache fast-path is optional optimisation per D-012 Addendum)', async () => {
    const submit = mkSubmitWithLog([]);
    const issuer = new CapTokenIssuer({
      submitFn: submit.submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      cpKeystore: mkKeystore(),
      logger: mockLogger(),
      quorumThreshold: 2,
      // cache: undefined  ← intentionally absent
    });

    await issuer.onEmergencyRotation(EMERGENCY_EVENT, 'trace-cache-absent');

    const refreshCalls = submit.calls.filter((c) => c.label === 'refresh-capability-token');
    const revokeCalls = submit.calls.filter((c) => c.label === 'revoke-capability-token-via-quorum');
    expect(refreshCalls).toHaveLength(1);
    expect(revokeCalls).toHaveLength(1);
  });

  it('cache.emergencyInvalidate is only called once even when emergency event is replayed (idempotency dedupe applies)', async () => {
    const cache = mkCacheMock([]);
    const submit = mkSubmitWithLog([]);
    const issuer = new CapTokenIssuer({
      submitFn: submit.submitFn,
      packageId: '0xpkg',
      networkRegistryId: '0xnet',
      cpRegistryObjectId: '0xcpreg',
      quorumStateObjectId: '0xquorum',
      cpKeystore: mkKeystore(),
      logger: mockLogger(),
      quorumThreshold: 2,
      cache,
    });

    await issuer.onEmergencyRotation(EMERGENCY_EVENT, 'trace-cache-replay-1');
    await issuer.onEmergencyRotation(EMERGENCY_EVENT, 'trace-cache-replay-2');

    // Idempotency dedupe: second emergency event should NOT trigger a second
    // refresh + revoke pair. The cache fast-path is bound by the same dedupe
    // contract so accidental duplicate WARN-emergency log entries don't fan out.
    const refreshCalls = submit.calls.filter((c) => c.label === 'refresh-capability-token');
    expect(refreshCalls).toHaveLength(1);
    expect(cache.invalidations).toHaveLength(1);
  });
});
