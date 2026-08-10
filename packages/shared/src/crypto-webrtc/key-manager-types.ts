/**
 * Vendored from services/client/client/src/lib/crypto/key-manager-types.ts — keep
 * byte-identical (below the import line; import paths adjusted to the co-located
 * layout here, targets otherwise unchanged). Resync manually if the client's
 * version changes.
 */

/**
 * Types + pure guards split out of `key-manager.ts` (REQ-MCS-012 P3). See that
 * file's header for the full CONTRACTS/SEQUENCES references and the
 * membership state-machine + crypto-claim discipline this KeyManager
 * implements. This file holds only the caller-facing shapes and a
 * delimiter-injection guard — no KeyManager state.
 */

import type { SessionOpener } from './session-keypair.js';

/** A roster entry as fed by the caller (WS membership, D-M2-18). */
export interface RosterMember {
  /** Signaling/relay peer id (opaque). */
  peerId: string;
  /** base64 ed25519 SESSION pubkey (== on-chain peer_pubkey per CONTRACTS §0). */
  sessionPubkeyB64: string;
}

export interface KeyManagerOptions {
  roomId: string;
  /** This client's own session pubkey (base64) — its roster identity + senderId. */
  localSessionPubkeyB64: string;
  /** In-closure unseal capability from `createSessionKeypair({ withOpener: true })`. */
  opener: SessionOpener;
  /** Grace window (ms) keeping the previous KID's key (CONTRACTS §2, env default 2000). */
  graceWindowMs: number;
  /**
   * Monotonic clock for KID grace-window bookkeeping (defaults to `Date.now`). This
   * SINGLE clock backs both `KidKeyStore.set` (here) AND the receiver lookup's grace
   * check (FIX-7: the lookup ignores the caller-supplied `nowMs` and uses THIS clock),
   * so the grace arithmetic is always consistent; tests inject a controllable clock.
   */
  now?: () => number;
  /**
   * Lane D Path C: the room's STATIC out-of-band >=128-bit secret. When present, the
   * KeyManager selects PathCKeyDerivation (HKDF salt = oobSecret) so a roster member
   * WITHOUT it derives the empty-salt Path A key and is AES-GCM-excluded from content.
   * Immutable for the instance's life (one KeyManager == one room == one path). Admission
   * password NEVER feeds this; this NEVER gates admission. NEVER logged (HARD-GATE).
   */
  oobSecret?: Uint8Array;
}

/** A divergence alarm sink (FIX-6): fired on a same-kid conflicting bundle. KID/epoch ONLY. */
export type DivergenceAlarm = (info: { roomId: string; epoch: number; kid: number }) => void;

/**
 * Reject a `senderId` that could inject into the HKDF `info` string
 * `dvconf-e2ee/v1|<roomId>|kid=<kid>|snd=<senderId>` (CONTRACTS §4 AMENDED, D-M2-21
 * (b)). The senderId is a base64 session pubkey, which never contains a pipe, so
 * this is a defence-in-depth guard against a forged/empty id silently restoring the
 * shared-key nonce-reuse bug. Throws on empty or any delimiter substring.
 */
export function assertSenderIdSafe(senderId: string): void {
  if (typeof senderId !== 'string' || senderId.length === 0) {
    throw new Error('KeyManager: senderId is REQUIRED on the production derivation path (D-M2-21)');
  }
  if (senderId.includes('|') || senderId.includes('kid=') || senderId.includes('snd=')) {
    throw new Error('KeyManager: senderId must be delimiter-free (no `|`/`kid=`/`snd=`) (D-M2-21)');
  }
}
