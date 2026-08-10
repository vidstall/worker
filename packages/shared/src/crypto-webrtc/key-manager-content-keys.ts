/**
 * Vendored from services/client/client/src/lib/crypto/key-manager-content-keys.ts —
 * keep byte-identical (below the import line; import paths adjusted to the
 * co-located layout here, targets otherwise unchanged). Resync manually if the
 * client's version changes.
 */

/**
 * Per-sender content-key derivation, split out of `key-manager.ts`
 * (REQ-MCS-012 P3, D-M2-21 — the acceptance gate). See that file's header for
 * the full CONTRACTS/SEQUENCES references. These functions operate on a
 * `KeyManager` instance passed in explicitly (rather than as `this`) so the
 * derivation logic lives outside the class while still sharing its roster/
 * K_room state (the content-key cache, the selected KDF strategy, the room's
 * OOB secret, and the grace-aware `keyForKid` lookup).
 *
 * CRYPTO-CLAIM DISCIPLINE (D-M2-8): per-sender keying here is NONCE-DOMAIN
 * SEPARATION, NOT per-sender authentication — ANY member can derive ANY
 * sender's K_content from the shared K_room (impersonation stays an MLS/M3
 * concern).
 *
 * LOGGING (HARD-GATE): NEVER log K_room, sealedKey, KDF output, the opener
 * secret, or private keys.
 */

import type { KeyLookup } from './sframe-transform.js';
import { assertSenderIdSafe } from './key-manager-types.js';
import type { KeyManager } from './key-manager.js';

function cacheKeyFor(senderId: string, kid: number): string {
  return `${senderId}#${kid}`;
}

/** Shared derive-and-cache for the content key (keeps the cache key consistent). */
export function deriveCachedContentKey(
  km: KeyManager,
  senderId: string,
  kid: number,
  kRoom: Uint8Array,
): Promise<CryptoKey> {
  const ck = cacheKeyFor(senderId, kid);
  let p = km.contentKeyCache.get(ck);
  if (!p) {
    p = km.kdf.deriveContentKey({ kRoom, roomId: km.roomId, kid, senderId, oobSecret: km.oobSecret });
    km.contentKeyCache.set(ck, p);
  }
  return p;
}

/**
 * Derive (and cache) the per-sender K_content CryptoKey for `(senderId, kid)`. The
 * production path REQUIRES a delimiter-free senderId (D-M2-21 (a)+(b)) — it throws
 * on a missing/empty/injected id. Returns null only when there is no K_room for
 * `kid` (rekeyed-out / grace lapsed / not yet received). FIX-1: the CURRENT epoch
 * resolves the dedicated non-expiring key.
 */
export async function contentKeyForSenderAtKid(
  km: KeyManager,
  senderId: string,
  kid: number,
): Promise<CryptoKey | null> {
  assertSenderIdSafe(senderId);
  const kRoom = km.keyForKid(kid, km.now());
  if (!kRoom) return null;
  return deriveCachedContentKey(km, senderId, kid, kRoom);
}

/** TEST-ONLY: raw HKDF bits for a (sender, kid) to assert per-sender separation. */
export async function contentBitsForSenderAtKid(
  km: KeyManager,
  senderId: string,
  kid: number,
): Promise<Uint8Array | null> {
  assertSenderIdSafe(senderId);
  const kRoom = km.keyForKid(kid, km.now());
  if (!kRoom) return null;
  return km.kdf.deriveContentBits({ kRoom, roomId: km.roomId, kid, senderId, oobSecret: km.oobSecret });
}

/**
 * The LOCAL sender's own K_content for the CURRENT kid (encrypt side — senderId =
 * this client's session pubkey). Returns null if no K_room is in effect yet.
 */
export async function localContentKey(km: KeyManager): Promise<CryptoKey | null> {
  return contentKeyForSenderAtKid(km, km.localPubkey, km.epoch);
}

/**
 * PER-PRODUCER KeyLookup FACTORY (D-M2-21 (c)). Returns a `KeyLookup` (the
 * sframe-transform.ts type) bound to ONE producer: `(kid, nowMs) => K_content
 * CryptoKey | null` for THAT producer at THAT kid. Validates the senderId UP FRONT
 * so an injected/empty id is rejected at factory time, not silently per frame.
 *
 * FIX-7 (C2): the grace check uses the KeyManager's OWN injected clock (`km.now()`),
 * NOT the caller-supplied `nowMs`. The transform may still CALL the lookup with a
 * wall-clock `nowMs` (the `KeyLookup` signature is unchanged for compatibility), but
 * we do NOT TRUST it — a custom monotonic / performance.now KeyManager clock and the
 * transform's wall clock are different domains, and mixing them silently breaks the
 * grace arithmetic. Single clock domain = the KeyManager's.
 */
export function keyLookupForSender(km: KeyManager, senderId: string): KeyLookup {
  assertSenderIdSafe(senderId); // reject empty/injected at factory time
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (kid: number, _callerNowMs: number): Promise<CryptoKey | null> | (CryptoKey | null) => {
    const kRoom = km.keyForKid(kid, km.now()); // FIX-7: KM clock, ignore caller nowMs
    if (!kRoom) return null;
    return deriveCachedContentKey(km, senderId, kid, kRoom);
  };
}
