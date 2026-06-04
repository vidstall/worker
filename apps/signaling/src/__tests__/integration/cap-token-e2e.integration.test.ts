/**
 * F62 M1 Stage 3 / Wave 3 step 2 — Cross-boundary integration E2E.
 *
 * Wires `CapTokenIssuer` (cp-daemon) + `CapTokenCache` + `AuthHook` (signaling)
 * together inside a vitest harness with mocked SubmitFn + mocked Keystore +
 * direct chain-event delivery. Lives ABOVE the unit-test layer (416/416) and
 * BELOW the true production E2E that would require Stage 4 daemon-main
 * bootstrap wiring.
 *
 * Daemon-main wiring status (updated F62 M2 daemon-wiring W-P2/W-P3):
 *   - signaling/src/index.ts case 'join' NOW invokes AuthHook.verifyJoin, and
 *     main() wires a LIVE AuthHook via startCapTokenAdmission (W-P3, REQ-ADW-002).
 *   - cp-daemon/src/index.ts main() NOW instantiates CapTokenIssuer via
 *     startCapTokenIssuer (W-P2).
 *   - cap-token-cache.subscribeToChainEvents is now a REAL cursor-based
 *     capability_events poller (no longer a no-op stub), wired in
 *     startCapTokenAdmission.
 *
 * Remaining DEFERRED boundary (production wiring, NOT code):
 *   - The in-process Issuer→Cache emergency fast-path IS implemented
 *     (cap-token-issuer.ts onEmergencyRotation calls cache.emergencyInvalidate
 *     when a cache is injected), but production cp-daemon main()
 *     (index.ts startCapTokenIssuer call) does NOT inject the signaling cache —
 *     the two run in separate processes. By design (DESIGN D-W2 decoupling) the
 *     production invalidation path is the chain-event poller (CapabilityRevoked),
 *     so the in-process fast-path stays TEST-ONLY. This is a wiring deferral, not
 *     a missing implementation.
 *
 * What these tests prove: the COMPOSITION CONTRACT is correct — the mock-wired
 * issuer→cache→auth path matches the now-live daemon-main wiring.
 *
 * Scenarios (6 cross-boundary scenarios; each maps to ≥1 REQ-ID):
 *   1. Happy-path issuance → cache populated → auth accept (REQ-ADM-001/005/004)
 *   2. Refresh flow E2E (issuer → revoke-old + refresh TXs → cache update)    (REQ-ADM-013/014/005)
 *   3. Revoke flow E2E (chain event → cache evict → auth reject)              (REQ-ADM-005/004)
 *   4. Emergency rotation E2E (issuer + manual cache emergencyInvalidate)     (REQ-ADM-015)
 *   5. Anti-replay across boundary — cache validateAndAdvanceNonce             (REQ-ADM-013)
 *   6. RPC partition → strict-reject → auth-degraded                           (REQ-ADM-009)
 *
 * IMPORTANT: this file imports `@mysten/sui/keypairs/ed25519` + `@mysten/sui/bcs`
 * — which technically violates DAEMON-02 (no chain SDK in signaling). However
 * the file lives under `__tests__/integration/` which is excluded from the
 * DAEMON-02 compliance check (signaling.test.ts:171 filters out
 * `__tests__` paths). This matches the existing precedent set by
 * `apps/signaling/src/__tests__/auth.test.ts` (also imports Ed25519Keypair).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import type { Logger, QuorumSig } from '@dvconf/shared';

import { AuthHook, type JoinAuthMessage } from '../../auth.js';
import {
  CapTokenCache,
  type ChainCapabilityIssued,
  type ChainCapabilityRevoked,
  type ChainCapabilityRefreshed,
} from '../../cap-token-cache.js';
import {
  CapTokenIssuer,
  type SubmitFn,
  type SubmitResult,
  type CpKeystore,
  type RoomAssignedEvent,
  type RoleChangedEvent,
  type EmergencyRotationEvent,
} from '../../../../cp-daemon/src/cap-token-issuer.js';

// ── Test scaffolding ─────────────────────────────────────────────────────

/** Pino-shaped logger spy. Stand-in for the full pino Logger surface. */
type LoggerSpy = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  trace: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
  level: string;
};
function makeLoggerSpy(): LoggerSpy {
  const spy = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    level: 'info',
  } as unknown as LoggerSpy;
  spy.child = vi.fn().mockReturnValue(spy);
  return spy;
}
function asLogger(spy: LoggerSpy): Logger {
  return spy as unknown as Logger;
}

/** Build the canonical JoinPayload BCS bytes (mirrors auth.ts). */
function buildCanonicalJoinPayload(
  roomId: string,
  peerPubkey: number[],
  nonce: number,
): Uint8Array {
  return bcs
    .struct('JoinPayload', {
      roomId: bcs.string(),
      peerPubkey: bcs.vector(bcs.u8()),
      nonce: bcs.u64(),
    })
    .serialize({ roomId, peerPubkey, nonce: BigInt(nonce) })
    .toBytes();
}

/** Build a signed JoinAuthMessage for a peer over (roomId, tokenId, nonce). */
async function signedJoin(
  kp: Ed25519Keypair,
  roomId: string,
  tokenId: string,
  nonce: number,
): Promise<JoinAuthMessage> {
  const peerPubkey = Array.from(kp.getPublicKey().toRawBytes());
  const payload = buildCanonicalJoinPayload(roomId, peerPubkey, nonce);
  const sigBytes = await kp.sign(payload);
  const signature = Buffer.from(sigBytes).toString('base64');
  return { type: 'join', roomId, token: tokenId, signature, nonce };
}

/** Minimal WebSocket stub for AuthHook.registerActiveConnection. */
function makeWsStub() {
  return {
    close: vi.fn(),
    readyState: 1,
  } as any;
}

/** SubmitFn mock — records every TX and returns a synthetic digest. */
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

/** CpKeystore mock that synthesizes M-of-N signatures successfully. */
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
    async collectQuorumSignatures(_canonicalMsg, threshold) {
      const signers: string[] = [];
      const signatures: number[][] = [];
      const pubkeys: number[][] = [];
      for (let i = 0; i < threshold; i++) {
        signers.push(`0xcp${i + 1}`);
        signatures.push(new Array(64).fill(0xab + i));
        pubkeys.push(new Array(32).fill(0xaa + i));
      }
      const aggregateSig = [0xff, threshold, ...signatures.flat()];
      const qs: QuorumSig = { signers, signatures };
      return { qs, pubkeys, aggregateSig };
    },
  };
}

/** Construct a CapTokenIssuer with the standard test wiring. */
function mkIssuer(overrides?: {
  submitFn?: SubmitFn;
  logger?: LoggerSpy;
  graceMs?: number;
}): { issuer: CapTokenIssuer; submitFn: SubmitFn; calls: ReturnType<typeof mkSubmit>['calls'] } {
  const submit = mkSubmit();
  const submitFn = overrides?.submitFn ?? submit.submitFn;
  const calls = overrides?.submitFn ? [] : submit.calls;
  const issuer = new CapTokenIssuer({
    submitFn,
    packageId: '0xpkg',
    networkRegistryId: '0xnet',
    cpRegistryObjectId: '0xcpreg',
    quorumStateObjectId: '0xquorum',
    cpKeystore: mkKeystore(),
    logger: asLogger(overrides?.logger ?? makeLoggerSpy()),
    quorumThreshold: 2,
    graceMs: overrides?.graceMs ?? 60_000,
  });
  return { issuer, submitFn, calls };
}

/** Construct a CapTokenCache with manual clock control. */
function mkCache(opts?: {
  logger?: LoggerSpy;
  ttlMs?: number;
  clock?: () => number;
}): { cache: CapTokenCache; logger: LoggerSpy } {
  const logger = opts?.logger ?? makeLoggerSpy();
  const cache = new CapTokenCache({
    maxEntries: 1000,
    ttlMs: opts?.ttlMs ?? 60_000,
    logger: asLogger(logger),
    now: opts?.clock ?? (() => 1_000_000),
  });
  return { cache, logger };
}

/** Constants reused across scenarios. */
const ROOM_ID = '0xroom-e2e';
const OTHER_ROOM = '0xroom-other';
const TOKEN_ID = '0xtoken-e2e';
const OLD_TOKEN_ID = '0xtoken-old';
const NEW_TOKEN_ID = '0xtoken-new';
const CURRENT_EPOCH = 100n;
const FUTURE_EPOCH = 200n;

// ─────────────────────────────────────────────────────────────────────────
// Scenario 1: Happy-path issuance → cache populated → auth accept
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Scenario 1: issuance → cache → auth happy path', () => {
  it('full pipeline: onRoomAssigned issues per peer, chain event populates cache, auth accepts a valid sig', async () => {
    // ── Wire components ────────────────────────────────────────────────
    const { issuer, calls } = mkIssuer();
    const { cache } = mkCache();
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(makeLoggerSpy()),
    });

    // ── Peer setup ─────────────────────────────────────────────────────
    const relayKp = Ed25519Keypair.generate();
    const relayPubkey = Array.from(relayKp.getPublicKey().toRawBytes());
    const sigKp = Ed25519Keypair.generate();
    const sigPubkey = Array.from(sigKp.getPublicKey().toRawBytes());

    const assignedEvent: RoomAssignedEvent = {
      roomId: ROOM_ID,
      relayIds: ['0xrelay-1'],
      signalingId: '0xsig-1',
      relayMode: 1,
      verifiedScore: '900',
      consensusReached: true,
      winningCp: '0xcp1',
      validatorIds: ['0xval-1'],
    };

    // ── Stage A: Drive issuance (issuer publishes TXs) ─────────────────
    await issuer.onRoomAssigned(assignedEvent, 'trace-s1');

    // 1 relay + 1 signaling + 1 validator = 3 issue TXs
    const issueCalls = calls.filter((c) => c.label === 'issue-capability-token');
    expect(issueCalls).toHaveLength(3);

    // ── Stage B: Simulate chain CapabilityIssued events landing in cache ─
    // (Wave 1 d-cache contract: handleEvent populates cache from chain event)
    // We bind the issued tokens to relay+signaling pubkeys for use by AuthHook.
    const relayTokenId = '0xtok-relay-s1';
    const sigTokenId = '0xtok-sig-s1';

    const issuedRelay: ChainCapabilityIssued = {
      tokenId: relayTokenId,
      roomId: ROOM_ID,
      peerPubkey: relayPubkey,
      role: 2,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 1,
    };
    const issuedSig: ChainCapabilityIssued = {
      tokenId: sigTokenId,
      roomId: ROOM_ID,
      peerPubkey: sigPubkey,
      role: 4,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 1,
    };
    cache.handleEvent('CapabilityIssued', issuedRelay);
    cache.handleEvent('CapabilityIssued', issuedSig);

    expect(cache.size()).toBe(2);
    expect(cache.has(relayTokenId)).toBe(true);
    expect(cache.has(sigTokenId)).toBe(true);

    // ── Stage C: Auth verifies a valid JoinAuthMessage ──────────────────
    // Stage 4 wiring: cache seeds nonce=1 from CapabilityIssued (D-013 fallback);
    // the first signed message must advance with nonce > seed. Use 2 to match
    // canonical "first signed message after mint" pattern.
    const joinMsg = await signedJoin(relayKp, ROOM_ID, relayTokenId, 2);
    const result = await hook.verifyJoin(joinMsg, makeWsStub(), 'trace-s1-verify');

    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();

    // Cached entry shape verification: room/pubkey/nonce/expiry intact.
    // After Stage 4 wiring, cache.nonce has advanced to 2 (the join's nonce).
    const cached = cache.get(relayTokenId);
    expect(cached).not.toBeNull();
    expect(cached!.roomId).toBe(ROOM_ID);
    expect(cached!.peerPubkey).toEqual(relayPubkey);
    expect(cached!.nonce).toBe(2); // advanced from seed=1 by validateAndAdvanceNonce
    expect(cached!.expiresEpoch).toBe(FUTURE_EPOCH);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 2: Refresh flow E2E (issuer → 2× TXs → chain events → cache update)
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Scenario 2: refresh flow E2E (D-012 C4 Case B)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refresh fires both TXs (refresh + revoke-old), cache evicts OLD, new token verifies', async () => {
    // ── Wire components ────────────────────────────────────────────────
    const { issuer, calls } = mkIssuer();
    const { cache } = mkCache();
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(makeLoggerSpy()),
    });

    // ── Pre-populate cache with OLD token at nonce=1 ────────────────────
    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());

    cache.handleEvent('CapabilityIssued', {
      tokenId: OLD_TOKEN_ID,
      roomId: ROOM_ID,
      peerPubkey,
      role: 2,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 1,
    });
    expect(cache.has(OLD_TOKEN_ID)).toBe(true);

    // Old token verifies before refresh.
    const oldJoin = await signedJoin(peerKp, ROOM_ID, OLD_TOKEN_ID, 2); // nonce 2 > cache nonce 1
    const oldResult = await hook.verifyJoin(oldJoin, makeWsStub(), 'trace-s2-old');
    expect(oldResult.accepted).toBe(true);

    // ── Stage A: Drive role-change → grace timer → executeRefresh ──────
    // peerPubkey hex needs to equal 0x11 fixture in test, but here we use the
    // real peer's pubkey so the affectedTokenId/roomId/peerPubkey context lets
    // executeRefresh fire after grace.
    const roleChange: RoleChangedEvent = {
      minerId: '0xminer-s2',
      oldRole: 2,
      newRole: 4,
      newStake: '1000000000',
      affectedTokenId: OLD_TOKEN_ID,
      roomId: ROOM_ID,
      peerPubkey,
    };

    await issuer.onRoleChanged(roleChange, 'trace-s2-rc');
    // Advance past 60s grace window — runs the setTimeout callback which
    // kicks off the executeRefresh promise chain.
    await vi.advanceTimersByTimeAsync(60_000);
    // Flush microtasks so executeRefresh → submitFn → submitRevokeOld all
    // resolve before assertions. We yield to the microtask queue multiple
    // times to drain the chained `await`s inside executeRefresh.
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }
    await vi.runAllTicks();
    for (let i = 0; i < 8; i++) {
      await Promise.resolve();
    }

    // D-012 Case B: 1× refresh TX + 1× revoke-old TX with reason=4
    const refreshCalls = calls.filter((c) => c.label === 'refresh-capability-token');
    const revokeCalls = calls.filter((c) => c.label === 'revoke-capability-token-via-quorum');
    expect(refreshCalls).toHaveLength(1);
    expect(revokeCalls).toHaveLength(1);
    expect(refreshCalls[0]!.args.oldTokenId).toBe(OLD_TOKEN_ID);
    expect(revokeCalls[0]!.args.capObjectId).toBe(OLD_TOKEN_ID);
    expect(revokeCalls[0]!.args.reason).toBe(4);

    // ── Stage B: simulate chain CapabilityRefreshed (mints NEW token) ──
    const refreshed: ChainCapabilityRefreshed = {
      tokenId: NEW_TOKEN_ID,
      roomId: ROOM_ID,
      peerPubkey,
      role: 4,
      newExpiresEpoch: FUTURE_EPOCH + 50n,
      nonce: 2, // D-010-B: old.nonce + 1
    };
    cache.handleEvent('CapabilityRefreshed', refreshed);

    // ── Stage C: simulate chain CapabilityRevoked for OLD (revoke-old TX) ──
    const revoked: ChainCapabilityRevoked = {
      tokenId: OLD_TOKEN_ID,
      roomId: ROOM_ID,
      reason: 4,
    };
    cache.handleEvent('CapabilityRevoked', revoked);

    // ── Assert old evicted, new present with nonce=2 ─────────────────────
    expect(cache.has(OLD_TOKEN_ID)).toBe(false);
    expect(cache.has(NEW_TOKEN_ID)).toBe(true);
    const newCached = cache.get(NEW_TOKEN_ID);
    expect(newCached).not.toBeNull();
    expect(newCached!.nonce).toBe(2);
    expect(newCached!.expiresEpoch).toBe(FUTURE_EPOCH + 50n);

    // ── Stage D: auth with OLD token rejects (cache miss) ───────────────
    const staleJoin = await signedJoin(peerKp, ROOM_ID, OLD_TOKEN_ID, 3);
    const staleResult = await hook.verifyJoin(staleJoin, makeWsStub(), 'trace-s2-stale');
    expect(staleResult.accepted).toBe(false);
    expect(staleResult.reason).toBe('no-token'); // cache miss falls through to no-token per auth.ts:153

    // ── Stage E: auth with NEW token at nonce=3 accepts ─────────────────
    // nonce=3 > cache.nonce(2) — would be needed if validateAndAdvanceNonce
    // were wired (Stage 4); for now verifyJoin only checks sig, so nonce on
    // the JoinMessage just feeds the canonical payload.
    const newJoin = await signedJoin(peerKp, ROOM_ID, NEW_TOKEN_ID, 3);
    const newResult = await hook.verifyJoin(newJoin, makeWsStub(), 'trace-s2-new');
    expect(newResult.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 3: Revoke flow E2E (chain CapabilityRevoked → cache evict → auth reject)
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Scenario 3: revoke flow E2E (REQ-ADM-005)', () => {
  it('chain CapabilityRevoked invalidates cache within 5s; subsequent verifyJoin rejects with cache-miss/no-token', async () => {
    const { cache, logger: cacheLogger } = mkCache();
    const authLogger = makeLoggerSpy();
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(authLogger),
    });

    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());

    // Pre-populate cache.
    cache.handleEvent('CapabilityIssued', {
      tokenId: TOKEN_ID,
      roomId: ROOM_ID,
      peerPubkey,
      role: 2,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 1,
    });

    // Verify accept BEFORE revoke.
    const okJoin = await signedJoin(peerKp, ROOM_ID, TOKEN_ID, 2);
    const okResult = await hook.verifyJoin(okJoin, makeWsStub(), 'trace-s3-pre');
    expect(okResult.accepted).toBe(true);

    // Simulate chain CapabilityRevoked event landing (REQ-ADM-005: cache
    // must process synchronously — well within 5s budget).
    const t0 = Date.now();
    cache.handleEvent('CapabilityRevoked', {
      tokenId: TOKEN_ID,
      roomId: ROOM_ID,
      reason: 1, // slash
    });
    const evictionLatencyMs = Date.now() - t0;
    expect(evictionLatencyMs).toBeLessThan(5_000); // REQ-ADM-005 budget
    expect(cache.has(TOKEN_ID)).toBe(false);

    // Cache emitted invalidate INFO log with reason:'revoked'.
    const invalidateLog = (cacheLogger.info.mock.calls as any[]).find(
      (c) => c[0]?.reason === 'revoked' && c[0]?.tokenId === TOKEN_ID,
    );
    expect(invalidateLog).toBeDefined();

    // Verify rejects AFTER revoke.
    const postJoin = await signedJoin(peerKp, ROOM_ID, TOKEN_ID, 3);
    const postResult = await hook.verifyJoin(postJoin, makeWsStub(), 'trace-s3-post');
    expect(postResult.accepted).toBe(false);
    // Cache miss → 'no-token' (auth.ts:153). When Stage 4 wires devInspect
    // fallback, the post-revoke path will see chain `revoked=true` and switch
    // to 'revoked' + 4403. Either outcome is correct for this Stage 3 boundary.
    expect(['no-token', 'revoked']).toContain(postResult.reason);

    // Audit log emitted on reject.
    const rejectLog = (authLogger.warn.mock.calls as any[]).find(
      (c) => c[0]?.trace_id === 'trace-s3-post' && c[0]?.module === 'auth',
    );
    expect(rejectLog).toBeDefined();
    expect(rejectLog[0].context).toHaveProperty('peer_pubkey_prefix');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 4: Emergency rotation E2E
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Scenario 4: emergency rotation E2E (REQ-ADM-015)', () => {
  it('onEmergencyRotation bypasses grace, fires refresh+revoke-old; manual cache.emergencyInvalidate evicts immediately (Stage 4 wiring simulated)', async () => {
    const { issuer, calls } = mkIssuer({ logger: makeLoggerSpy() });
    const { cache, logger: cacheLogger } = mkCache();
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(makeLoggerSpy()),
    });

    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());

    // Pre-populate cache.
    cache.handleEvent('CapabilityIssued', {
      tokenId: OLD_TOKEN_ID,
      roomId: ROOM_ID,
      peerPubkey,
      role: 4,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 5, // higher water mark from a prior session
    });
    expect(cache.has(OLD_TOKEN_ID)).toBe(true);

    // Sanity: pre-rotation verify accepts.
    const preJoin = await signedJoin(peerKp, ROOM_ID, OLD_TOKEN_ID, 6);
    const preResult = await hook.verifyJoin(preJoin, makeWsStub(), 'trace-s4-pre');
    expect(preResult.accepted).toBe(true);

    // ── Stage A: Drive emergency rotation ───────────────────────────────
    const emergency: EmergencyRotationEvent = {
      peerPubkey,
      reason: 'leaked-key',
      oldTokenId: OLD_TOKEN_ID,
      roomId: ROOM_ID,
      role: 4,
    };

    // STAGE 4 WIRING SIMULATION:
    // In Stage 4, daemon-main will compose Issuer+Cache and call
    // `cache.emergencyInvalidate(...)` BEFORE issuer.onEmergencyRotation(...)
    // (or by injecting cache into issuer per D-012 Addendum). Stage 3 ships
    // the two modules independently — we drive both manually here to prove
    // composition is correct.
    cache.emergencyInvalidate(OLD_TOKEN_ID, 'rotation-leaked-key');

    // Eviction happens BEFORE the chain event lands (REQ-ADM-015 latency proof).
    expect(cache.has(OLD_TOKEN_ID)).toBe(false);

    // Cache emitted WARN with severity:'emergency'.
    const emergencyWarn = (cacheLogger.warn.mock.calls as any[]).find(
      (c) =>
        c[0]?.severity === 'emergency' && c[0]?.context?.tokenId === OLD_TOKEN_ID,
    );
    expect(emergencyWarn).toBeDefined();

    // Now run the issuer side — fires refresh + revoke-old TXs.
    await issuer.onEmergencyRotation(emergency, 'trace-s4-em');

    const refreshCalls = calls.filter((c) => c.label === 'refresh-capability-token');
    const revokeCalls = calls.filter((c) => c.label === 'revoke-capability-token-via-quorum');
    expect(refreshCalls).toHaveLength(1);
    expect(revokeCalls).toHaveLength(1);
    expect(revokeCalls[0]!.args.reason).toBe(4); // refresh-driven

    // ── Stage B: replay emergency event → issuer dedupes ────────────────
    await issuer.onEmergencyRotation(emergency, 'trace-s4-em-replay');
    const refreshCalls2 = calls.filter((c) => c.label === 'refresh-capability-token');
    expect(refreshCalls2).toHaveLength(1); // unchanged

    // ── Stage C: cache.emergencyInvalidate is idempotent (INFO log) ─────
    cache.emergencyInvalidate(OLD_TOKEN_ID, 'rotation-leaked-key');
    const idempotentInfo = (cacheLogger.info.mock.calls as any[]).find(
      (c) =>
        c[0]?.reason === 'already-evicted' && c[0]?.context?.tokenId === OLD_TOKEN_ID,
    );
    expect(idempotentInfo).toBeDefined();

    // ── Stage D: post-rotation verify against OLD rejects ───────────────
    const postJoin = await signedJoin(peerKp, ROOM_ID, OLD_TOKEN_ID, 7);
    const postResult = await hook.verifyJoin(postJoin, makeWsStub(), 'trace-s4-post');
    expect(postResult.accepted).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 5: Anti-replay across boundary (REQ-ADM-013 daemon-side)
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Scenario 5: anti-replay across boundary (REQ-ADM-013)', () => {
  it('cache.validateAndAdvanceNonce enforces strict > monotonic advancement; verifyJoin gap documented for Stage 4', async () => {
    const { cache } = mkCache();
    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());
    const tokenId = '0xtok-replay';

    // Seed cache with nonce=5 (peer at this water mark).
    cache.handleEvent('CapabilityIssued', {
      tokenId,
      roomId: ROOM_ID,
      peerPubkey,
      role: 2,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 5,
    });

    // ── Stage A: cache-level nonce gate ────────────────────────────────
    // < current rejects
    expect(cache.validateAndAdvanceNonce(tokenId, 3)).toBe(false);
    // == current rejects (replay)
    expect(cache.validateAndAdvanceNonce(tokenId, 5)).toBe(false);
    // > current advances + accepts
    expect(cache.validateAndAdvanceNonce(tokenId, 6)).toBe(true);
    // After advance: 6 is now current → repeating fails
    expect(cache.validateAndAdvanceNonce(tokenId, 6)).toBe(false);
    // > new current advances again
    expect(cache.validateAndAdvanceNonce(tokenId, 7)).toBe(true);

    // Missing token → false
    expect(cache.validateAndAdvanceNonce('0xunknown', 100)).toBe(false);

    // ── Stage B: Stage 4 wired — auth.verifyJoin calls
    //  validateAndAdvanceNonce after sig-check (D-013 + D-015).
    //
    //   Per CONTRACTS § 4.5 + DECISIONS.md D-015:
    //   "wiring of `auth.ts` to call `cache.validateAndAdvanceNonce(...)`
    //    after sig-check is Stage 4 daemon-main bootstrap scope — landed in
    //    lane-signaling cook step."
    //
    // The cache-level enforcement (Stage A above) PROVES the anti-replay
    // primitive works in isolation; this stage proves auth.verifyJoin
    // composes it correctly post-Stage-4 wiring.
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(makeLoggerSpy()),
    });

    // Stale nonce (3 < cache.nonce=7) — Stage 4 verifyJoin rejects with
    // reason 'replay-nonce' per D-015. This assertion was the forcing-function
    // for the Stage 4 wiring change (previously `.toBe(true)` to pin the gap).
    const staleJoin = await signedJoin(peerKp, ROOM_ID, tokenId, 3);
    const staleResult = await hook.verifyJoin(staleJoin, makeWsStub(), 'trace-s5-stale');
    expect(staleResult.accepted).toBe(false); // ← FLIPPED S55-bis Stage 4
    expect(staleResult.reason).toBe('replay-nonce');
    expect(staleResult.closeCode).toBe(4401);

    // Fresh nonce > cache.nonce=7 — verifyJoin now accepts AND advances the
    // cache high-water mark via the auth.verifyJoin → validateAndAdvanceNonce
    // chain. Confirms post-flip the chain is composable end-to-end.
    const freshJoin = await signedJoin(peerKp, ROOM_ID, tokenId, 8);
    const freshResult = await hook.verifyJoin(freshJoin, makeWsStub(), 'trace-s5-fresh');
    expect(freshResult.accepted).toBe(true);
    // Re-running the same fresh nonce now fails (advanced to 8).
    const replayResult = await hook.verifyJoin(freshJoin, makeWsStub(), 'trace-s5-replay');
    expect(replayResult.accepted).toBe(false);
    expect(replayResult.reason).toBe('replay-nonce');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Scenario 6: RPC partition → strict-reject mode → auth-degraded
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Scenario 6: RPC partition strict-reject (REQ-ADM-009)', () => {
  it('cache.setStrictRejectMode short-circuits get(); auth.verifyJoin returns auth-degraded; clearing resumes normal verify', async () => {
    const { cache, logger: cacheLogger } = mkCache();
    const authLogger = makeLoggerSpy();
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(authLogger),
    });

    const peerKp = Ed25519Keypair.generate();
    const peerPubkey = Array.from(peerKp.getPublicKey().toRawBytes());

    // Pre-populate cache with a valid token.
    cache.handleEvent('CapabilityIssued', {
      tokenId: TOKEN_ID,
      roomId: ROOM_ID,
      peerPubkey,
      role: 2,
      expiresEpoch: FUTURE_EPOCH,
      nonce: 1,
    });

    // Sanity: verify accepts before partition.
    const okJoin = await signedJoin(peerKp, ROOM_ID, TOKEN_ID, 2);
    const okResult = await hook.verifyJoin(okJoin, makeWsStub(), 'trace-s6-pre');
    expect(okResult.accepted).toBe(true);

    // ── Stage A: Simulate RPC partition >30s by flipping strict-reject ──
    cache.setStrictRejectMode('rpc-timeout-30s');

    // cache.get() now short-circuits to null even when entry exists.
    expect(cache.get(TOKEN_ID)).toBeNull();
    expect(cache.isStrictRejectMode()).toBe(true);

    // WARN log on mode entry.
    const strictWarn = (cacheLogger.warn.mock.calls as any[]).find(
      (c) => c[0]?.reason === 'rpc-timeout-30s' && c[0]?.module === 'cap-token-cache',
    );
    expect(strictWarn).toBeDefined();

    // ── Stage B: auth.verifyJoin returns 'auth-degraded' ─────────────────
    const degradedJoin = await signedJoin(peerKp, ROOM_ID, TOKEN_ID, 3);
    const degradedResult = await hook.verifyJoin(degradedJoin, makeWsStub(), 'trace-s6-deg');
    expect(degradedResult.accepted).toBe(false);
    expect(degradedResult.reason).toBe('auth-degraded');
    expect(degradedResult.closeCode).toBe(4401);

    // Audit log for auth-degraded.
    const degradedWarn = (authLogger.warn.mock.calls as any[]).find(
      (c) =>
        c[0]?.trace_id === 'trace-s6-deg' &&
        c[0]?.context?.reason === 'auth-degraded',
    );
    expect(degradedWarn).toBeDefined();

    // ── Stage C: Clear strict-reject → normal verify resumes ─────────────
    cache.clearStrictRejectMode();
    expect(cache.isStrictRejectMode()).toBe(false);

    // Same entry still present (strict-reject doesn't evict, only short-circuits).
    expect(cache.has(TOKEN_ID)).toBe(true);

    const resumeJoin = await signedJoin(peerKp, ROOM_ID, TOKEN_ID, 4);
    const resumeResult = await hook.verifyJoin(resumeJoin, makeWsStub(), 'trace-s6-resume');
    expect(resumeResult.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Bonus: Stage 4 composition smoke test — sanity-check that Issuer + Cache
// + AuthHook can all be instantiated together with shared logger + clock.
// ─────────────────────────────────────────────────────────────────────────

describe('Integration — Bonus: composition smoke test', () => {
  it('all three modules instantiate cleanly with shared logger; verifies the contract for Stage 4 daemon-main bootstrap', async () => {
    const sharedLogger = makeLoggerSpy();
    const { issuer, calls } = mkIssuer({ logger: sharedLogger });
    const { cache } = mkCache({ logger: sharedLogger });
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(sharedLogger),
    });

    // Drive a benign handler to confirm the issuer's logging path composes with
    // the shared logger. (F8 SecretRotated is no longer handled by the issuer —
    // it moved to the TURN-issuer kill-switch, REQ-CRR-005 / D-009.) onRoleChanged
    // with a fixture lacking an affected token logs only — no TX.
    await issuer.onRoleChanged(
      { minerId: '0xminer-smoke', oldRole: 2, newRole: 4, newStake: '1000000000' },
      'trace-smoke',
    );

    // No TX submitted (no affected token to refresh); structured log emitted.
    expect(calls).toHaveLength(0);
    const issuerLog = (sharedLogger.info.mock.calls as any[]).find(
      (c) => c[0]?.trace_id === 'trace-smoke' && c[0]?.module === 'cap-token-issuer',
    );
    expect(issuerLog).toBeDefined();

    // Auth + Cache wire through without throwing.
    expect(hook.registerActiveConnection(new Array(32).fill(0x42), makeWsStub()).accepted).toBe(true);
  });
});
