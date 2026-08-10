/**
 * Vendored from services/client/client/src/lib/crypto/key-manager.ts — keep
 * byte-identical (below the import line; import paths adjusted to the
 * co-located layout here, targets otherwise unchanged). Resync manually if
 * the client's version changes.
 */

/**
 * REQ-MCS-012 (P3) — KeyManager: promotes the P1 keying spike to production.
 *
 * Built to the FROZEN contract: CONTRACTS.md §1 (sealed `e2eeKeyBundle`), §2 (KID ==
 * epoch + grace window), §3 (ed25519→X25519 seal/open via the in-closure opener, NOT
 * a raw private key), §4 AMENDED (delimiter-free per-sender `senderId`, D-M2-21);
 * SEQUENCES.md diagram 1 (key distribution) + 2 (ASYMMETRIC rekey).
 *
 * DRY: REUSES the shipped `e2ee-spike.ts` primitives wholesale — never reimplements
 * crypto. SCOPE: LIBRARY only — live per-producer transform wiring in useRelay is P6.
 * MODULE SPLIT: caller-facing types + `assertSenderIdSafe` live in
 * `key-manager-types.ts`; per-sender K_content derivation lives in
 * `key-manager-content-keys.ts`. This file is the class itself.
 *
 * MEMBERSHIP STATE-MACHINE (P3-fix hardening): FIX-1..7 (dedicated non-expiring
 * current-key field / no-ratchet-across-a-leave / grace eviction / deferred-join /
 * idempotent joins / regressing- and divergent-bundle handling / single clock
 * domain) are documented at their point of use below (`promoteCurrentKey`,
 * `reconcileToKid`, `onMemberJoin`, `applyBundle`, `keyLookupForSender`).
 *
 * KNOWN M2 LIMITATION (D-M2-8): a partition can make two members fresh-rekey at the
 * SAME epoch → two DIVERGENT K_room values at one KID. FIX-6 stops silent overwrite
 * (alarm + keep-first); full resolution needs epoch consensus (MLS/M3). Accepted.
 *
 * CRYPTO-CLAIM DISCIPLINE (D-M2-8): the group key has NO forward-secrecy/PCS (→M3).
 * Path C (`oobSecret`) excludes a covertly-admitted validator lacking the OOB from
 * content; without it, Path A is content-blind by ECONOMICS. Per-sender keying is
 * NONCE-DOMAIN SEPARATION, not authentication.
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
import {
  type RosterMember,
  type KeyManagerOptions,
  type DivergenceAlarm,
  assertSenderIdSafe,
} from './key-manager-types.js';
import {
  contentKeyForSenderAtKid as deriveContentKeyForSenderAtKid,
  contentBitsForSenderAtKid as deriveContentBitsForSenderAtKid,
  localContentKey as deriveLocalContentKey,
  keyLookupForSender as buildKeyLookupForSender,
} from './key-manager-content-keys.js';

export type { RosterMember, KeyManagerOptions };
export { assertSenderIdSafe };

const MOD = 'crypto/key-manager';

/**
 * Production KeyManager. One instance per local member per room. Coordinates the
 * group key (`K_room`) lifecycle, derives per-sender `K_content`, and exposes a
 * per-producer `KeyLookup` for the SFrame transform.
 */
export class KeyManager {
  /* eslint-disable @typescript-eslint/member-ordering */
  readonly roomId: string;
  readonly localPubkey: string;
  private readonly opener: SessionOpener;
  /** Grace-window clock. NOT `private` — `key-manager-content-keys.ts` reads it
   * directly to stay on the same clock domain as `keyForKid` (FIX-7/C2). */
  readonly now: () => number;
  /** Content-key derivation strategy: PathC iff a usable OOB is held, else the
   * certified Path A (selected once in the ctor, immutable). */
  readonly kdf: PathAKeyDerivation;
  /** Lane D Path C static OOB salt (defensive-copied on ingest). undefined ⇒ Path A. NEVER logged. */
  readonly oobSecret?: Uint8Array;

  /** Current roster {peerId → sessionPubkey}. The set the coordinator seals to. */
  private roster: RosterMember[] = [];
  /** Peers considered unresponsive (liveness fallback, D-M2-3). */
  private readonly unresponsive = new Set<string>();

  /** Monotonic membership epoch; `kid === epoch` (CONTRACTS §2). Bumps per change. */
  private _epoch = 0;

  /** The CURRENT epoch's raw K_room (FIX-1/B3), in a DEDICATED field that NEVER
   * expires — grace applies to SUPERSEDED keys only. Null only before bootstrap /
   * while a leave-bundle is pending on a non-coordinator. */
  private currentKey: Uint8Array | null = null;

  /** Receiver-side KID→raw-K_room store with the grace window (DRY: shipped spike).
   * Holds ONLY SUPERSEDED KIDs; expired entries evicted on store/lookup (FIX-3). */
  private readonly kidStore: KidKeyStore;

  /** KIDs whose key was a FRESH-RANDOM rekey (a LEAVE), NOT a ratchet (FIX-2/B1) —
   * `reconcileToKid` throws if its span crosses one. */
  private readonly freshRekeyKids = new Set<number>();

  /** Joiner session pubkeys already applied at the CURRENT roster generation
   * (FIX-5/E1) — a redelivered JOIN is a no-op. Cleared on a LEAVE. */
  private readonly appliedJoiners = new Set<string>();

  /** Cache of derived K_content CryptoKeys, keyed by `${senderId}#${kid}`. NOT
   * `private` — `key-manager-content-keys.ts` shares it. */
  readonly contentKeyCache = new Map<string, Promise<CryptoKey>>();

  /** FIX-6 divergence alarm sink (defaults to a structured clientLog.warn). */
  private divergenceAlarm: DivergenceAlarm;

  constructor(opts: KeyManagerOptions) {
    this.roomId = opts.roomId;
    this.localPubkey = opts.localSessionPubkeyB64;
    this.opener = opts.opener;
    this.now = opts.now ?? Date.now;
    // Defensive-copy so per-instance immutability is ENFORCED, not conventional.
    this.oobSecret = opts.oobSecret ? opts.oobSecret.slice() : undefined;
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

  /** True iff this client is the coordinator elected among the EXISTING members
   * (roster EXCLUDING `excludedPubkey`, the joiner) — a joiner has no K_room yet
   * and cannot seal to itself (D-M2-3 over the pre-join set). */
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
   * epoch resolves the DEDICATED non-expiring field; any other kid resolves the
   * grace-bounded store. Null if unusable. Evicts expired entries (FIX-3/F1).
   * NOT `private` — `key-manager-content-keys.ts` calls this directly.
   */
  keyForKid(kid: number, nowMs: number): Uint8Array | null {
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

  /** TEST-ONLY: record `kid` as a LEAVE (fresh-rekey) epoch (FIX-2 span-scan). */
  recordLeaveEpochForTest(kid: number): void {
    this.freshRekeyKids.add(kid);
  }

  /** Build the SyntheticMember-shaped roster the spike seal path consumes (anonymous
   * seal — privateKeyRaw is unused and a fresh zero buffer per member). */
  private sealRoster(pubkeys: string[]): SyntheticMember[] {
    return pubkeys.map((b64) => ({
      publicKeyB64: b64,
      publicKeyRaw: fromB64(b64),
      privateKeyRaw: new Uint8Array(0),
    }));
  }

  /** Promote a freshly-generated/-adopted key to the CURRENT epoch (FIX-1): the OLD
   * current key (if any) is demoted into the grace-bounded store under its OWN kid
   * (`prevKid`), starting its grace, then `currentKey` is replaced. Evicts expired
   * superseded entries (FIX-3). */
  private promoteCurrentKey(newCurrent: Uint8Array, prevKid: number): void {
    if (this.currentKey && prevKid >= 0 && prevKid !== this._epoch) {
      // demote the prior current key: it becomes a superseded KID with its OWN grace.
      this.kidStore.set(prevKid, this.currentKey, this.now());
    }
    this.currentKey = newCurrent;
    this.kidStore.evictExpired(this.now()); // FIX-3
  }

  /** COORDINATOR bootstrap (first key, SEQUENCES diagram 1): bump epoch, generate a
   * fresh K_room, seal to the whole roster, store locally, return the broadcast
   * bundle. Throws if not the coordinator. */
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

  /** MEMBER apply an incoming bundle (SEQUENCES diagram 1, NON-coordinator path):
   * adopt epoch/kid, find MY envelope, open via the in-closure opener (NOT
   * openOwnEnvelope), store K_room at that kid. Throws if no envelope / wrong key.
   * FIX-6 (A4b): (i) a REGRESSING bundle is informational only. (ii) a SAME-kid
   * bundle whose material DIFFERS from current fires a divergence alarm and is
   * rejected (keep-first), never silently overwritten. */
  async applyBundle(bundle: E2EEKeyBundle): Promise<void> {
    const mine: SealedEnvelope | undefined = bundle.envelopes.find(
      (e) => e.recipientPubkey === this.localPubkey,
    );
    if (!mine) {
      throw new Error(`KeyManager: no envelope for me in bundle kid=${bundle.kid}`);
    }
    const kRoom = await this.opener.unsealRoomKey(mine.sealedKey); // throws on wrong key

    // FIX-6 (i): a strictly-regressing bundle is informational — do not store/refresh.
    if (bundle.kid < this._epoch) {
      clientLog.info(MOD, 'ignored regressing K_room bundle (informational)', {
        roomId: this.roomId,
        epoch: bundle.epoch,
        kid: bundle.kid,
        envelopeCount: bundle.envelopes.length,
      });
      return;
    }

    // FIX-6 (ii): a same-kid divergence — alarm and KEEP-FIRST, never overwrite.
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

  /** JOIN (member-add): epoch++, kid=epoch. EXISTING members self-derive
   * K_room[new] = ratchetOnJoin(K_room[old]) LOCALLY (O(1), one-way); the
   * COORDINATOR additionally seals K_room[new] to the JOINER ONLY. The joiner
   * CANNOT derive K_room[old] (backward secrecy). FIX-5 (E1): a redelivered JOIN
   * for an already-applied joiner is a no-op. FIX-4 (C1): with no current key yet
   * (leave-bundle pending), the ratchet is DEFERRED (not recorded as applied, so
   * the later real join still ratchets it) rather than thrown. */
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
    // FIX-4: no current key (leave-bundle pending) — DEFER, don't ratchet/bump epoch
    // past the pending bundle. Not recorded as applied, so a real join still ratchets.
    if (!this.currentKey) {
      clientLog.info(MOD, 'deferred JOIN (no current key — awaiting pending bundle)', {
        roomId: this.roomId,
        epoch: this._epoch,
        kid: this._epoch,
        envelopeCount: 0,
      });
      return null;
    }

    // Recorded as applied only past the FIX-4 defer check, so a previously-deferred
    // join is re-applied when it later really joins.
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

  /** LEAVE/revoke (member-remove): epoch++, kid=epoch. The coordinator generates a
   * FRESH-RANDOM K_room[new] = freshRekeyOnLeave() (a ratchet CANNOT evict — the
   * leaver knows K_room[old]) and reseals to the N-1 remaining in ONE broadcast
   * bundle. A non-coordinator bumps its epoch and waits for the bundle. Caller MUST
   * have already removed the leaver from the roster. The leave epoch is recorded as
   * a FRESH-REKEY kid (FIX-2/B1) — `reconcileToKid` must refuse to cross it. */
  async onMemberLeave(leaverSessionPubkeyB64: string): Promise<E2EEKeyBundle | null> {
    this.unresponsive.delete(leaverSessionPubkeyB64); // it is gone, not merely silent
    this.appliedJoiners.delete(leaverSessionPubkeyB64); // FIX-5: roster generation changed
    const prevKid = this._epoch;
    this._epoch += 1;
    this.freshRekeyKids.add(this._epoch); // FIX-2: this epoch is fresh-random, not a ratchet
    if (!this.isCoordinator()) {
      // non-coordinator: bumped, no key yet — demote prior current key into grace
      // store (in-flight OLD-kid frames still decrypt), then await the bundle.
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
  // ADDITIONAL trigger alongside the routine-WS-membership onMemberJoin/Leave above;
  // a thin `useChainEvents` adapter subscribes CapabilityRevoked/Issued to these.

  /** on-chain CapabilityIssued (forced admin add) → JOIN ratchet. */
  onCapabilityIssued(joiner: RosterMember): E2EEKeyBundle | null {
    return this.onMemberJoin(joiner);
  }

  /** on-chain CapabilityRevoked (forced admin eviction) → LEAVE fresh-rekey. */
  async onCapabilityRevoked(leaverSessionPubkeyB64: string): Promise<E2EEKeyBundle | null> {
    return this.onMemberLeave(leaverSessionPubkeyB64);
  }

  // ── Out-of-order ratchet reconciliation (P1 carry-forward c, epoch-driven) ──

  /** Reconcile a member that missed one or more JOIN ratchets to the K_room at
   * `targetKid` by ratcheting forward by the epoch delta (deterministic, one-way —
   * order-independent convergence). No-op if already at/after the target. FIX-2
   * (B1): only valid across JOIN epochs — if any epoch in `(currentEpoch,
   * targetKid]` was a LEAVE (`freshRekeyKids`), THROWS rather than silently
   * deriving a wrong key (a missed LEAVE must come from `applyBundle`). */
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
  // The derivation logic itself lives in `key-manager-content-keys.ts`; these are
  // thin instance-method wrappers kept here so the public API is unchanged.

  async contentKeyForSenderAtKid(senderId: string, kid: number): Promise<CryptoKey | null> {
    return deriveContentKeyForSenderAtKid(this, senderId, kid);
  }

  async contentBitsForSenderAtKid(senderId: string, kid: number): Promise<Uint8Array | null> {
    return deriveContentBitsForSenderAtKid(this, senderId, kid);
  }

  async localContentKey(): Promise<CryptoKey | null> {
    return deriveLocalContentKey(this);
  }

  keyLookupForSender(senderId: string): KeyLookup {
    return buildKeyLookupForSender(this, senderId);
  }
}
