/**
 * S30.B — TURN credential issuer tests (RED-first → GREEN).
 *
 * Covers:
 *   - Pure helpers: computeTurnCredential / hashCredentialPassword / generateSharedSecret
 *   - TurnIssuer class: rotateSecret, issueFor (happy + slashed-skip + no-secret), markSlashed/isSlashed
 *   - startTurnIssuer loop: bootstrap initial secret, rotate on interval, stop cleanly
 *
 * Uses submitFn dependency injection so tests don't need to mock @mysten/sui.
 * Real wire-in (S30.B.6) maps submitFn to executeWithRetry.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import {
  computeTurnCredential,
  hashCredentialPassword,
  generateSharedSecret,
  TurnIssuer,
  startTurnIssuer,
  TTL_DEFAULT_SEC,
  type SubmitFn,
  type SubmitResult,
} from '../turn-issuer.js';

/** Match the existing cp-daemon test convention (event-handler.test.ts, role-voter style). */
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

describe('computeTurnCredential (pure helper)', () => {
  it('username has form <expiry>:<userId> with expiry = now + ttl', () => {
    const out = computeTurnCredential({
      userId: '0xparticipant',
      secret: Buffer.from('mysecret'),
      ttlSec: 1200,
      nowUnixSec: 1_700_000_000,
    });
    expect(out.username).toBe('1700001200:0xparticipant');
    expect(out.expiry).toBe(1_700_001_200);
  });

  it('password is base64(HMAC-SHA1(secret, username)) per coturn use-auth-secret spec', () => {
    const userId = 'alice';
    const secret = Buffer.from('mysecret');
    const nowUnixSec = 1_700_000_000;
    const ttlSec = 1200;
    const username = `${nowUnixSec + ttlSec}:${userId}`;
    const expected = createHmac('sha1', secret).update(username).digest('base64');

    const out = computeTurnCredential({ userId, secret, ttlSec, nowUnixSec });

    expect(out.password).toBe(expected);
  });

  it('is deterministic for same inputs', () => {
    const args = { userId: 'u', secret: Buffer.from('s'), ttlSec: 1200, nowUnixSec: 1_234_567_890 };
    const a = computeTurnCredential(args);
    const b = computeTurnCredential(args);
    expect(a).toEqual(b);
  });

  it('different secrets produce different passwords with same username', () => {
    const base = { userId: 'u', ttlSec: 1200, nowUnixSec: 1_234_567_890 };
    const a = computeTurnCredential({ ...base, secret: Buffer.from('secret-a') });
    const b = computeTurnCredential({ ...base, secret: Buffer.from('secret-b') });
    expect(a.password).not.toBe(b.password);
    expect(a.username).toBe(b.username);
  });
});

describe('hashCredentialPassword (pure helper)', () => {
  it('returns 32-byte Uint8Array (SHA-256 digest length)', () => {
    const out = hashCredentialPassword('any-password');
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(32);
  });

  it('matches node:crypto SHA-256', () => {
    const pwd = 'aGVsbG8=';
    const expected = createHash('sha256').update(pwd).digest();
    const out = hashCredentialPassword(pwd);
    expect(Buffer.from(out).equals(expected)).toBe(true);
  });

  it('is deterministic', () => {
    const a = hashCredentialPassword('x');
    const b = hashCredentialPassword('x');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('generateSharedSecret (pure helper)', () => {
  it('returns 32 bytes', () => {
    expect(generateSharedSecret().length).toBe(32);
  });

  it('produces different bytes across calls (entropy)', () => {
    const a = generateSharedSecret();
    const b = generateSharedSecret();
    expect(a.equals(b)).toBe(false);
  });
});

describe('TurnIssuer', () => {
  let submitCalls: Array<{ label: string; args: Record<string, unknown> }>;
  let submitFn: SubmitFn;

  beforeEach(() => {
    submitCalls = [];
    submitFn = vi.fn(async (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult> => {
      submitCalls.push({ label: opts.label, args: opts.args });
      return { digest: `fake-digest-${submitCalls.length}` };
    });
  });

  describe('rotateSecret', () => {
    it('first call sets secretId=1 and stores a 32-byte secret', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      const out = await iss.rotateSecret();
      expect(out.secretId).toBe(1);
      expect(out.secret.length).toBe(32);
      expect(iss.currentSecretId()).toBe(1);
      expect(iss.getSecret(1)).toBeDefined();
    });

    it('second call sets secretId=2; older secret still retrievable for overlap window', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      const a = await iss.rotateSecret();
      const b = await iss.rotateSecret();
      expect(a.secretId).toBe(1);
      expect(b.secretId).toBe(2);
      expect(iss.getSecret(1)).toBeDefined();
      expect(iss.getSecret(2)).toBeDefined();
      expect(iss.getSecret(1)!.equals(iss.getSecret(2)!)).toBe(false);
      expect(iss.currentSecretId()).toBe(2);
    });

    it('emits provision_turn_secret PTB call with packageId-prefixed target + correct args', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await iss.rotateSecret();
      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0]!.label).toBe('provision-turn-secret');
      expect(submitCalls[0]!.args).toMatchObject({
        target: '0xpkg::turn_credential::provision_turn_secret',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        secretId: 1,
      });
    });
  });

  describe('issueFor', () => {
    it('happy path: returns credentials + emits issue_turn_credential PTB', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await iss.rotateSecret();
      submitCalls.length = 0;

      const out = await iss.issueFor({
        targetMinerId: '0xrelay',
        userId: '0xuser',
        ttlSec: 1200,
        nowUnixSec: 1_700_000_000,
      });

      if ('skipped' in out) throw new Error('unexpected skipped path');

      expect(out.username).toBe('1700001200:0xuser');
      expect(out.expiry).toBe(1_700_001_200);
      expect(typeof out.password).toBe('string');
      expect(out.password.length).toBeGreaterThan(0);
      expect(out.credentialHash).toBeInstanceOf(Uint8Array);
      expect(out.credentialHash.length).toBe(32);
      expect(out.secretId).toBe(1);
      expect(out.txDigest).toBeTruthy();

      expect(submitCalls).toHaveLength(1);
      expect(submitCalls[0]!.label).toBe('issue-turn-credential');
      expect(submitCalls[0]!.args).toMatchObject({
        target: '0xpkg::turn_credential::issue_turn_credential',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        targetMinerId: '0xrelay',
        ttlSec: 1200,
        secretId: 1,
      });
      // credentialHash bytes in PTB args must match the returned hash
      const submittedHash = submitCalls[0]!.args.credentialHash as Uint8Array;
      expect(Array.from(submittedHash)).toEqual(Array.from(out.credentialHash));
    });

    it('credentialHash equals SHA-256(password)', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await iss.rotateSecret();
      const out = await iss.issueFor({
        targetMinerId: '0xrelay',
        userId: '0xu',
        nowUnixSec: 1000,
      });
      if ('skipped' in out) throw new Error('unexpected skipped path');
      const expected = createHash('sha256').update(out.password).digest();
      expect(Buffer.from(out.credentialHash).equals(expected)).toBe(true);
    });

    it('defaults ttlSec to TTL_DEFAULT_SEC (1200) when omitted', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await iss.rotateSecret();
      const out = await iss.issueFor({
        targetMinerId: '0xrelay',
        userId: '0xu',
        nowUnixSec: 1000,
      });
      if ('skipped' in out) throw new Error('unexpected skipped path');
      expect(out.expiry).toBe(1000 + TTL_DEFAULT_SEC);
      expect(TTL_DEFAULT_SEC).toBe(1200);
    });

    it('throws if no rotation has happened yet (no secret available)', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await expect(
        iss.issueFor({ targetMinerId: '0xrelay', userId: '0xu', nowUnixSec: 1000 }),
      ).rejects.toThrow(/no shared secret/i);
    });

    it('skips when target is marked slashed; returns { skipped, reason } and emits NO PTB', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await iss.rotateSecret();
      iss.markSlashed('0xbadrelay');
      submitCalls.length = 0;

      const out = await iss.issueFor({
        targetMinerId: '0xbadrelay',
        userId: '0xu',
        nowUnixSec: 1000,
      });

      expect('skipped' in out).toBe(true);
      if ('skipped' in out) {
        expect(out.skipped).toBe(true);
        expect(out.reason).toBe('slashed');
      }
      expect(submitCalls).toHaveLength(0);
    });

    it('continues to issue for non-slashed targets when others are slashed', async () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      await iss.rotateSecret();
      iss.markSlashed('0xbad');
      submitCalls.length = 0;

      const out = await iss.issueFor({
        targetMinerId: '0xgood',
        userId: '0xu',
        nowUnixSec: 1000,
      });
      expect('skipped' in out).toBe(false);
      expect(submitCalls).toHaveLength(1);
    });
  });

  describe('markSlashed / isSlashed', () => {
    it('isSlashed defaults to false; markSlashed flips it', () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      expect(iss.isSlashed('0xany')).toBe(false);
      iss.markSlashed('0xrelay1');
      expect(iss.isSlashed('0xrelay1')).toBe(true);
      expect(iss.isSlashed('0xrelay2')).toBe(false);
    });

    it('markSlashed is idempotent', () => {
      const iss = new TurnIssuer({
        submitFn,
        packageId: '0xpkg',
        networkRegistryId: '0xnet',
        cpCapId: '0xcap',
        logger: mockLogger(),
      });
      iss.markSlashed('0xrelay1');
      iss.markSlashed('0xrelay1');
      expect(iss.isSlashed('0xrelay1')).toBe(true);
    });
  });
});

describe('startTurnIssuer (loop)', () => {
  let submitCalls: Array<{ label: string; args: Record<string, unknown> }>;
  let submitFn: SubmitFn;

  beforeEach(() => {
    submitCalls = [];
    submitFn = vi.fn(async (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult> => {
      submitCalls.push({ label: opts.label, args: opts.args });
      return { digest: `fake-${submitCalls.length}` };
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('bootstraps an initial secret on start (secretId=1)', async () => {
    const { issuer, stop } = await startTurnIssuer({
      submitFn,
      packageId: '0xp',
      networkRegistryId: '0xn',
      cpCapId: '0xc',
      logger: mockLogger(),
      rotateIntervalMs: 10_000,
    });
    expect(issuer.currentSecretId()).toBe(1);
    expect(submitCalls).toHaveLength(1);
    expect(submitCalls[0]!.label).toBe('provision-turn-secret');
    stop();
  });

  it('rotates again after rotateIntervalMs elapses', async () => {
    const { issuer, stop } = await startTurnIssuer({
      submitFn,
      packageId: '0xp',
      networkRegistryId: '0xn',
      cpCapId: '0xc',
      logger: mockLogger(),
      rotateIntervalMs: 10_000,
    });
    expect(issuer.currentSecretId()).toBe(1);
    submitCalls.length = 0;

    await vi.advanceTimersByTimeAsync(10_000);

    expect(issuer.currentSecretId()).toBe(2);
    expect(submitCalls.length).toBeGreaterThanOrEqual(1);
    expect(submitCalls[0]!.label).toBe('provision-turn-secret');
    stop();
  });

  it('stop() halts further rotations', async () => {
    const { issuer, stop } = await startTurnIssuer({
      submitFn,
      packageId: '0xp',
      networkRegistryId: '0xn',
      cpCapId: '0xc',
      logger: mockLogger(),
      rotateIntervalMs: 10_000,
    });
    stop();
    submitCalls.length = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(submitCalls).toHaveLength(0);
    expect(issuer.currentSecretId()).toBe(1);
  });
});
