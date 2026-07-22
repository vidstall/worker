/**
 * Vendored from services/client/client/src/lib/crypto/e2ee-spike.ts — keep
 * byte-identical (below the import line). Resync manually if the client's
 * version changes.
 */

/**
 * REQ-MCS-012 (P1) — Keying + sealed-box + Path C exclusion proof (LIB crypto core).
 *
 * De-risks the M2 Content E2EE crypto core (Option A) BEFORE the SFrame pipeline is
 * wired (DA-2 "spike keying early"). PRODUCTION-LOAD-BEARING, not an isolated spike:
 * prod importers are `key-manager.ts` + `room-key-plane.ts` (both `src/lib/crypto/`),
 * plus the `src/lib/crypto` + `src/lib/webrtc` test suites. Built to the FROZEN
 * contract in `plans/transmission-confidentiality/milestone-2/design/CONTRACTS.md`
 * §3/§4 and `CONTEXT.md` D-M2-3/5/7.
 *
 * libsodium build: **libsodium-wrappers-sumo** — the ed25519->X25519 conversion
 * helpers `crypto_sign_ed25519_pk_to_curve25519` / `_sk_to_curve25519` are
 * SUMO-GATED (excluded from the standard `libsodium-wrappers` build). Empirically
 * confirmed: only the sumo build exposes them (see the spike test "libsodium build
 * pick"). DRY: the live roster key is the P1.0 `createSessionKeypair` (@mysten/sui);
 * `bridgeMystenSeedToOpener` proves the P3 open-capability bridge below.
 *
 * CRYPTO-CLAIM DISCIPLINE (D-M2-8 / DA-3): M2 baseline has **NO forward-secrecy /
 * PCS** (-> M3). Path C (Lane D) proves **covert validator-exclusion** -- a member
 * with K_room but WITHOUT the out-of-band secret derives the Path A key and
 * AES-GCM-fails on Path C frames -- and adds EXACTLY that one property on a STATIC
 * OOB, invite-room-only: STILL NO FS/PCS, NO SAS, NO robust OOB-distribution-under-
 * churn (M3-later). Path C is now **wired into the media path (Phase 2)**: for a
 * high-privacy INVITE room the in-room validator-exclusion is STRUCTURAL (a covertly-
 * admitted validator holds K_room but, lacking the OOB invite secret, is
 * cryptographically excluded from content -- to our knowledge novel, argued from the
 * absence of a prior covert-admit-but-OOB-exclude construction). Open rooms + Path A
 * stay content-blind by ECONOMICS, not crypto; the relay is structurally blind in ALL
 * modes. Content security here depends on keeping the invite link secret -- anyone who
 * obtains it can decrypt (no FS/PCS/SAS; the OOB leaks via Referer/history/logs/screen-
 * share -- disclosed, not hidden).
 *
 * LOGGING (HARD-GATE): NEVER log K_room, sealedKey, KDF output, private keys, or
 * OOB secrets. Only { kid, epoch, roomId, envelopeCount } via `clientLog`.
 */

import _sodium from 'libsodium-wrappers-sumo';
import { fromB64, toB64 } from '@mysten/bcs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { clientLog } from './log.js';

type Sodium = typeof _sodium;

const MOD = 'crypto/e2ee-spike';

/** Initialize libsodium (idempotent). Returns the ready sumo instance. */
export async function initSodium(): Promise<Sodium> {
  await _sodium.ready;
  return _sodium;
}

/**
 * Copy bytes into a fresh `Uint8Array` backed by a plain `ArrayBuffer`.
 * libsodium returns `Uint8Array<ArrayBufferLike>` (potentially SharedArrayBuffer),
 * which TS 5.7+ rejects as a WebCrypto `BufferSource` (ArrayBuffer-only). This
 * narrows the type at the WebCrypto boundary without an `as any` cast.
 */
function bufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}

/** Constant-style byte equality (no Node `Buffer` in the browser tsconfig). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── Synthetic roster (spike uses libsodium keygen; see bridge fn for the P3 delta) ──

export interface SyntheticMember {
  /** base64 of the 32-byte ed25519 SESSION pubkey (== on-chain peer_pubkey per §0). */
  readonly publicKeyB64: string;
  readonly publicKeyRaw: Uint8Array; // 32B ed25519
  readonly privateKeyRaw: Uint8Array; // 64B ed25519 secret (spike-only; never the @mysten closure key)
}

/** Generate a synthetic roster member (libsodium ed25519 keypair). Spike-only. */
export function generateSyntheticMember(): SyntheticMember {
  const kp = _sodium.crypto_sign_keypair();
  return {
    publicKeyB64: toB64(kp.publicKey),
    publicKeyRaw: kp.publicKey,
    privateKeyRaw: kp.privateKey,
  };
}

// ── Sealed-bundle key distribution (CONTRACTS §1 + §3) ──

export interface SealedEnvelope {
  recipientPubkey: string; // base64 ed25519 session pubkey
  sealedKey: string; // base64 crypto_box_seal(K_room, X25519(recipient))
}

export interface E2EEKeyBundle {
  roomId: string;
  epoch: number;
  kid: number;
  envelopes: SealedEnvelope[]; // order-insensitive (recipient-oblivious, D-M2-4)
}

/** Coordinator generates a fresh 32-byte K_room (transient-extractable raw bytes). */
export function generateRoomKey(): Uint8Array {
  return _sodium.crypto_secretstream_xchacha20poly1305_keygen(); // 32B CSPRNG
}

/**
 * Seal K_room to every roster member (CONTRACTS §3): per member,
 * x25519Pub = crypto_sign_ed25519_pk_to_curve25519(ed25519Pub); then
 * crypto_box_seal(K_room, x25519Pub). Anonymous sealed box -> no sender identity.
 */
export function sealRoomKeyToRoster(
  kRoom: Uint8Array,
  roster: readonly SyntheticMember[],
  meta: { roomId: string; epoch: number; kid: number },
): E2EEKeyBundle {
  const envelopes = roster.map((m) => {
    const x25519Pub = _sodium.crypto_sign_ed25519_pk_to_curve25519(m.publicKeyRaw);
    const sealed = _sodium.crypto_box_seal(kRoom, x25519Pub);
    return { recipientPubkey: m.publicKeyB64, sealedKey: toB64(sealed) };
  });
  clientLog.info(MOD, 'sealed K_room to roster', {
    roomId: meta.roomId,
    epoch: meta.epoch,
    kid: meta.kid,
    envelopeCount: envelopes.length,
  });
  return { ...meta, envelopes };
}

/**
 * A member opens ONLY its own envelope (matched by its own pubkey). Throws if it
 * has no envelope OR the sealed box does not open under its key (wrong key).
 */
export function openOwnEnvelope(bundle: E2EEKeyBundle, member: SyntheticMember): Uint8Array {
  const mine = bundle.envelopes.find((e) => e.recipientPubkey === member.publicKeyB64);
  if (!mine) throw new Error('no envelope for this recipient');
  const x25519Pub = _sodium.crypto_sign_ed25519_pk_to_curve25519(member.publicKeyRaw);
  const x25519Priv = _sodium.crypto_sign_ed25519_sk_to_curve25519(member.privateKeyRaw);
  // crypto_box_seal_open throws on a wrong key.
  return _sodium.crypto_box_seal_open(fromB64(mine.sealedKey), x25519Pub, x25519Priv);
}

// ── Coordinator-elect + liveness (D-M2-3) ──

/** Deterministic coordinator = smallest peer_pubkey (lexicographic over base64). */
export function electCoordinator(rosterPubkeys: readonly string[]): string {
  if (rosterPubkeys.length === 0) throw new Error('empty roster');
  return [...rosterPubkeys].sort()[0];
}

/** Liveness fallback: smallest peer_pubkey NOT in the unresponsive set (next-smallest). */
export function electCoordinatorWithLiveness(
  rosterPubkeys: readonly string[],
  unresponsive: ReadonlySet<string>,
): string {
  const live = [...rosterPubkeys].sort().filter((p) => !unresponsive.has(p));
  if (live.length === 0) throw new Error('no live peer to elect');
  return live[0];
}

// ── Asymmetric rekey (D-M2-5) ──

const RATCHET_CTX = 'dvce2ee1'; // libsodium crypto_kdf context: EXACTLY 8 bytes (crypto_kdf_CONTEXTBYTES)

/**
 * JOIN -> hash-ratchet K -> KDF(K). Members self-derive O(1); ONE-WAY (BLAKE2b
 * KDF has no inverse, so the joiner holding K_post cannot reconstruct K_pre).
 * Deterministic so all existing members converge on the same new key locally.
 */
export function ratchetOnJoin(kCurrent: Uint8Array): Uint8Array {
  return _sodium.crypto_kdf_derive_from_key(32, 1, RATCHET_CTX, kCurrent);
}

/**
 * LEAVE/revoke -> fresh-random rekey (cryptographic eviction). The new key is
 * CSPRNG material independent of K_old, so the evicted member — who knows K_old
 * and can ratchet it — cannot reach it. Coordinator reseals to the N-1 remaining.
 */
export function freshRekeyOnLeave(): Uint8Array {
  return generateRoomKey();
}

// ── KID grace window (CONTRACTS §2) ──

interface KidEntry {
  key: Uint8Array;
  setAtMs: number;
}

/**
 * Receiver-side KID->key store. Selects the decryption key by the frame-header
 * KID (not "current"), keeping the previous KID's key for E2EE_KID_GRACE_WINDOW_MS
 * so in-flight old-KID frames decrypt across a rekey; then the old key is dropped.
 */
export class KidKeyStore {
  private readonly keys = new Map<number, KidEntry>();
  constructor(private readonly graceWindowMs: number) {}

  set(kid: number, key: Uint8Array, nowMs: number): void {
    this.keys.set(kid, { key, setAtMs: nowMs });
  }

  /** Return the key for this KID if present and within its grace window, else null. */
  get(kid: number, nowMs: number): Uint8Array | null {
    const e = this.keys.get(kid);
    if (!e) return null;
    if (nowMs - e.setAtMs > this.graceWindowMs) return null;
    return e.key;
  }

  /** Drop any KID key whose grace window has lapsed. */
  evictExpired(nowMs: number): void {
    for (const [kid, e] of this.keys) {
      if (nowMs - e.setAtMs > this.graceWindowMs) this.keys.delete(kid);
    }
  }

  /** TEST-ONLY: number of KIDs currently held (to assert bounded retention, FIX-3). */
  sizeForTest(): number {
    return this.keys.size;
  }
}

// ── 2-state extractable (D-M2-5/§3) ──

/**
 * Import K_room as a non-extractable AES-GCM CryptoKey for the steady-state /
 * Encoded-Transform-worker side. extractable:false -> exportKey rejects; the key
 * still survives structured-clone (worker postMessage) as a usable CryptoKey.
 */
export async function importRoomKeyNonExtractable(kRoom: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', bufferView(kRoom), { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ── KeyDerivation Strategy seam (CONTRACTS §4) ──

export interface KeyDerivationInput {
  kRoom: Uint8Array;
  roomId: string;
  kid: number;
  /**
   * Per-sender domain separator (D-M2-21). In the shared-key SFU room every
   * publisher unwraps the SAME K_room, so a sender-INDEPENDENT content key would
   * make two publishers reuse the same AES-GCM (key, IV=[kid|ctr]) pair → nonce
   * reuse (a confidentiality + integrity break). Folding the publisher's stable id
   * into the HKDF `info` gives each publisher a DISTINCT K_content, so IV=[kid|ctr]
   * never collides across senders. PRODUCTION (P3) MUST pass this per publisher
   * (the sender's own id on encrypt; the producer's id on the receiver's
   * per-producer key). NOTE: this is nonce-domain separation, NOT per-sender
   * AUTHENTICATION — any member can derive any sender's subkey from the shared
   * K_room (impersonation stays an MLS/M3 concern, D-M2-5). Omitted only in
   * spike / domain-separation unit tests.
   */
  senderId?: string;
  oobSecret?: Uint8Array; // Path C only
}

export interface KeyDerivation {
  deriveContentKey(input: KeyDerivationInput): Promise<CryptoKey>;
}

function hkdfInfo(roomId: string, kid: number, senderId?: string): Uint8Array {
  // D-M2-21: fold the per-sender id into `info` so each publisher derives a
  // DISTINCT K_content → AES-GCM nonce (IV=[kid|ctr]) safety in the shared-key
  // SFU room. Omitting senderId (spike / domain-separation tests) preserves the
  // legacy room+epoch-only info.
  const base = `dvconf-e2ee/v1|${roomId}|kid=${kid}`;
  return new TextEncoder().encode(senderId !== undefined ? `${base}|snd=${senderId}` : base);
}

/**
 * Path A: K_content = HKDF-SHA256(IKM=kRoom, salt="",
 *   info="dvconf-e2ee/v1|"+roomId+"|kid="+kid[+"|snd="+senderId]).
 * WebCrypto-native (no extra dep). Domain-separates per room + epoch + PUBLISHER
 * (D-M2-21): the per-sender `info` gives each publisher a distinct K_content so the
 * SFrame AES-GCM IV=[kid|ctr] never collides across the shared-key SFU room's
 * senders (nonce safety; NOT per-sender authentication — see
 * KeyDerivationInput.senderId). The derived key is imported extractable:false for
 * the transform.
 */
export class PathAKeyDerivation implements KeyDerivation {
  protected salt(_input: KeyDerivationInput): Uint8Array {
    return new Uint8Array(0); // Path A: empty salt
  }

  async deriveContentKey(input: KeyDerivationInput): Promise<CryptoKey> {
    const ikm = await crypto.subtle.importKey('raw', bufferView(input.kRoom), 'HKDF', false, [
      'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: bufferView(this.salt(input)),
        info: bufferView(hkdfInfo(input.roomId, input.kid, input.senderId)),
      },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false, // extractable:false at steady state
      ['encrypt', 'decrypt'],
    );
  }

  /** Spike-only helper: derive the raw HKDF bits to assert domain separation. */
  async deriveContentBits(input: KeyDerivationInput): Promise<Uint8Array> {
    const ikm = await crypto.subtle.importKey('raw', bufferView(input.kRoom), 'HKDF', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: bufferView(this.salt(input)),
        info: bufferView(hkdfInfo(input.roomId, input.kid, input.senderId)),
      },
      ikm,
      256,
    );
    return new Uint8Array(bits);
  }
}

/**
 * Path C: covert validator-exclusion via OOB-secret HKDF salt-mix (the W5 headline;
 * ADR-0016 finding #3 + CONTRACTS section 4). K_content = HKDF-SHA256(IKM=kRoom,
 * salt=oobSecret, info=...) -- IDENTICAL to Path A except the salt is the out-of-band
 * >=128-bit CSPRNG secret instead of empty. A roster member with K_room but WITHOUT
 * the OOB factor (e.g. the in-room validator) derives the empty-salt Path A key and
 * is therefore cryptographically excluded from the AES-GCM frame stream -- WITHOUT
 * being denied K_room (C2-indistinguishable) and WITHOUT being identified.
 *
 * SCOPE (DA-3): adds EXACTLY ONE property -- covert-exclusion via a STATIC OOB,
 * invite-room-only. NO forward secrecy, NO PCS, NO SAS, NO robust OOB-distribution
 * under churn (all M3-later). For a high-privacy INVITE room the in-room validator-
 * exclusion is STRUCTURAL; open rooms + Path A stay content-blind by ECONOMICS, not
 * crypto; the relay is structurally blind in ALL modes. The OOB secret leaks via
 * Referer/history/logs/screen-share -- disclosed, not hidden; content security depends
 * on keeping the invite link secret. Production wiring (URL #fragment capture,
 * KeyManager strategy-select, panel disclosures) is now LANDED in Phase 2 -- this
 * derivation is wired into the certified media path.
 */
export class PathCKeyDerivation extends PathAKeyDerivation {
  protected override salt(input: KeyDerivationInput): Uint8Array {
    // Fail loud: never silently fall back to the Path A empty salt. The throw also
    // narrows oobSecret to a defined Uint8Array for the return.
    if (!input.oobSecret?.length) {
      throw new Error('Path C requires oobSecret');
    }
    return input.oobSecret;
  }
}

// ── CENTRAL DE-RISK: @mysten/sui <-> libsodium ed25519 seed bridge (CONTRACTS §0) ──

export interface MystenOpener {
  publicKeyB64: string;
  publicKeyRaw: Uint8Array; // 32B ed25519 — equals the @mysten pubkey
  privateKeyRaw: Uint8Array; // 64B libsodium ed25519 secret, derived from the @mysten seed
}

/**
 * Bridge a P1.0 `createSessionKeypair`-shaped @mysten/sui key to a libsodium
 * sealed-box OPENER, proving the P3 integration delta. The live roster key is a
 * @mysten Ed25519Keypair that closure-traps its private scalar (exposes only
 * publicKeyB64 + signJoin) and so CANNOT open an envelope as-is. A P3 KeyManager
 * resolves this by deriving the libsodium opener from the same 32-byte seed:
 *   seed = decodeSuiPrivateKey(getSecretKey()).secretKey
 *   { publicKey, privateKey } = crypto_sign_seed_keypair(seed)
 * The reproduced ed25519 pubkey is IDENTICAL to the @mysten pubkey, so envelopes
 * sealed to the live `peer_pubkey` open with this libsodium secret.
 *
 * The seed never leaves the browser and is never logged (HARD-GATE).
 */
export async function bridgeMystenSeedToOpener(suiPrivateKey: string): Promise<MystenOpener> {
  await initSodium();
  const { secretKey: seed } = decodeSuiPrivateKey(suiPrivateKey); // 32B ed25519 seed
  const kp = _sodium.crypto_sign_seed_keypair(seed);
  return {
    publicKeyB64: toB64(kp.publicKey),
    publicKeyRaw: kp.publicKey,
    privateKeyRaw: kp.privateKey,
  };
}
