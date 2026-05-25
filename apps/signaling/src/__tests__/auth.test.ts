/**
 * Phase 3.2 — Capability-token auth + 1-WS-per-peer (Lane C).
 *
 * REQ-ADM-004: capability verify on WS join (7 reject + 1 accept scenarios).
 * REQ-ADM-008: 1-WS-per-peer-pubkey, second-attempt-loses (D-010-D).
 *
 * Source of truth invariants:
 * - token in JoinMessage = token_id STRING, NOT BCS blob (D-010-C).
 * - second-attempt-loses (D-010-D): incumbent WS kept; new attempt rejected.
 * - ed25519_verify uses peer_pubkey from CACHED token, NOT JoinMessage (T2 threat).
 * - Every reject MUST emit pino WARN with trace_id (workspace structured-logging).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs } from '@mysten/sui/bcs';
import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import {
  AuthHook,
  type JoinAuthMessage,
  type AuthCacheConsumer,
  type CachedTokenSnapshot,
} from '../auth.js';

// ── Test scaffolding ─────────────────────────────────────────────────────

/** Build the canonical join payload that the peer signs. Must match auth.ts derivation. */
function buildCanonicalJoinPayload(roomId: string, peerPubkey: number[], nonce: number): Uint8Array {
  return bcs
    .struct('JoinPayload', {
      roomId: bcs.string(),
      peerPubkey: bcs.vector(bcs.u8()),
      nonce: bcs.u64(),
    })
    .serialize({ roomId, peerPubkey, nonce: BigInt(nonce) })
    .toBytes();
}

/** Minimal pino-shaped logger spy. Stand-in for the full pino Logger surface. */
type LoggerSpy = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};
function makeLoggerSpy(): LoggerSpy {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
function asLogger(spy: LoggerSpy): Logger {
  return spy as unknown as Logger;
}

/** Build an in-memory mock of the lane-d CapTokenCache consumer interface.
 *
 * When `nonceState` is provided, the mock exposes `validateAndAdvanceNonce`
 * (Stage 4 wiring per D-013). When omitted, the property is undefined and the
 * Stage 4 nonce-check branch in auth.ts.verifyJoin is a no-op — this preserves
 * the Stage 1-3 behavioral contract for the existing 7-reject+1-accept tests.
 */
function makeMockCache(
  initial: Map<string, CachedTokenSnapshot>,
  strictMode = false,
  nonceState?: Map<string, number>,
): AuthCacheConsumer {
  const store = new Map(initial);
  const nonces = nonceState !== undefined ? new Map(nonceState) : undefined;
  return {
    get(tokenId: string): CachedTokenSnapshot | null {
      if (strictMode) return null;
      return store.get(tokenId) ?? null;
    },
    has(tokenId: string): boolean {
      return !strictMode && store.has(tokenId);
    },
    isStrictRejectMode(): boolean {
      return strictMode;
    },
    ...(nonces !== undefined
      ? {
          validateAndAdvanceNonce(tokenId: string, incoming: number): boolean {
            if (!store.has(tokenId)) return false;
            const current = nonces.get(tokenId) ?? 1;
            if (incoming <= current) return false;
            nonces.set(tokenId, incoming);
            return true;
          },
        }
      : {}),
  };
}

/** Minimal WebSocket stub — only the `close` method is exercised by AuthHook. */
function makeWsStub(): WebSocket {
  return {
    close: vi.fn(),
    readyState: 1,
  } as unknown as WebSocket;
}

const ROOM_ID = '0xroom1';
const OTHER_ROOM = '0xroom2';
const TOKEN_ID = '0xtoken_abc';
const CURRENT_EPOCH = 100n;
const FUTURE_EPOCH = 200n;
const PAST_EPOCH = 50n;

async function signedJoin(
  kp: Ed25519Keypair,
  roomId: string,
  tokenId: string,
  nonce = 1,
): Promise<JoinAuthMessage> {
  const peerPubkey = Array.from(kp.getPublicKey().toRawBytes());
  const payload = buildCanonicalJoinPayload(roomId, peerPubkey, nonce);
  const sigBytes = await kp.sign(payload);
  const signature = Buffer.from(sigBytes).toString('base64');
  return { type: 'join', roomId, token: tokenId, signature, nonce };
}

// ── REQ-ADM-004: 7 reject + 1 accept ─────────────────────────────────────

describe('AuthHook.verifyJoin — REQ-ADM-004', () => {
  let kp: Ed25519Keypair;
  let peerPubkey: number[];
  let logger: ReturnType<typeof makeLoggerSpy>;

  beforeEach(() => {
    kp = Ed25519Keypair.generate();
    peerPubkey = Array.from(kp.getPublicKey().toRawBytes());
    logger = makeLoggerSpy();
  });

  it('accept_valid: cached + signed + room+peer match → accepted:true', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);
    const result = await hook.verifyJoin(msg, makeWsStub(), 't-accept');

    expect(result.accepted).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('reject_no_token: empty token string → no-token + 4401', async () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, '');

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-no-token');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-token');
    expect(result.closeCode).toBe(4401);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ trace_id: 't-no-token', module: 'auth' }),
      expect.any(String),
    );
  });

  it('reject_invalid_sig: cache hit but bad signature → invalid-signature + 4401', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);
    msg.signature = msg.signature.slice(0, -4) + 'AAAA'; // corrupt last 3 bytes (base64)

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-bad-sig');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid-signature');
    expect(result.closeCode).toBe(4401);
  });

  it('reject_expired: cached but expiresEpoch <= current → expired + 4401', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: PAST_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-expired');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('expired');
    expect(result.closeCode).toBe(4401);
  });

  it('reject_revoked: cached but revoked=true → revoked + 4403', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: true,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-revoked');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('revoked');
    expect(result.closeCode).toBe(4403);
  });

  it('reject_wrong_room: cached roomId !== JoinMessage roomId → wrong-room + 4401', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: OTHER_ROOM,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-wrong-room');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('wrong-room');
    expect(result.closeCode).toBe(4401);
  });

  it('reject_wrong_peer: cached peerPubkey !== sig recovery pubkey → wrong-peer + 4401', async () => {
    const otherKp = Ed25519Keypair.generate();
    const otherPubkey = Array.from(otherKp.getPublicKey().toRawBytes());
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey: otherPubkey, // cache says token belongs to otherKp
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID); // signed by kp, NOT otherKp

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-wrong-peer');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid-signature');
    expect(result.closeCode).toBe(4401);
  });

  it('reject_auth_degraded: cache in strict-reject mode → auth-degraded + 4401', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
      true, // strict mode ON
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-degraded');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('auth-degraded');
    expect(result.closeCode).toBe(4401);
  });

  it('reject_cache_miss: token_id not cached + not strict mode → no-token + 4401', async () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, '0xunknown');

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-miss');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-token');
  });

  // ── Stage 4 Item #5 — nonce chain wiring (REQ-ADM-013-extended) ──────

  it('reject_replay_nonce: cache.validateAndAdvanceNonce returns false after sig verify → replay-nonce + 4401', async () => {
    // Seed cache with peer's high-water mark at 5 (prior session).
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
      false,
      new Map([[TOKEN_ID, 5]]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    // Sign with stale nonce (3 < cache water-mark 5).
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID, 3);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-replay');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('replay-nonce');
    expect(result.closeCode).toBe(4401);
  });

  it('accept then replay rejected: monotonic per-token nonce advancement', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
      false,
      new Map([[TOKEN_ID, 1]]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    // First call at nonce=2 (> 1) advances + accepts.
    const msg1 = await signedJoin(kp, ROOM_ID, TOKEN_ID, 2);
    const r1 = await hook.verifyJoin(msg1, makeWsStub(), 't-n1');
    expect(r1.accepted).toBe(true);

    // Replaying the SAME nonce=2 now fails (==current).
    const r2 = await hook.verifyJoin(msg1, makeWsStub(), 't-n2');
    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe('replay-nonce');

    // nonce=3 (> 2) advances + accepts.
    const msg3 = await signedJoin(kp, ROOM_ID, TOKEN_ID, 3);
    const r3 = await hook.verifyJoin(msg3, makeWsStub(), 't-n3');
    expect(r3.accepted).toBe(true);
  });

  it('nonce check runs AFTER sig verify (sig fails first if both broken)', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
      false,
      new Map([[TOKEN_ID, 10]]),
    );
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    // Stale nonce AND bad sig — sig check fires first.
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID, 5);
    msg.signature = msg.signature.slice(0, -4) + 'AAAA';

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-order');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid-signature');
  });

  // ── Stage 4 Item #7 — devInspect 'revoked' fallback (REQ-ADM-016-partial) ─

  it('devInspect fallback: cache miss + chain reports revoked → reason=revoked + 4403', async () => {
    const cache = makeMockCache(new Map()); // empty cache
    const chainProbe = vi.fn(async (tokenId: string) => {
      expect(tokenId).toBe(TOKEN_ID);
      return { revoked: true };
    });
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(logger),
      chainProbe,
    });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-devinspect-revoked');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('revoked');
    expect(result.closeCode).toBe(4403);
    expect(chainProbe).toHaveBeenCalledTimes(1);
  });

  it('devInspect fallback: cache miss + chain reports unknown → reason=no-token (existing behavior)', async () => {
    const cache = makeMockCache(new Map());
    const chainProbe = vi.fn(async () => null); // chain has no record
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(logger),
      chainProbe,
    });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-devinspect-unknown');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-token');
    expect(result.closeCode).toBe(4401);
    expect(chainProbe).toHaveBeenCalledTimes(1);
  });

  it('devInspect fallback: probe throws → fall back to no-token (no escalation, audit logged)', async () => {
    const cache = makeMockCache(new Map());
    const chainProbe = vi.fn(async () => {
      throw new Error('rpc-timeout');
    });
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(logger),
      chainProbe,
    });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-devinspect-throws');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-token');
    expect(result.closeCode).toBe(4401);
    // Probe failure logged for audit.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'auth' }),
      expect.stringMatching(/devInspect|probe/i),
    );
  });

  it('devInspect fallback: cache hit short-circuits — probe NOT called', async () => {
    const cache = makeMockCache(
      new Map([
        [
          TOKEN_ID,
          {
            tokenId: TOKEN_ID,
            roomId: ROOM_ID,
            peerPubkey,
            role: 2,
            expiresEpoch: FUTURE_EPOCH,
            revoked: false,
          },
        ],
      ]),
    );
    const chainProbe = vi.fn();
    const hook = new AuthHook({
      cache,
      currentEpoch: () => CURRENT_EPOCH,
      logger: asLogger(logger),
      chainProbe,
    });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-devinspect-skip');

    expect(result.accepted).toBe(true);
    expect(chainProbe).not.toHaveBeenCalled();
  });

  it('devInspect fallback: not configured (no chainProbe) → preserves Stage 3 no-token behavior', async () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, TOKEN_ID);

    const result = await hook.verifyJoin(msg, makeWsStub(), 't-devinspect-none');

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no-token');
  });

  it('audit log: every reject emits pino.warn with trace_id + peer_pubkey_prefix', async () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });
    const msg = await signedJoin(kp, ROOM_ID, '0xunknown');

    await hook.verifyJoin(msg, makeWsStub(), 't-audit');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const call = logger.warn.mock.calls[0]!;
    const ctx = call[0] as Record<string, unknown>;
    expect(ctx).toMatchObject({
      trace_id: 't-audit',
      module: 'auth',
    });
    expect(ctx['context']).toMatchObject({ reason: 'no-token' });
    // peer_pubkey_prefix = first 8 hex chars; never log full pubkey (privacy).
    const context = ctx['context'] as Record<string, unknown>;
    expect(context['peer_pubkey_prefix']).toBeTypeOf('string');
    expect((context['peer_pubkey_prefix'] as string).length).toBeLessThanOrEqual(16);
  });
});

// ── REQ-ADM-008: 1-WS-per-peer second-attempt-loses (D-010-D) ────────────

describe('AuthHook.registerActiveConnection — REQ-ADM-008', () => {
  let kp: Ed25519Keypair;
  let peerPubkey: number[];
  let logger: ReturnType<typeof makeLoggerSpy>;

  beforeEach(() => {
    kp = Ed25519Keypair.generate();
    peerPubkey = Array.from(kp.getPublicKey().toRawBytes());
    logger = makeLoggerSpy();
  });

  it('first connection registers cleanly → accepted:true', () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    const result = hook.registerActiveConnection(peerPubkey, makeWsStub());

    expect(result.accepted).toBe(true);
  });

  it('conflict_on_second_WS: same peer_pubkey reconnects → duplicate-connection + 4409 (D-010-D)', () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    const ws1 = makeWsStub();
    const r1 = hook.registerActiveConnection(peerPubkey, ws1);
    expect(r1.accepted).toBe(true);

    // Second attempt with SAME peer_pubkey — must lose per D-010-D.
    const ws2 = makeWsStub();
    const r2 = hook.registerActiveConnection(peerPubkey, ws2);

    expect(r2.accepted).toBe(false);
    expect(r2.reason).toBe('duplicate-connection');
    expect(r2.closeCode).toBe(4409);
    // Incumbent must NOT be closed — first wins per T2 threat model.
    expect((ws1.close as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('different peers can both register → both accepted', () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    const otherKp = Ed25519Keypair.generate();
    const otherPubkey = Array.from(otherKp.getPublicKey().toRawBytes());

    const r1 = hook.registerActiveConnection(peerPubkey, makeWsStub());
    const r2 = hook.registerActiveConnection(otherPubkey, makeWsStub());

    expect(r1.accepted).toBe(true);
    expect(r2.accepted).toBe(true);
  });

  it('audit log on conflict: WARN with trace_id-equivalent metadata', () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    hook.registerActiveConnection(peerPubkey, makeWsStub());
    hook.registerActiveConnection(peerPubkey, makeWsStub());

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ module: 'auth' }),
      expect.stringContaining('duplicate'),
    );
  });

  it('closeOnConflict: force-closes incumbent for given peer_pubkey', () => {
    const cache = makeMockCache(new Map());
    const hook = new AuthHook({ cache, currentEpoch: () => CURRENT_EPOCH, logger: asLogger(logger) });

    const ws = makeWsStub();
    hook.registerActiveConnection(peerPubkey, ws);
    hook.closeOnConflict(peerPubkey);

    expect((ws.close as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(4403, expect.any(String));
  });
});
