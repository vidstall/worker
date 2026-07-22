/**
 * Vendored from services/client/client/src/lib/crypto/key-manager.ts — keep
 * byte-identical (below the import line; import paths adjusted to the
 * co-located layout here, targets otherwise unchanged). Resync manually if
 * the client's version changes.
 */

/**
 * REQ-MCS-012 (P3) — KeyManager: promotes the P1 keying spike to production.
 *
 * Built to the FROZEN contract:
 *   - CONTRACTS.md §1 — the sealed `e2eeKeyBundle` (coordinator → broadcast → open).
 *   - CONTRACTS.md §2 — KID == epoch (monotonic, bumps per membership change) +
 *     grace window (previous-KID key retained for E2EE_KID_GRACE_WINDOW_MS).
 *   - CONTRACTS.md §3 — ed25519→X25519 seal/open (the open side is the in-closure
 *     session opener, NOT a raw private key).
 *   - CONTRACTS.md §4 (+ the AMENDED per-sender `info` block) — PathAKeyDerivation
 *     with a REQUIRED, delimiter-free `senderId` on the production path (D-M2-21).
 *   - SEQUENCES.md diagram 1 (key distribution) + diagram 2 (ASYMMETRIC rekey:
 *     ratchet-on-join / fresh-rekey-on-leave, dual trigger).
 *
 * DRY: this REUSES the shipped `e2ee-spike.ts` primitives wholesale — it never
 * reimplements crypto. `generateRoomKey` / `sealRoomKeyToRoster` /
 * `electCoordinator(WithLiveness)` / `ratchetOnJoin` / `freshRekeyOnLeave` /
 * `KidKeyStore` / `PathAKeyDerivation` are all imported, not re-coded.
 *
 * SCOPE: this is the LIBRARY only. The LIVE per-producer transform wiring (attach
 * the lookups to RTCRtpSender/Receiver in useRelay) is P6 when E2EE flips on — this
 * file does not touch useRelay or the transform shim.
 *
 * MEMBERSHIP STATE-MACHINE (P3-fix hardening — QC + 2 crypto-adversary review):
 *   - The CURRENT epoch K_room lives in a DEDICATED, NON-EXPIRING field
 *     (`currentKey`); only SUPERSEDED (previous) KIDs go into the grace-bounded
 *     `KidKeyStore`. A stable room therefore NEVER loses its own key (FIX-1/B3) —
 *     grace applies to previous keys ONLY (CONTRACTS §2/§6).
 *   - Each epoch transition records its TYPE: a LEAVE injects fresh-random material
 *     (tracked in `freshRekeyKids`), which is NOT ratchet-reconstructable, so
 *     `reconcileToKid` REFUSES to ratchet across a leave epoch (FIX-2/B1).
 *   - Superseded KIDs are EVICTED from the store on each store/lookup so raw K_room
 *     bytes do not live forever (grace bounds LIFETIME, not just usability, FIX-3/F1).
 *   - A JOIN arriving while a leave-bundle is still pending (no current key) is
 *     DEFERRED, not thrown — "latest epoch wins" gracefully (FIX-4/C1).
 *   - A duplicate/replayed JOIN for an already-applied joiner is a no-op (FIX-5/E1).
 *   - `applyBundle` does NOT store a regressing kid, does NOT refresh a known kid's
 *     grace on replay, and ALARMs (never overwrites) a same-kid DIVERGENT key
 *     (FIX-6/A4b — the containable half of the split-brain HIGH).
 *   - `keyLookupForSender`'s grace check uses the KeyManager's OWN clock, not the
 *     caller's wall-clock `nowMs` (FIX-7/C2 — single clock domain).
 *
 * KNOWN M2 LIMITATION — same-kid split-brain under partition (D-M2-8):
 *   Two members that DISAGREE about the roster (a network partition) can each
 *   fresh-rekey at the SAME epoch, yielding two DIVERGENT K_room values at one KID.
 *   FIX-6 stops the receiver from SILENTLY overwriting its key with a conflicting
 *   same-kid bundle (it alarms and keeps-first), but the fundamental "same kid,
 *   divergent key under partition" cannot be RESOLVED in M2 — there is no epoch
 *   authentication / membership consensus. Cryptographically authenticating the
 *   epoch (so all members agree which key is canonical at a KID) is EXACTLY what
 *   MLS adds in M3. This is an accepted, disclosed M2 limitation.
 *
 * CRYPTO-CLAIM DISCIPLINE (D-M2-8): the group key still has NO forward-secrecy / PCS
 * (MLS → M3). Path C cryptographic validator-exclusion is now WIRED here (Lane D
 * Phase 2): when constructed with an `oobSecret` this KeyManager selects
 * PathCKeyDerivation, so for a high-privacy INVITE room a covertly-admitted in-room
 * validator holds K_room but, lacking the OOB, derives the Path A key and is
 * cryptographically excluded from content (STRUCTURAL exclusion, to our knowledge
 * novel / argued-from-absence). Without an `oobSecret` the instance is unchanged
 * Path A — open rooms + Path A stay content-blind by ECONOMICS, not crypto; the relay
 * is structurally blind in ALL modes; content security depends on keeping the invite
 * link secret. `freshRekeyOnLeave` gives cryptographic eviction for FUTURE frames only
 * (the leaver still knows past keys); the group key has no FS/PCS. Per-sender keying is
 * NONCE-DOMAIN SEPARATION, NOT per-sender authentication — ANY member can derive ANY
 * sender's K_content from the shared K_room (impersonation stays an MLS/M3 concern).
 *
 * LOGGING (HARD-GATE): NEVER log K_room, sealedKey, KDF output, the opener secret,
 * or private keys. Log only { kid, epoch, roomId, envelopeCount }.
 */

import {
  generateRoomKey,
  sealRoomKeyToRoster,
  electCoordinator,
  electCoordinatorWithLiveness,
  ratchetOnJoin,
  freshRekeyOnLeave,
  bytesEqual,
  KidKeyStore,
  PathAKeyDerivation,
  PathCKeyDerivation,
  type SealedEnvelope,
  type E2EEKeyBundle,
  type SyntheticMember,
} from './e2ee-spike.js';
import type { SessionOpener } from './session-keypair.js';
import type { KeyLookup } from './sframe-transform.js';
import { clientLog } from './log.js';
import { fromB64 } from '@mysten/bcs';

const MOD = 'crypto/key-manager';

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
type DivergenceAlarm = (info: { roomId: string; epoch: number; kid: number }) => void;

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

/**
 * Production KeyManager. One instance per local member per room. Coordinates the
 * group key (`K_room`) lifecycle, derives per-sender `K_content`, and exposes a
 * per-producer `KeyLookup` for the SFrame transform.
 */
export class KeyManager {
  private readonly roomId: string;
  private readonly localPubkey: string;
  private readonly opener: SessionOpener;
  private readonly now: () => number;
  /**
   * The content-key derivation strategy: PathC iff a usable OOB is held, else the
   * certified Path A. Typed as the PathA base (PathCKeyDerivation extends it) so the
   * choke-point call-sites are path-agnostic. Selected once in the ctor (immutable).
   */
  private readonly kdf: PathAKeyDerivation;
  /** Lane D Path C static OOB salt (immutable; defensive-copied on ingest). undefined ⇒ Path A. NEVER logged. */
  private readonly oobSecret?: Uint8Array;

  /** Current roster {peerId → sessionPubkey}. The set the coordinator seals to. */
  private roster: RosterMember[] = [];
  /** Peers considered unresponsive (coordinator liveness fallback, D-M2-3). */
  private readonly unresponsive = new Set<string>();

  /** Monotonic membership epoch; `kid === epoch` (CONTRACTS §2). Bumps per change. */
  private _epoch = 0;

  /**
   * The CURRENT epoch's raw K_room (FIX-1/B3). Held in a DEDICATED field that NEVER
   * expires — the grace window applies to SUPERSEDED keys only (CONTRACTS §2/§6). On
   * each rekey the old current key is moved into `kidStore` (starting ITS grace) and
   * this field is replaced. Null only before bootstrap / while a leave-bundle is
   * pending on a non-coordinator.
   */
  private currentKey: Uint8Array | null = null;

  /**
   * Receiver-side KID→raw-K_room store with the grace window (DRY: shipped spike).
   * Holds ONLY SUPERSEDED (previous) KIDs — never the current epoch (that is
   * `currentKey`). Expired entries are evicted on store/lookup (FIX-3).
   */
  private readonly kidStore: KidKeyStore;

  /**
   * KIDs whose key was a FRESH-RANDOM rekey (a LEAVE), NOT a ratchet (FIX-2/B1). A
   * member that missed one of these CANNOT reconstruct it by ratcheting — it must
   * recover via `applyBundle`. `reconcileToKid` throws if its span crosses one.
   */
  private readonly freshRekeyKids = new Set<number>();

  /**
   * Joiner session pubkeys whose JOIN has already been applied at the CURRENT roster
   * generation (FIX-5/E1). A redelivered membership event (WS reconnect / poll
   * overlap) for an already-applied joiner is a no-op (no epoch bump, no ratchet).
   * Cleared on a LEAVE (the roster generation changes).
   */
  private readonly appliedJoiners = new Set<string>();

  /** Cache of derived K_content CryptoKeys, keyed by `${senderId}#${kid}`. */
  private readonly contentKeyCache = new Map<string, Promise<CryptoKey>>();

  /** FIX-6 divergence alarm sink (defaults to a structured clientLog.warn). */
  private divergenceAlarm: DivergenceAlarm;

  constructor(opts: KeyManagerOptions) {
    this.roomId = opts.roomId;
    this.localPubkey = opts.localSessionPubkeyB64;
    this.opener = opts.opener;
    this.now = opts.now ?? Date.now;
    // Defensive-copy the OOB on ingest so the documented per-instance immutability is
    // ENFORCED, not merely conventional: a caller mutating its Uint8Array after
    // construction cannot retroactively change this room's derived content keys.
    this.oobSecret = opts.oobSecret ? opts.oobSecret.slice() : undefined;
    // Strategy-select (Lane D): PathC iff a usable OOB is held; else the certified Path A.
    this.kdf = this.oobSecret && this.oobSecret.length > 0
      ? new PathCKeyDerivation()
      : new PathAKeyDerivation();
    this.kidStore = new KidKeyStore(opts.graceWindowMs);
    this.divergenceAlarm = (info) =>
      // KID/epoch ONLY — NEVER the key material (HARD-GATE).
      clientLog.warn(MOD, 'same-kid DIVERGENT bundle rejected (split-brain alarm)', info);
  }

  // ── roster + coordinator election (D-M2-3) ──

  /** Replace the in-memory roster (driven by WS membership in P6; by tests in P3). */
  setRoster(roster: RosterMember[]): void {
    this.roster = [...roster];
  }

  /** Mark a peer unresponsive so the liveness fallback skips it when electing. */
  markUnresponsive(sessionPubkeyB64: string): void {
    this.unresponsive.add(sessionPubkeyB64);
  }

  private rosterPubkeys(): string[] {
    return this.roster.map((m) => m.sessionPubkeyB64);
  }

  /** The elected coordinator's session pubkey (smallest live pubkey, D-M2-3). */
  coordinatorPubkey(): string {
    const pubkeys = this.rosterPubkeys();
    return this.unresponsive.size === 0
      ? electCoordinator(pubkeys)
      : electCoordinatorWithLiveness(pubkeys, this.unresponsive);
  }

  /** True iff this client is the elected coordinator. */
  isCoordinator(): boolean {
    return this.coordinatorPubkey() === this.localPubkey;
  }

  /**
   * True iff this client is the coordinator elected among the EXISTING members,
   * i.e. the roster EXCLUDING `excludedPubkey` (the joiner). On a JOIN the joiner
   * has no K_room yet and cannot seal to itself, so the existing members elect the
   * seal-to-joiner coordinator among themselves (D-M2-3 over the pre-join set). This
   * keeps "who seals the ratchet key to the joiner" deterministic even when the
   * joiner's pubkey would otherwise win the election.
   */
  private isCoordinatorAmongExisting(excludedPubkey: string): boolean {
    const existing = this.rosterPubkeys().filter((p) => p !== excludedPubkey);
    if (existing.length === 0) return false;
    const coord =
      this.unresponsive.size === 0
        ? electCoordinator(existing)
        : electCoordinatorWithLiveness(existing, this.unresponsive);
    return coord === this.localPubkey;
  }

  get epoch(): number {
    return this._epoch;
  }
  /** KID == epoch (CONTRACTS §2). */
  get kid(): number {
    return this._epoch;
  }

  // ── K_room lifecycle ──

  /**
   * Raw K_room bytes for a given kid, grace-window aware (FIX-1/B3): the CURRENT
   * epoch resolves the DEDICATED non-expiring field; any other (superseded) kid
   * resolves the grace-bounded store. Returns null if there is no usable key for
   * that kid (rekeyed-out / grace lapsed / not yet received). Evicts expired entries
   * as a side effect (FIX-3/F1).
   */
  private keyForKid(kid: number, nowMs: number): Uint8Array | null {
    if (kid === this._epoch) return this.currentKey;
    this.kidStore.evictExpired(this.now()); // FIX-3: bound lifetime, not just usability
    return this.kidStore.get(kid, nowMs);
  }

  /** Raw K_room bytes currently in effect (latest KID), or throws if none yet. */
  private currentRoomKey(): Uint8Array {
    if (!this.currentKey) throw new Error('KeyManager: no K_room for the current epoch');
    return this.currentKey;
  }

  /** TEST-ONLY: expose the current raw K_room for white-box convergence assertions. */
  async currentRoomKeyForTest(): Promise<Uint8Array> {
    return this.currentRoomKey();
  }

  /** TEST-ONLY: count the SUPERSEDED kids currently held in the store (FIX-3 bound). */
  heldKidCountForTest(): number {
    this.kidStore.evictExpired(this.now());
    return this.kidStore.sizeForTest();
  }

  /** TEST-ONLY: inject the FIX-6 divergence-alarm sink to assert it fires. */
  setDivergenceAlarmForTest(alarm: DivergenceAlarm): void {
    this.divergenceAlarm = alarm;
  }

  /**
   * TEST-ONLY: record that `kid` was a LEAVE (fresh-rekey) epoch the observer SAW but
   * has not yet keyed (FIX-2 span-scan). In production this is set by `onMemberLeave`;
   * the helper lets a test position an anchored member that recorded a FUTURE leave in
   * its span without the no-rewind machinery of replaying events.
   */
  recordLeaveEpochForTest(kid: number): void {
    this.freshRekeyKids.add(kid);
  }

  /** Build the SyntheticMember-shaped roster the spike seal path consumes. */
  private sealRoster(pubkeys: string[]): SyntheticMember[] {
    // sealRoomKeyToRoster only reads publicKeyB64 + publicKeyRaw (it seals, anonymous
    // box — it never touches privateKeyRaw). A FRESH zero buffer per member removes the
    // shared-mutable-buffer footgun; the seal side never reads it.
    return pubkeys.map((b64) => ({
      publicKeyB64: b64,
      publicKeyRaw: fromB64(b64),
      privateKeyRaw: new Uint8Array(0), // unused on the SEAL side (anonymous crypto_box_seal)
    }));
  }

  /**
   * Promote a freshly-generated/-adopted key to the CURRENT epoch (FIX-1): the OLD
   * current key (if any) is demoted into the grace-bounded store under its OWN kid
   * (`prevKid`) with setAtMs=now (that starts ITS grace), then `currentKey` is
   * replaced. The current key itself is never grace-bounded. Evicts expired
   * superseded entries (FIX-3). `prevKid` is the epoch the OLD current key belonged
   * to (the caller passes the epoch BEFORE it bumped), so a superseded kid is
   * grace-bounded under its correct label.
   */
  private promoteCurrentKey(newCurrent: Uint8Array, prevKid: number): void {
    if (this.currentKey && prevKid >= 0 && prevKid !== this._epoch) {
      // demote the prior current key: it becomes a superseded KID with its OWN grace.
      this.kidStore.set(prevKid, this.currentKey, this.now());
    }
    this.currentKey = newCurrent;
    this.kidStore.evictExpired(this.now()); // FIX-3
  }

  /**
   * COORDINATOR bootstrap (first key, SEQUENCES diagram 1): bump to epoch 1 (or next),
   * generate a fresh K_room, seal to the whole roster, store locally, return the
   * broadcast bundle. Throws if not the coordinator.
   */
  async bootstrapRoomKey(): Promise<E2EEKeyBundle> {
    if (!this.isCoordinator()) {
      throw new Error('KeyManager: only the coordinator bootstraps K_room');
    }
    this._epoch += 1;
    const kRoom = generateRoomKey();
    this.currentKey = kRoom; // first key — dedicated field, no grace (FIX-1)
    const bundle = sealRoomKeyToRoster(kRoom, this.sealRoster(this.rosterPubkeys()), {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
    });
    clientLog.info(MOD, 'bootstrap K_room', {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
      envelopeCount: bundle.envelopes.length,
    });
    return bundle;
  }

  /**
   * MEMBER apply an incoming bundle (SEQUENCES diagram 1, NON-coordinator path):
   * adopt the bundle's epoch/kid, find MY envelope, open it via the in-closure opener
   * (NOT openOwnEnvelope which needs a raw private key), store K_room at that kid.
   * Throws if I have no envelope or it does not open under my key.
   *
   * FIX-6 (A4b) hardening:
   *   (i) a REGRESSING bundle (kid < current epoch) is informational ONLY — it does
   *       NOT store / refresh an already-known or expired kid's grace clock.
   *   (ii) a SAME-kid bundle (kid == current epoch) whose key material DIFFERS from
   *       what is already current is NOT silently overwritten — it fires a divergence
   *       alarm (KID/epoch only, NEVER the key) and is rejected (keep-first).
   */
  async applyBundle(bundle: E2EEKeyBundle): Promise<void> {
    const mine: SealedEnvelope | undefined = bundle.envelopes.find(
      (e) => e.recipientPubkey === this.localPubkey,
    );
    if (!mine) {
      throw new Error(`KeyManager: no envelope for me in bundle kid=${bundle.kid}`);
    }
    const kRoom = await this.opener.unsealRoomKey(mine.sealedKey); // throws on wrong key

    // FIX-6 (i): a strictly-regressing bundle is informational — do NOT store it, do
    // NOT refresh any grace clock. (A late/replayed old-kid bundle must not revive an
    // expired key or roll the epoch back.)
    if (bundle.kid < this._epoch) {
      clientLog.info(MOD, 'ignored regressing K_room bundle (informational)', {
        roomId: this.roomId,
        epoch: bundle.epoch,
        kid: bundle.kid,
        envelopeCount: bundle.envelopes.length,
      });
      return;
    }

    // FIX-6 (ii): a same-kid bundle (kid == current) whose material DIFFERS from the
    // current key is a split-brain divergence — alarm and KEEP-FIRST, never overwrite.
    if (bundle.kid === this._epoch && this.currentKey) {
      if (bytesEqual(kRoom, this.currentKey)) {
        // identical replay at the same kid — idempotent, do NOT refresh anything.
        return;
      }
      this.divergenceAlarm({ roomId: this.roomId, epoch: bundle.epoch, kid: bundle.kid });
      return; // keep-first; the KNOWN same-kid/split-brain M2 limitation (see file header).
    }

    // forward adoption: this is the new current epoch (FIX-1 — dedicated field).
    const prevKid = this._epoch;
    if (bundle.epoch > this._epoch) this._epoch = bundle.epoch;
    this.promoteCurrentKey(kRoom, prevKid);
    clientLog.info(MOD, 'applied K_room bundle', {
      roomId: this.roomId,
      epoch: bundle.epoch,
      kid: bundle.kid,
      envelopeCount: bundle.envelopes.length,
    });
  }

  // ── ASYMMETRIC rekey (D-M2-5, SEQUENCES diagram 2) ──

  /**
   * JOIN (member-add): epoch++, kid=epoch. EXISTING members (incl. coordinator)
   * self-derive K_room[new] = ratchetOnJoin(K_room[old]) LOCALLY (O(1), one-way).
   * The COORDINATOR additionally seals K_room[new] to the JOINER ONLY and returns a
   * single-envelope bundle; a non-coordinator returns null (it only self-ratchets).
   *
   * The joiner opens that bundle → gets K_room[new] and CANNOT derive K_room[old]
   * (one-way KDF = backward secrecy).
   *
   * FIX-5 (E1): a redelivered JOIN for an ALREADY-applied joiner is a no-op (no epoch
   * bump, no ratchet) — a double-ratchet would permanently diverge members.
   * FIX-4 (C1): if there is no current key yet (a leave-bundle is still pending on a
   * non-coordinator), the local ratchet is DEFERRED — we do NOT ratchet, do NOT bump
   * the epoch past the pending bundle, and do NOT throw; the next broadcast bundle
   * reconciles the key. A deferred join is NOT recorded as applied (so the later REAL
   * join for the same joiner still ratchets it — recording it during the defer would let
   * FIX-5 idempotency suppress the real join and permanently diverge that member).
   */
  onMemberJoin(joiner: RosterMember): E2EEKeyBundle | null {
    // FIX-5: idempotency on the joiner id — a duplicate event does not advance state.
    if (this.appliedJoiners.has(joiner.sessionPubkeyB64)) {
      clientLog.info(MOD, 'ignored duplicate JOIN (already applied)', {
        roomId: this.roomId,
        epoch: this._epoch,
        kid: this._epoch,
        envelopeCount: 0,
      });
      return null;
    }
    // FIX-4: a JOIN while no current key is held (a leave-bundle is still pending on a
    // non-coordinator) — DEFER. We do NOT ratchet (we have no key to ratchet) and we do
    // NOT bump the epoch PAST the pending bundle (that would make the awaited leave
    // bundle look like a regressing kid in applyBundle and never adopt → wedge). The
    // joiner is NOT recorded as applied here: a deferred join has not been ratcheted in,
    // so the post-recovery REAL join for the same joiner must still ratchet it (recording
    // it now would let FIX-5 idempotency suppress that real join → permanent divergence).
    // The NEXT authoritative broadcast bundle reconciles the key.
    if (!this.currentKey) {
      clientLog.info(MOD, 'deferred JOIN (no current key — awaiting pending bundle)', {
        roomId: this.roomId,
        epoch: this._epoch,
        kid: this._epoch,
        envelopeCount: 0,
      });
      return null;
    }

    // Record the joiner as applied ONLY on the path that actually ratchets it in (after
    // the FIX-4 defer check) so a previously-deferred join is re-applied when it later
    // really joins; FIX-5 idempotency then suppresses only genuine duplicates.
    this.appliedJoiners.add(joiner.sessionPubkeyB64);
    const kOld = this.currentKey;
    const prevKid = this._epoch;
    this._epoch += 1;
    const kNew = ratchetOnJoin(kOld); // deterministic → all existing members converge
    this.promoteCurrentKey(kNew, prevKid);
    clientLog.info(MOD, 'ratchet on join', {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
      envelopeCount: 0,
    });
    // The seal-to-joiner coordinator is elected among the EXISTING members (the
    // joiner has no K_room yet and cannot seal to itself).
    if (!this.isCoordinatorAmongExisting(joiner.sessionPubkeyB64)) return null;
    const bundle = sealRoomKeyToRoster(kNew, this.sealRoster([joiner.sessionPubkeyB64]), {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
    });
    clientLog.info(MOD, 'sealed ratchet key to joiner only', {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
      envelopeCount: bundle.envelopes.length,
    });
    return bundle;
  }

  /**
   * LEAVE/revoke (member-remove): epoch++, kid=epoch. The coordinator generates a
   * FRESH-RANDOM K_room[new] = freshRekeyOnLeave() (a ratchet CANNOT evict — the
   * leaver knows K_room[old]) and reseals to the N-1 remaining in ONE broadcast
   * bundle (O(N)); returns it. A non-coordinator just bumps its epoch and waits for
   * the bundle (returns null). The leaver knows K_room[old] but CANNOT reach the
   * fresh-random K_room[new] = cryptographic eviction for FUTURE frames.
   *
   * The caller MUST have already removed the leaver from the roster (so the reseal
   * roster is the N-1 remaining and re-election excludes the leaver).
   *
   * The leave epoch is recorded as a FRESH-REKEY kid (FIX-2/B1): it is NOT
   * ratchet-reconstructable, so `reconcileToKid` must refuse to ratchet across it. A
   * non-coordinator that bumps its epoch here holds NO key for the new epoch until
   * the broadcast bundle arrives — a JOIN in that window is deferred, not thrown
   * (FIX-4).
   */
  async onMemberLeave(leaverSessionPubkeyB64: string): Promise<E2EEKeyBundle | null> {
    this.unresponsive.delete(leaverSessionPubkeyB64); // it is gone, not merely silent
    this.appliedJoiners.delete(leaverSessionPubkeyB64); // FIX-5: roster generation changed
    const prevKid = this._epoch;
    this._epoch += 1;
    this.freshRekeyKids.add(this._epoch); // FIX-2: this epoch is fresh-random, not a ratchet
    if (!this.isCoordinator()) {
      // non-coordinator: epoch bumped; it holds NO key for the new epoch yet and will
      // adopt the coordinator's fresh bundle (FIX-4: a JOIN before that is deferred).
      // Demote the prior current key into the grace store so in-flight OLD-kid frames
      // still decrypt during the rekey, then clear the current key (pending the bundle).
      if (this.currentKey && prevKid >= 0) {
        this.kidStore.set(prevKid, this.currentKey, this.now());
        this.kidStore.evictExpired(this.now());
      }
      this.currentKey = null; // pending: no usable current key until the bundle lands
      return null;
    }
    const kNew = freshRekeyOnLeave();
    this.promoteCurrentKey(kNew, prevKid);
    // reseal to the remaining roster (the leaver is already removed by the caller).
    const remaining = this.rosterPubkeys().filter((p) => p !== leaverSessionPubkeyB64);
    const bundle = sealRoomKeyToRoster(kNew, this.sealRoster(remaining), {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
    });
    clientLog.info(MOD, 'fresh rekey on leave', {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
      envelopeCount: bundle.envelopes.length,
    });
    return bundle;
  }

  // ── Observer: forced/admin eviction via on-chain capability_events (D-M2-5) ──
  //
  // The PRIMARY trigger (routine WS membership) is the onMemberJoin/onMemberLeave
  // methods above. These are the ADDITIONAL on-chain forced-eviction triggers. A thin
  // adapter over the shipped `useChainEvents` capability_events watcher subscribes a
  // `CapabilityRevoked` → onCapabilityRevoked / `CapabilityIssued` → onCapabilityIssued
  // (the live hook wiring is minimal; the library exposes the handlers).

  /** on-chain CapabilityIssued (forced admin add) → JOIN ratchet. */
  onCapabilityIssued(joiner: RosterMember): E2EEKeyBundle | null {
    return this.onMemberJoin(joiner);
  }

  /** on-chain CapabilityRevoked (forced admin eviction) → LEAVE fresh-rekey. */
  async onCapabilityRevoked(leaverSessionPubkeyB64: string): Promise<E2EEKeyBundle | null> {
    return this.onMemberLeave(leaverSessionPubkeyB64);
  }

  // ── Out-of-order ratchet reconciliation (P1 carry-forward c, epoch-driven) ──

  /**
   * Reconcile a member that missed one or more JOIN ratchets to the K_room at
   * `targetKid` by ratcheting forward from its last anchor by the epoch delta. The
   * ratchet is deterministic and one-way, so a member that processed the same joins
   * in a DIFFERENT order converges on the SAME K_room at `targetKid`. No-op if
   * already at/after the target.
   *
   * FIX-2 (B1): only valid across JOIN (ratchet) epochs. A LEAVE injects fresh-random
   * material that is NOT reconstructable by ratcheting, so a missed LEAVE MUST be
   * recovered from the coordinator's broadcast bundle (applyBundle). If any epoch in
   * the span `(currentEpoch, targetKid]` was a LEAVE (in `freshRekeyKids`), this
   * THROWS rather than silently deriving a WRONG-but-accepted key.
   */
  reconcileToKid(targetKid: number): void {
    if (targetKid <= this._epoch) return;
    // FIX-2: refuse to ratchet across any fresh-rekey (LEAVE) epoch in the span.
    for (let e = this._epoch + 1; e <= targetKid; e++) {
      if (this.freshRekeyKids.has(e)) {
        throw new Error(
          `KeyManager: cannot ratchet across a leave epoch (kid=${e}) — await the broadcast bundle (applyBundle)`,
        );
      }
    }
    let k = this.currentRoomKey();
    for (let e = this._epoch + 1; e <= targetKid; e++) {
      k = ratchetOnJoin(k);
      const prevKid = this._epoch;
      this._epoch = e;
      this.promoteCurrentKey(k, prevKid);
    }
    clientLog.info(MOD, 'reconciled to kid via epoch-delta ratchet', {
      roomId: this.roomId,
      epoch: this._epoch,
      kid: this._epoch,
      envelopeCount: 0,
    });
  }

  // ── Per-sender content key (D-M2-21 — the acceptance gate) ──

  private cacheKey(senderId: string, kid: number): string {
    return `${senderId}#${kid}`;
  }

  /**
   * Derive (and cache) the per-sender K_content CryptoKey for `(senderId, kid)`. The
   * production path REQUIRES a delimiter-free senderId (D-M2-21 (a)+(b)) — it throws
   * on a missing/empty/injected id. Returns null only when there is no K_room for
   * `kid` (rekeyed-out / grace lapsed / not yet received). FIX-1: the CURRENT epoch
   * resolves the dedicated non-expiring key.
   */
  async contentKeyForSenderAtKid(senderId: string, kid: number): Promise<CryptoKey | null> {
    assertSenderIdSafe(senderId);
    const kRoom = this.keyForKid(kid, this.now());
    if (!kRoom) return null;
    return this.deriveCached(senderId, kid, kRoom);
  }

  /** Shared derive-and-cache for the content key (keeps the cache key consistent). */
  private deriveCached(senderId: string, kid: number, kRoom: Uint8Array): Promise<CryptoKey> {
    const ck = this.cacheKey(senderId, kid);
    let p = this.contentKeyCache.get(ck);
    if (!p) {
      p = this.kdf.deriveContentKey({ kRoom, roomId: this.roomId, kid, senderId, oobSecret: this.oobSecret });
      this.contentKeyCache.set(ck, p);
    }
    return p;
  }

  /** TEST-ONLY: raw HKDF bits for a (sender, kid) to assert per-sender separation. */
  async contentBitsForSenderAtKid(senderId: string, kid: number): Promise<Uint8Array | null> {
    assertSenderIdSafe(senderId);
    const kRoom = this.keyForKid(kid, this.now());
    if (!kRoom) return null;
    return this.kdf.deriveContentBits({ kRoom, roomId: this.roomId, kid, senderId, oobSecret: this.oobSecret });
  }

  /**
   * The LOCAL sender's own K_content for the CURRENT kid (encrypt side — senderId =
   * this client's session pubkey). Returns null if no K_room is in effect yet.
   */
  async localContentKey(): Promise<CryptoKey | null> {
    return this.contentKeyForSenderAtKid(this.localPubkey, this._epoch);
  }

  /**
   * PER-PRODUCER KeyLookup FACTORY (D-M2-21 (c)). Returns a `KeyLookup` (the
   * sframe-transform.ts type) bound to ONE producer: `(kid, nowMs) => K_content
   * CryptoKey | null` for THAT producer at THAT kid. Validates the senderId UP FRONT
   * so an injected/empty id is rejected at factory time, not silently per frame.
   *
   * FIX-7 (C2): the grace check uses the KeyManager's OWN injected clock (`this.now()`),
   * NOT the caller-supplied `nowMs`. The transform may still CALL the lookup with a
   * wall-clock `nowMs` (the `KeyLookup` signature is unchanged for compatibility), but
   * we do NOT TRUST it — a custom monotonic / performance.now KeyManager clock and the
   * transform's wall clock are different domains, and mixing them silently breaks the
   * grace arithmetic. Single clock domain = the KeyManager's.
   */
  keyLookupForSender(senderId: string): KeyLookup {
    assertSenderIdSafe(senderId); // reject empty/injected at factory time
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return (kid: number, _callerNowMs: number): Promise<CryptoKey | null> | (CryptoKey | null) => {
      const kRoom = this.keyForKid(kid, this.now()); // FIX-7: KM clock, ignore caller nowMs
      if (!kRoom) return null;
      return this.deriveCached(senderId, kid, kRoom);
    };
  }
}
