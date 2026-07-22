/**
 * Vendored from services/client/client/src/lib/crypto/session-keypair.ts —
 * keep byte-identical (below the import line). Resync manually if the
 * client's version changes.
 */

/**
 * REQ-MCS-012 (P1.0) — in-browser ed25519 SESSION keypair (key provenance).
 *
 * Why this exists (CONTRACTS §0 / decision (b)/D-M2-18): each joiner generates a
 * CLIENT-GENERATED, in-browser ed25519 session key whose PRIVATE half never
 * leaves the browser — NOT the Sui dev-wallet key (a wallet signs via the
 * extension and never exposes the private scalar, so it cannot be converted to
 * an X25519 ECDH key for the M2 sealed-box delivery, and reusing a long-lived
 * wallet key as a content key is bad hygiene). Under Zoom-style link admission
 * (D-M2-18) the PUBLIC half is announced over the signaling WS join and recorded
 * in the room roster the coordinator seals K_room to; routing it into an on-chain
 * `peer_pubkey` admission slot (Option-1(a)/D-M2-16) is OPTIONAL M3 hardening.
 *
 * This module is the single producer of that ephemeral session keypair. It:
 *   1. generates a fresh ed25519 keypair per call (one per relay session);
 *   2. exposes ONLY the 32-byte ed25519 PUBLIC half (base64) — the `peerPubkey`
 *      announced over the WS join + the future sealed-box recipient (the
 *      ed25519→X25519 conversion is the P1 spike's concern, not here);
 *   3. signs the canonical BCS join payload that the signaling daemon
 *      `auth.ts` (`JoinPayloadBcs` = { roomId, peerPubkey, nonce }) reconstructs
 *      and verifies with the SAME public half. NOTE (decision #2/D-M2-18): in M2
 *      the relay does NOT verify this signature — admission = the room-password,
 *      so the PoP signature rides the wire unverified (M3 hardening adds verify).
 *
 * Security invariants:
 *   - The private key is captured in a CLOSURE and is NEVER stored on the
 *     returned object, NEVER returned, NEVER logged. The only exported
 *     capability over it is `signJoin` (sign-only).
 *   - This is in-memory only — no persistence, no IndexedDB write here (P1/P3
 *     own any session-storage decision; P1.0 keeps it transient by construction).
 */

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { bcs, toB64, fromB64 } from '@mysten/bcs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import _sodium from 'libsodium-wrappers-sumo';

/**
 * Canonical join payload — MUST byte-match
 * `dvconf-daemons/apps/signaling/src/auth.ts` `JoinPayloadBcs`. The daemon
 * verifies the join signature against this exact layout using the cached
 * `peer_pubkey`; any drift here fails the join server-side.
 */
const JoinPayloadBcs = bcs.struct('JoinPayload', {
  roomId: bcs.string(),
  peerPubkey: bcs.vector(bcs.u8()),
  nonce: bcs.u64(),
});

/**
 * The in-closure UNSEAL capability (P3, P1 carry-forward a). The libsodium 64-byte
 * ed25519 secret, the derived X25519 secret, and the seed live ONLY inside the
 * `unsealRoomKey` closure — none is a field on this object, none is returned, none
 * is logged. This is the same ed25519→X25519 math `bridgeMystenSeedToOpener` proves
 * in the spike, EXCEPT the spike returns `privateKeyRaw` (fine for a spike); the
 * production opener keeps it INTERNAL (CONTRACTS §3; ROADMAP P3 / D-M2-5).
 */
export interface SessionOpener {
  /**
   * Open a sealed `K_room` envelope (base64 `crypto_box_seal(...)`) addressed to
   * THIS session's ed25519 pubkey. Returns the raw `K_room` bytes; throws (libsodium
   * `crypto_box_seal_open`) on a wrong/foreign envelope. The opener key never leaves
   * the closure.
   */
  unsealRoomKey(sealedKeyB64: string): Promise<Uint8Array>;
}

/**
 * The public, sign-only surface of an in-browser session keypair. The private
 * scalar is intentionally absent — it lives only inside `signJoin`'s closure.
 */
export interface SessionKeypair {
  /** Base64 of the 32-byte raw ed25519 PUBLIC key (the admission `peer_pubkey`). */
  readonly publicKeyB64: string;
  /**
   * Sign the canonical join payload for `(roomId, nonce)` with this session's
   * private half. Returns the base64 of the raw 64-byte ed25519 signature
   * (the shape `auth.ts.verifySignature` expects: `sigBytes.length === 64`).
   */
  signJoin(roomId: string, nonce: number): Promise<string>;
  /**
   * The in-closure sealed-box opener (P3). Present ONLY when the keypair is built
   * with `{ withOpener: true }`. ADDITIVE: the default object (the P1.0 useRelay
   * shape) does NOT carry it, so existing callers are byte-for-byte unchanged.
   */
  readonly opener?: SessionOpener;
}

/** Options for {@link createSessionKeypair}. Omit for the P1.0 sign-only shape. */
export interface CreateSessionKeypairOptions {
  /**
   * Attach the in-closure sealed-box {@link SessionOpener} (P3). Default `false`
   * keeps the additive guarantee — useRelay's join path never asks for an opener.
   */
  withOpener?: boolean;
}

/**
 * Build the exact bytes `auth.ts.buildCanonicalPayload` builds, so the
 * server-side `Ed25519PublicKey(peer_pubkey).verify(payload, sig)` succeeds.
 */
function canonicalJoinPayload(
  roomId: string,
  peerPubkey: Uint8Array,
  nonce: number,
): Uint8Array {
  return JoinPayloadBcs.serialize({
    roomId,
    peerPubkey: Array.from(peerPubkey),
    nonce: BigInt(nonce),
  }).toBytes();
}

/**
 * Build the in-closure sealed-box opener (P3, P1 carry-forward a). Derives the
 * libsodium X25519 secret from the SAME 32-byte ed25519 seed as the live signing
 * key, INSIDE this function's scope, and exposes only `unsealRoomKey`. The 64-byte
 * libsodium secret, the X25519 secret, and the seed are captured by the closure and
 * NEVER returned/stored on the object/logged (HARD-GATE).
 *
 * Mirrors `e2ee-spike.ts` `bridgeMystenSeedToOpener` math, but does NOT return the
 * private key — the spike returns `privateKeyRaw` (acceptable in a spike), which is
 * FORBIDDEN here.
 */
function buildOpener(keypair: Ed25519Keypair, publicKeyRaw: Uint8Array): SessionOpener {
  // The X25519 secret is derived lazily on first unseal so libsodium need not be
  // ready at construction (createSessionKeypair stays synchronous + non-throwing for
  // the useRelay path). All three secrets stay in THIS closure.
  let x25519Priv: Uint8Array | null = null;
  let x25519Pub: Uint8Array | null = null;

  async function ensureKeys(): Promise<void> {
    if (x25519Priv && x25519Pub) return;
    await _sodium.ready;
    // seed = the 32-byte ed25519 seed behind the @mysten signing key. Closure-local.
    const { secretKey: seed } = decodeSuiPrivateKey(keypair.getSecretKey());
    // reproduce the libsodium 64-byte ed25519 secret from the seed, then convert.
    const { privateKey } = _sodium.crypto_sign_seed_keypair(seed); // 64B — never escapes
    x25519Priv = _sodium.crypto_sign_ed25519_sk_to_curve25519(privateKey);
    x25519Pub = _sodium.crypto_sign_ed25519_pk_to_curve25519(publicKeyRaw);
    // seed + privateKey go out of scope here; only the two X25519 halves are retained.
  }

  return {
    async unsealRoomKey(sealedKeyB64: string): Promise<Uint8Array> {
      await ensureKeys();
      // crypto_box_seal_open throws on a wrong/foreign envelope.
      return _sodium.crypto_box_seal_open(fromB64(sealedKeyB64), x25519Pub!, x25519Priv!);
    },
  };
}

/**
 * Generate a fresh in-browser ed25519 session keypair. The private half is
 * trapped in the returned `signJoin` closure and is otherwise unreachable.
 *
 * Pass `{ withOpener: true }` (P3) to additionally attach the in-closure sealed-box
 * {@link SessionOpener}. This is ADDITIVE — the default (no-arg) call yields the
 * exact P1.0 `{ publicKeyB64, signJoin }` shape useRelay consumes (no `opener`).
 */
export function createSessionKeypair(options?: CreateSessionKeypairOptions): SessionKeypair {
  // Ephemeral — generated fresh, in-memory, never persisted. The `Ed25519Keypair`
  // instance is captured by the closures below and not exposed.
  const keypair = Ed25519Keypair.generate();
  const publicKeyRaw = keypair.getPublicKey().toRawBytes(); // 32-byte ed25519
  const publicKeyB64 = toB64(publicKeyRaw);

  async function signJoin(roomId: string, nonce: number): Promise<string> {
    const payload = canonicalJoinPayload(roomId, publicKeyRaw, nonce);
    // Ed25519Keypair.sign returns the raw 64-byte signature (no Sui scheme flag),
    // which is exactly what auth.ts verifies via Ed25519PublicKey.verify.
    const signature = await keypair.sign(payload);
    return toB64(signature);
  }

  const base: SessionKeypair = { publicKeyB64, signJoin };
  if (options?.withOpener) {
    // Define `opener` non-enumerably-safe: it is a property carrying ONLY a method
    // closure; no secret field is ever attached to `base`.
    return { ...base, opener: buildOpener(keypair, publicKeyRaw) };
  }
  return base;
}
