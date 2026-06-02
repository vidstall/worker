/**
 * S30.B — TURN credential issuer (cp-daemon module).
 *
 * Issues coturn `use-auth-secret` REST API credentials per ADR-0005:
 *   username = "<expiry_unix_ts>:<userId>"
 *   password = base64(HMAC-SHA1(per_relay_shared_secret, username))
 *
 * Maintains a rolling map of shared secrets keyed by secret_id so the 2-secret
 * overlap window (ADR-0005 § Per-relay shared secret lifecycle) is honoured —
 * credentials minted under an older secret_id stay redeemable through their
 * full TTL while a new id takes over going forward.
 *
 * Hybrid rotation: periodic 24h cron + on-slash kill-switch (handled by
 * event-handler.ts forwarding RelaySlashed → markSlashed).
 *
 * Scope (S30.B Option A — pure issuer):
 *   - HMAC compute + on-chain audit anchor via PTB
 *   - In-memory slashedRelays Set (kill-switch hook)
 *   - NO encrypted blob delivery to relay (deferred S30.C/D)
 *   - NO signaling RPC delivery to client (deferred S30.C)
 *   - NO coturn lifecycle integration (assumes co-located with relay)
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type Logger } from '@dvconf/shared';

// ── TTL bounds (mirror Move-side dvconf::turn_credential 800-band) ──────
export const TTL_MIN_SEC = 900;
export const TTL_DEFAULT_SEC = 1_200;
export const TTL_MAX_SEC = 1_800;

const SHARED_SECRET_BYTES = 32;
const DEFAULT_ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

// ── Result shapes ─────────────────────────────────────────────────────

export interface CredentialResult {
  username: string;
  password: string;
  expiry: number;
  credentialHash: Uint8Array;
  secretId: number;
  txDigest: string;
}

export interface SkippedResult {
  skipped: true;
  reason: 'slashed';
}

export type IssueResult = CredentialResult | SkippedResult;

export interface SubmitResult {
  digest: string;
}

/**
 * Dependency injection point for tests. Production wires submit → executeWithRetry
 * via {@link makeExecuteWithRetrySubmit}.
 */
export interface SubmitFn {
  (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult>;
}

export interface TurnIssuerOptions {
  submitFn: SubmitFn;
  packageId: string;
  networkRegistryId: string;
  cpCapId: string;
  logger: Logger;
}

export interface RotateResult {
  secretId: number;
  secret: Buffer;
}

// ── Pure helpers ─────────────────────────────────────────────────────

export function computeTurnCredential(opts: {
  userId: string;
  secret: Buffer;
  ttlSec: number;
  nowUnixSec: number;
}): { username: string; password: string; expiry: number } {
  const expiry = opts.nowUnixSec + opts.ttlSec;
  const username = `${expiry}:${opts.userId}`;
  const password = createHmac('sha1', opts.secret).update(username).digest('base64');
  return { username, password, expiry };
}

export function hashCredentialPassword(password: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(password).digest());
}

export function generateSharedSecret(): Buffer {
  return randomBytes(SHARED_SECRET_BYTES);
}

// ── TurnIssuer class ─────────────────────────────────────────────────

export class TurnIssuer {
  private readonly _submitFn: SubmitFn;
  private readonly _packageId: string;
  private readonly _networkRegistryId: string;
  private readonly _cpCapId: string;
  private readonly _logger: Logger;
  private readonly _secrets: Map<number, Buffer> = new Map();
  private readonly _slashedRelays: Set<string> = new Set();
  private _currentSecretId: number = 0;

  constructor(opts: TurnIssuerOptions) {
    this._submitFn = opts.submitFn;
    this._packageId = opts.packageId;
    this._networkRegistryId = opts.networkRegistryId;
    this._cpCapId = opts.cpCapId;
    this._logger = opts.logger;
  }

  currentSecretId(): number {
    return this._currentSecretId;
  }

  getSecret(secretId: number): Buffer | undefined {
    return this._secrets.get(secretId);
  }

  isSlashed(relayMinerId: string): boolean {
    return this._slashedRelays.has(relayMinerId);
  }

  markSlashed(relayMinerId: string): void {
    this._slashedRelays.add(relayMinerId);
    this._logger.info(
      { relayMinerId },
      'TURN issuer: relay marked slashed; new credentials will be skipped',
    );
  }

  /**
   * F8 (REQ-CRR-005) — emergency kill-switch for a LEAKED TURN shared secret.
   *
   * Drops `secretId` from the in-memory secret map IMMEDIATELY, deliberately
   * overriding the normal 2-secret overlap-grace window (ADR-0005 § Per-relay
   * shared secret lifecycle): an emergency rotation means the old secret is
   * compromised, so the daemon must stop serving/reusing it now rather than
   * honour it through its full TTL. Mirrors the `markSlashed` kill-switch
   * precedent (chain `RelaySlashed` → `markSlashed`); here it is the chain
   * `turn_credential::SecretRotated` event → `emergencyEvictSecret`.
   *
   * Idempotent: a replay of the same on-chain `SecretRotated` event is a no-op.
   * Returns true iff a secret was actually present and evicted; false when there
   * was nothing to evict (already-evicted / unknown secret_id) — the caller uses
   * this for no-op dedupe logging.
   *
   * Scope boundary (honest, no silent cap): this is issuance-side enforcement in
   * the cp-daemon only. The coturn-side secret eviction + multi-CP coordination
   * remain the deferred operational piece (see this module's scope header — "NO
   * coturn lifecycle integration").
   */
  emergencyEvictSecret(secretId: number, reason: number): boolean {
    const evicted = this._secrets.delete(secretId);
    this._logger.warn(
      {
        module: 'turn-issuer',
        context: { secret_id: secretId, reason, evicted, action: 'emergency_evict_secret' },
      },
      evicted
        ? 'TURN issuer: emergency-evicted leaked secret (F8 kill-switch)'
        : 'TURN issuer: emergency-evict no-op — secret_id not present (already evicted / unknown)',
    );
    return evicted;
  }

  async rotateSecret(): Promise<RotateResult> {
    const secretId = this._currentSecretId + 1;
    const secret = generateSharedSecret();
    this._secrets.set(secretId, secret);
    this._currentSecretId = secretId;

    const result = await this._submitFn({
      label: 'provision-turn-secret',
      args: {
        target: `${this._packageId}::turn_credential::provision_turn_secret`,
        networkRegistryId: this._networkRegistryId,
        cpCapId: this._cpCapId,
        secretId,
      },
    });

    this._logger.info(
      { secretId, txDigest: result.digest },
      'TURN secret rotated + provisioned on chain',
    );
    return { secretId, secret };
  }

  async issueFor(opts: {
    targetMinerId: string;
    userId: string;
    ttlSec?: number;
    nowUnixSec?: number;
  }): Promise<IssueResult> {
    if (this.isSlashed(opts.targetMinerId)) {
      this._logger.info(
        { targetMinerId: opts.targetMinerId, userId: opts.userId },
        'TURN issuer: skipping credential issuance for slashed relay',
      );
      return { skipped: true, reason: 'slashed' };
    }

    const secretId = this._currentSecretId;
    const secret = this._secrets.get(secretId);
    if (!secret) {
      throw new Error(
        'TurnIssuer.issueFor: no shared secret available — call rotateSecret() first',
      );
    }

    const ttlSec = opts.ttlSec ?? TTL_DEFAULT_SEC;
    const nowUnixSec = opts.nowUnixSec ?? Math.floor(Date.now() / 1000);
    const { username, password, expiry } = computeTurnCredential({
      userId: opts.userId,
      secret,
      ttlSec,
      nowUnixSec,
    });
    const credentialHash = hashCredentialPassword(password);

    const result = await this._submitFn({
      label: 'issue-turn-credential',
      args: {
        target: `${this._packageId}::turn_credential::issue_turn_credential`,
        networkRegistryId: this._networkRegistryId,
        cpCapId: this._cpCapId,
        targetMinerId: opts.targetMinerId,
        ttlSec,
        credentialHash,
        secretId,
      },
    });

    this._logger.info(
      {
        targetMinerId: opts.targetMinerId,
        userId: opts.userId,
        secretId,
        expiry,
        txDigest: result.digest,
      },
      'TURN credential issued + anchored on chain',
    );

    return {
      username,
      password,
      expiry,
      credentialHash,
      secretId,
      txDigest: result.digest,
    };
  }
}

// ── Loop wrapper ─────────────────────────────────────────────────────

export interface StartTurnIssuerOptions {
  submitFn?: SubmitFn;
  client?: SuiClient;
  signer?: Ed25519Keypair;
  packageId: string;
  networkRegistryId: string;
  cpCapId: string;
  logger: Logger;
  rotateIntervalMs?: number;
}

export interface StartTurnIssuerResult {
  issuer: TurnIssuer;
  stop: () => void;
}

/**
 * Bootstrap a TurnIssuer with an initial secret + schedule periodic rotation.
 *
 * Production: pass `client` + `signer`; the wrapper builds the executeWithRetry
 * submitFn for you. Tests: pass `submitFn` directly to inspect PTB args without
 * mocking `@mysten/sui`.
 */
export async function startTurnIssuer(
  opts: StartTurnIssuerOptions,
): Promise<StartTurnIssuerResult> {
  const submitFn = opts.submitFn ?? makeExecuteWithRetrySubmit(opts);
  const rotateIntervalMs = opts.rotateIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;

  const issuer = new TurnIssuer({
    submitFn,
    packageId: opts.packageId,
    networkRegistryId: opts.networkRegistryId,
    cpCapId: opts.cpCapId,
    logger: opts.logger,
  });

  await issuer.rotateSecret();

  const handle = setInterval(() => {
    void issuer.rotateSecret().catch((err: unknown) => {
      opts.logger.error({ err }, 'TURN secret rotation failed');
    });
  }, rotateIntervalMs);

  opts.logger.info(
    { rotateIntervalMs },
    'TurnIssuer started; periodic rotation scheduled',
  );

  return {
    issuer,
    stop: () => {
      clearInterval(handle);
      opts.logger.info('TurnIssuer stopped');
    },
  };
}

/**
 * Default production submitFn: builds a Transaction and calls executeWithRetry.
 * Dispatches by `label`:
 *   - `provision-turn-secret` → `<pkg>::turn_credential::provision_turn_secret(net, cap, secret_id, ctx)`
 *   - `issue-turn-credential` → `<pkg>::turn_credential::issue_turn_credential(net, cap, target, ttl, hash, secret_id, ctx)`
 */
function makeExecuteWithRetrySubmit(opts: StartTurnIssuerOptions): SubmitFn {
  if (!opts.client || !opts.signer) {
    throw new Error(
      'startTurnIssuer: either submitFn or (client + signer) must be provided',
    );
  }
  const client = opts.client;
  const signer = opts.signer;
  const logger = opts.logger;

  return async ({ label, args }): Promise<SubmitResult> => {
    const result = await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        const target = args['target'] as `${string}::${string}::${string}`;
        if (label === 'provision-turn-secret') {
          tx.moveCall({
            target,
            arguments: [
              tx.object(args['networkRegistryId'] as string),
              tx.object(args['cpCapId'] as string),
              tx.pure.u64(BigInt(args['secretId'] as number)),
            ],
          });
        } else if (label === 'issue-turn-credential') {
          tx.moveCall({
            target,
            arguments: [
              tx.object(args['networkRegistryId'] as string),
              tx.object(args['cpCapId'] as string),
              tx.pure.id(args['targetMinerId'] as string),
              tx.pure.u64(BigInt(args['ttlSec'] as number)),
              tx.pure.vector('u8', Array.from(args['credentialHash'] as Uint8Array)),
              tx.pure.u64(BigInt(args['secretId'] as number)),
            ],
          });
        } else {
          throw new Error(`TurnIssuer submitFn: unknown label "${label}"`);
        }
      },
      label,
      logger,
    );
    if (!result) {
      throw new Error(
        `TurnIssuer submitFn: executeWithRetry returned null for ${label}`,
      );
    }
    return { digest: result.digest };
  };
}
