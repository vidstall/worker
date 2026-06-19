/**
 * REQ-CFA-001 / D-CFA-10 — Canary-keying module (validator-daemon).
 *
 * Derives K_canary from a per-cell out-of-band `cellSecret` via the SHIPPED
 * `PathCKeyDerivation` salt-mix (dvconf-client/src/lib/crypto/e2ee-spike.ts) and hands
 * out restart-DURABLE monotone `canaryKid`s. This is a THIN wrapper: it does NOT
 * reimplement HKDF / the salt-mix — it maps cellSecret -> oobSecret and canaryKid ->
 * kid and delegates to PathC, so the "throw without oobSecret" covertness guard is
 * INHERITED, never re-implemented (a relay / non-cell member with K_room but no
 * cellSecret derives a DIFFERENT key and AES-GCM-fails on canary frames).
 *
 * DURABILITY (M2-P2 nonce-reuse precedent): a restarted publisher that reused
 * (K, kid, ctr=0) would re-introduce (key, IV) reuse — a catastrophic AES-GCM break.
 * The in-memory page-lifetime counter the client uses (`ctrHighWater`,
 * encoded-transform-shim.ts:75) resets on reload; this allocator instead persists a
 * per-streamId high-water to disk so the next kid after a restart is strictly greater
 * than the last one issued.
 *
 * LOGGING (HARD-GATE): NEVER log key material, cellSecret, or derived bits. The only
 * structured log here is the durable-store path + streamId/kid integers (no secrets).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// Cross-repo import (Mechanism A, mirrors the relay integration test): 5-level `../`
// from apps/validator-daemon/src/canary -> the client crypto lib. The salt-mix is the
// production stack's, verbatim.
import {
  PathCKeyDerivation,
  type KeyDerivationInput,
} from '../../../../../dvconf-client/src/lib/crypto/e2ee-spike.js';
import { createLogger } from '@dvconf/shared';

const MOD = 'canary/keying';
const log = createLogger(MOD);

/**
 * Deterministic canary-sender domain separator folded into the HKDF `info`. The canary
 * is a synthetic publisher; pinning its senderId to a constant (a) domain-separates the
 * canary stream from every real publisher's K_content (so a canary frame's IV=[kid|ctr]
 * never collides with a real sender's under the same K_room) and (b) makes the derived
 * key reproducible by the auditor for the SAME (kRoom, roomId, kid, cellSecret) inputs.
 */
export const CANARY_SENDER_ID = 'dvconf-canary/v1';

/** Inputs to the canary key derivation. `cellSecret` is the per-cell OOB factor. */
export interface CanaryKeyInput {
  kRoom: Uint8Array;
  roomId: string;
  canaryKid: number;
  /** Per-cell out-of-band secret (>=128-bit). Maps to PathC `oobSecret` (the salt). */
  cellSecret: Uint8Array;
}

const derivation = new PathCKeyDerivation();

/** Map canary inputs onto the SHIPPED PathC `KeyDerivationInput` (cellSecret->oobSecret,
 *  canaryKid->kid, fixed canary senderId). cellSecret may be undefined here so the
 *  PathC salt-guard throws 'Path C requires oobSecret' instead of us pre-checking. */
function toPathCInput(input: CanaryKeyInput): KeyDerivationInput {
  return {
    kRoom: input.kRoom,
    roomId: input.roomId,
    kid: input.canaryKid,
    senderId: CANARY_SENDER_ID,
    oobSecret: input.cellSecret,
  };
}

/**
 * Derive K_canary as an AES-GCM `CryptoKey` (extractable:false, usable as `kContent`
 * for `encryptFrame`). Throws 'Path C requires oobSecret' (inherited from PathC) when
 * `cellSecret` is absent/empty — NO silent Path A fallback.
 */
export function deriveCanaryKey(input: CanaryKeyInput): Promise<CryptoKey> {
  return derivation.deriveContentKey(toPathCInput(input));
}

/**
 * Derive the raw 32-byte K_canary HKDF bits (extractable) for exact-equality proofs /
 * cross-checks against `PathCKeyDerivation.deriveContentBits`. Same throw semantics.
 */
export function deriveCanaryBits(input: CanaryKeyInput): Promise<Uint8Array> {
  return derivation.deriveContentBits(toPathCInput(input));
}

// ── Restart-durable monotone canaryKid allocator ────────────────────────────────

/**
 * Disk-backed per-streamId high-water store. On instantiation it READS the persisted
 * high-water map; `next(streamId)` increments and WRITES synchronously, so a process
 * restart that re-instantiates the store resumes strictly ABOVE the last issued kid and
 * never reuses (K, kid, ctr=0). Holds only small monotone integers — NO key material.
 */
export class DurableKidStore {
  private readonly filePath: string;
  private highWater: Record<string, number>;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.filePath = join(dataDir, 'canary-kid-highwater.json');
    this.highWater = this.load();
  }

  private load(): Record<string, number> {
    if (!existsSync(this.filePath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as Record<string, number>;
      return {};
    } catch {
      // Corrupt store: fail SAFE by treating as empty would risk kid reuse, so we throw.
      throw new Error(`${MOD}: corrupt canary-kid high-water store at ${this.filePath}`);
    }
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.highWater), 'utf8');
  }

  /** Allocate the next strictly-monotone kid for `streamId` and persist it before return. */
  next(streamId: string): number {
    const prev = this.highWater[streamId];
    const next = prev === undefined ? 0 : prev + 1;
    this.highWater[streamId] = next;
    this.persist();
    log.debug({ streamId, kid: next }, 'canary kid allocated');
    return next;
  }
}

/** Resolve the default durable data dir (overridable via CANARY_DATA_DIR for tests/ops). */
function defaultDataDir(): string {
  return process.env['CANARY_DATA_DIR'] ?? join(process.cwd(), '.canary-data');
}

let sharedStore: DurableKidStore | undefined;

/**
 * Allocate the next restart-durable monotone `canaryKid` for `streamId`. Pass an
 * explicit `store` (tests) or rely on the process-wide default disk-backed store.
 */
export function nextCanaryKid(streamId: string, store?: DurableKidStore): number {
  const s = store ?? (sharedStore ??= new DurableKidStore(defaultDataDir()));
  return s.next(streamId);
}
