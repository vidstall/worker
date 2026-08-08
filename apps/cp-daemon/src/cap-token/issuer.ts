/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer (cp-daemon module).
 *
 * Issues + revokes RoomCapability tokens in response to chain events:
 *   - room_manager::RoomAssigned   → issue tokens to each peer in the room
 *   - miner::registration::RoleChanged → trigger refresh (Phase 3.4 grace timer; here stub-stage)
 *   - role_voting::RoleAssigned    → trigger refresh on vote consensus
 *   - economic_layer::RelaySlashed → bulk-revoke tokens for the slashed relay
 *
 * NOTE (F8 / REQ-CRR-005): the `turn_credential::SecretRotated` emergency event
 * is NOT handled here. It rotates the TURN shared SECRET (orthogonal to the
 * RoomCapability admission token — ADR-0010 D-009), so its daemon reaction lives
 * in the TURN issuer kill-switch (`event-handler.ts` → `turn-issuer.ts`
 * `emergencyEvictSecret`), not in this cap-token module.
 *
 * Spec sources:
 *   - CONTRACTS.md § 4.4 (interface)
 *   - SEQUENCES.md § 1 (issuance) + § 4 (revoke) + § 3 (refresh future)
 *   - DECISIONS.md § D-010-A (real event names) + § D-B4 (M=2/N=3 default)
 *
 * Implementation conventions (match existing cp-daemon modules — turn-issuer pattern):
 *   - SubmitFn DI for tests (production wires to executeWithRetry)
 *   - In-memory dedupe Set, key per handler per § 4.4
 *   - Structured JSON logging via pino: { trace_id, module: 'cap-token-issuer', context }
 *   - Errors absorbed (logger.error) — daemon must remain alive across retryable failures
 *
 * Split out of the former monolithic `cap-token-issuer.ts` (god-file split). Types
 * live in `./types.js`, canonical byte-layout builders in `./canonical-messages.js`,
 * infra-peer recovery in `./infra-peer-recovery.js`.
 */
import type { Logger } from '@dvconf/shared';
import type {
  SubmitFn,
  CpKeystore,
  CapTokenCacheLike,
  RoomAssignedEvent,
  RoleChangedEvent,
  RoleAssignedEvent,
  RelaySlashedEvent,
  EmergencyRotationEvent,
  CapTokenIssuerOpts,
} from './types.js';
import {
  resolvePeerPubkey,
  buildIssueCanonicalMsg,
  buildRevokeCanonicalMsg,
  buildRefreshCanonicalMsg,
  bytesToHex,
} from './canonical-messages.js';
import {
  recoverInfraPeerClaim,
  type InfraPeerPubkeyCache,
} from './infra-peer-recovery.js';
import type { CapabilityIssuedLike } from './infra-peer-recovery.js';

/**
 * Default expiry window for fresh tokens — Sui epoch-units. Picked above
 * MIN_REMAINING_EPOCHS=5 (per D-007-A precedent) with comfortable headroom
 * so the late-join window in `verify_capability_token` is not crossed.
 */
const DEFAULT_EXPIRES_OFFSET_EPOCHS = 100n;

/**
 * Map a relay/validator address to its Move role enum value used by
 * room_capability.move (matches MinerRole constants in dvconf-contracts).
 *   1 = validator, 2 = relay, 3 = CP, 0 = user/default
 * (The standalone signaling node type -- role 4 -- was removed along with
 * the node type itself.)
 */
function roleForPeerKind(kind: 'relay' | 'validator'): number {
  switch (kind) {
    case 'relay':
      return 2;
    case 'validator':
      return 1;
  }
}

export class CapTokenIssuer {
  private readonly submitFn: SubmitFn;
  private readonly packageId: string;
  private readonly networkRegistryId: string;
  private readonly cpRegistryObjectId: string;
  private readonly quorumStateObjectId: string;
  private readonly keystore: CpKeystore;
  private readonly logger: Logger;
  private readonly threshold: number;
  private readonly graceMs: number;
  /** Idempotency: per-handler dedupe key → seen-flag. Reset only on daemon restart. */
  private readonly seenKeys = new Set<string>();
  /**
   * Phase 3.4 REQ-ADM-013 — anti-replay nonce tracking. Key: `${roomId}::${peerHex}`,
   * value: highest nonce dispatched on a refresh TX for that (room, peer) pair. Initial
   * issuance starts at 1 (per D-010-B); the first refresh stores 1, subsequent refreshes
   * monotonically increment. External invocations submitting a refresh nonce ≤ current
   * are rejected with a nonce-replay WARN log.
   */
  private readonly nonces = new Map<string, number>();
  /**
   * Phase 3.4 REQ-ADM-014 — pending grace timers. Keyed by miner-id (role-change /
   * role-assigned) so that a B→A revert can cancel a prior A→B pending timer via
   * `clearTimeout`. Map entries are cleared when the timer fires OR is cancelled.
   */
  private readonly graceTimers = new Map<string, NodeJS.Timeout>();
  /** Stage 4 Item #3 — optional cache for fast-path emergency invalidation (D-012 Addendum). */
  private readonly cache?: CapTokenCacheLike;
  /** W-P2 (D-W7) — optional live-epoch source; read lazily in resolveExpiresEpoch(). */
  private readonly getCurrentEpoch?: () => bigint;
  /** Leg 7c (G3) — optional infra-peer pubkey recovery cache (multi-CP infra path). */
  private readonly infraPeerCache?: InfraPeerPubkeyCache;

  constructor(opts: CapTokenIssuerOpts) {
    this.submitFn = opts.submitFn;
    this.packageId = opts.packageId;
    this.networkRegistryId = opts.networkRegistryId;
    this.cpRegistryObjectId = opts.cpRegistryObjectId;
    this.quorumStateObjectId = opts.quorumStateObjectId;
    this.keystore = opts.cpKeystore;
    this.logger = opts.logger;
    this.threshold = opts.quorumThreshold ?? 2;
    this.graceMs = opts.graceMs ?? 60_000;
    this.cache = opts.cache;
    this.getCurrentEpoch = opts.getCurrentEpoch;
    this.infraPeerCache = opts.infraPeerCache;
  }

  /**
   * W-P2 (D-W7) — resolve a fresh token's expiry epoch. `currentEpoch + offset`,
   * read lazily so the cached-epoch refresher's latest value is used. Falls back
   * to `0 + offset` (the legacy 100n placeholder) when no epoch source is wired.
   */
  private resolveExpiresEpoch(): bigint {
    return (this.getCurrentEpoch?.() ?? 0n) + DEFAULT_EXPIRES_OFFSET_EPOCHS;
  }

  // ── Public handlers ────────────────────────────────────────────────────

  /**
   * REQ-ADM-001 — issue capability tokens to every peer assigned to the room.
   * Dedupe key: `${event.roomId}::pairing-finalize`.
   */
  async onRoomAssigned(event: RoomAssignedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoomAssigned received',
    );

    const dedupeKey = `${event.roomId}::pairing-finalize`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoomAssigned')) return;

    try {
      const peers: Array<{ id: string; role: number }> = [
        ...event.relayIds.map((id) => ({ id, role: roleForPeerKind('relay') })),
        ...event.validatorIds.map((id) => ({ id, role: roleForPeerKind('validator') })),
      ];

      for (const peer of peers) {
        await this.submitIssue(peer, event.roomId, dedupeKey, traceId);
      }
    } catch (err) {
      this.logger.error(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, err: (err as Error).message },
        },
        'onRoomAssigned failed — quorum collection or TX submit error',
      );
    }
  }

  /**
   * Leg 7c (G3) — observe a `CapabilityIssued` chain event, feeding the infra-peer pubkey
   * recovery cache keyed by `(roomId, peerId)`. Wired off the event-handler `CapabilityIssued`
   * arm (additive observer — clones the RoomAssigned dispatch shape). No-op when no recovery
   * cache is configured (single-CP / legacy). The cache itself REJECTS a non-32-byte
   * `peer_pubkey` (never poisons recovery into a 916 mint).
   *
   * @param peerId  the infra peer's Sui miner-id (the recovery lookup key submitIssue uses).
   * @param event   the observed `CapabilityIssued` payload (carries the real 32-byte pubkey).
   */
  onCapabilityIssued(peerId: string, event: CapabilityIssuedLike, traceId: string): void {
    if (!this.infraPeerCache) return; // no recovery configured — observer is a no-op
    this.infraPeerCache.observeCapabilityIssued(peerId, event);
    this.logger.debug(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: { peer_id: peerId, room_id: event.roomId, recovery_cache_fed: true },
      },
      'observed CapabilityIssued — infra-peer pubkey cache fed (G3)',
    );
  }

  /**
   * REQ-ADM-013 + REQ-ADM-014 — role-change refresh trigger.
   * Phase 3.4: dedupe + schedule 60s grace timer (cancellable on role-revert) →
   * after grace, invoke `refresh_capability_token` Move entry per CONTRACTS § 4.1
   * (uses aggregate_sig param per D-011). If a prior pending timer exists for the
   * SAME minerId, cancel it (the role change has been superseded — most commonly
   * a B→A revert before the original A→B grace elapsed).
   */
  async onRoleChanged(event: RoleChangedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoleChanged received',
    );

    const dedupeKey = `${event.minerId}::${event.newRole}::role-change`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoleChanged')) return;

    const cancelled = this.cancelPendingGrace(event.minerId, 'role-change', traceId);
    if (cancelled) {
      // Revert detected — both directions cancel each other; do NOT schedule
      // a new grace window. Role has settled back to the prior value before
      // any refresh was needed. REQ-ADM-014 cancel-on-revert semantics.
      return;
    }
    this.scheduleGraceRefresh(
      event.minerId,
      'role-change',
      {
        affectedTokenId: event.affectedTokenId,
        roomId: event.roomId,
        peerPubkey: event.peerPubkey,
        newRole: event.newRole,
      },
      traceId,
    );

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          miner_id: event.minerId,
          new_role: event.newRole,
          grace_ms: this.graceMs,
        },
      },
      'RoleChanged — grace timer scheduled (REQ-ADM-014)',
    );
  }

  /**
   * REQ-ADM-013 — vote consensus on role assignment. Phase 3.4: same grace pattern
   * as onRoleChanged, dedupe key reflects "role-assigned" disambiguator.
   */
  async onRoleAssigned(event: RoleAssignedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoleAssigned received',
    );

    const dedupeKey = `${event.minerId}::${event.role}::role-assigned`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoleAssigned')) return;

    const cancelled = this.cancelPendingGrace(event.minerId, 'role-assigned', traceId);
    if (cancelled) {
      return;
    }
    this.scheduleGraceRefresh(
      event.minerId,
      'role-assigned',
      {
        affectedTokenId: event.affectedTokenId,
        roomId: event.roomId,
        peerPubkey: event.peerPubkey,
        newRole: event.role,
      },
      traceId,
    );

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          miner_id: event.minerId,
          role: event.role,
          grace_ms: this.graceMs,
        },
      },
      'RoleAssigned — grace timer scheduled (REQ-ADM-014)',
    );
  }

  /**
   * REQ-ADM-015 — emergency rotation handler. Bypasses the 60s grace timer entirely;
   * the rotation reason is logged at WARN level with the event payload for audit.
   *
   * Idempotency: dedupe by `${peerHex}::emergency-rotate` so replays of the same
   * emergency event do not re-trigger the refresh + revoke-old pair.
   *
   * C4 Case B: invokes executeRefresh which submits the refresh TX AND a follow-up
   * revoke-old TX (reason=4 refresh-driven) per CONTRACTS § 4.1 + cap-token-cache.ts
   * fast-path eviction requirement (REQ-ADM-005 cross-tie).
   */
  async onEmergencyRotation(event: EmergencyRotationEvent, traceId: string): Promise<void> {
    const peerHex = bytesToHex(event.peerPubkey);
    const dedupeKey = `${peerHex}::emergency-rotate`;

    this.logger.warn(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          reason: event.reason,
          old_token_id: event.oldTokenId,
          room_id: event.roomId,
        },
      },
      'EmergencyRotation received — bypass grace + refresh immediately',
    );

    if (this.markSeenOrSkip(dedupeKey, traceId, 'onEmergencyRotation')) return;

    // Stage 4 Item #3 — D-012 Addendum fast-path: evict the OLD token from the
    // consuming daemon's cache BEFORE submitting the rotation TX so any
    // concurrent WS verify call short-circuits to null even if the chain
    // `CapabilityRevoked` event has not yet landed in the cache via
    // `handleEvent`. Loose-coupling: `cache` is the optional `CapTokenCacheLike`
    // shape from constructor opts — cross-daemon process boundary makes
    // `undefined` an acceptable runtime state (chain-event-driven invalidation
    // still satisfies REQ-ADM-005 ≤5s in steady state).
    if (this.cache) {
      this.cache.emergencyInvalidate(event.oldTokenId, `rotation-${event.reason}`);
      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: {
            dedupe_key: dedupeKey,
            old_token_id: event.oldTokenId,
            cache_reason: `rotation-${event.reason}`,
          },
        },
        'cache fast-path invalidated for emergency rotation',
      );
    }

    await this.executeRefresh(
      {
        oldTokenId: event.oldTokenId,
        roomId: event.roomId,
        peerPubkey: event.peerPubkey,
        newRole: event.role,
      },
      dedupeKey,
      traceId,
    );
  }

  /**
   * REQ-ADM-011 sister — bulk-revoke tokens scoped to a slashed relay's room.
   * Dedupe key: `${event.roomId}::${event.relayMinerId}::slash`.
   */
  async onRelaySlashed(event: RelaySlashedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RelaySlashed received',
    );

    const dedupeKey = `${event.roomId}::${event.relayMinerId}::slash`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRelaySlashed')) return;

    try {
      await this.submitRevoke(event.relayMinerId, dedupeKey, traceId);
    } catch (err) {
      this.logger.error(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, err: (err as Error).message },
        },
        'onRelaySlashed failed — quorum collection or TX submit error',
      );
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  /**
   * Returns true if the dedupe key was already seen (caller skips). Otherwise marks
   * the key and returns false. Idempotency surface for at-least-once event delivery.
   */
  private markSeenOrSkip(dedupeKey: string, traceId: string, handler: string): boolean {
    if (this.seenKeys.has(dedupeKey)) {
      this.logger.warn(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, handler, skipped_reason: 'duplicate-event' },
        },
        'Idempotency hit — skipping duplicate event',
      );
      return true;
    }
    this.seenKeys.add(dedupeKey);
    return false;
  }

  /**
   * Build canonical message, collect M-of-N signatures, submit issue TX.
   * On collectQuorumSignatures throw: re-throw to caller which logs + absorbs.
   */
  private async submitIssue(
    peer: { id: string; role: number; sessionPubkeyB64?: string },
    roomId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const nonce = 1; // first issuance per (room, peer) — monotonic counter per D-010-B starts at 1
    const expiresEpoch = this.resolveExpiresEpoch(); // W-P2 D-W7: live epoch + offset (was 100n placeholder)
    // REQ-MCS-012 (W5 M2 P1.0) — resolve the admission `peer_pubkey`.
    //
    // Legacy (infrastructure peer): `peer.id` is the Sui miner-ID hex string
    // (relay/validator from the RoomAssigned event); we hex-decode it
    // so the daemon's canonical_msg and Move's canonical_msg agree structurally
    // (Stage 4 Item #6 + D-014). This was the F62 deferred-wiring placeholder.
    //
    // E2EE path (CONTRACTS §0 / D-M2-16): when the client's in-browser ed25519
    // SESSION pubkey is supplied (`peer.sessionPubkeyB64`), it becomes the
    // `peer_pubkey` instead — so the on-chain RoomCapability.peer_pubkey IS the
    // client session key (transparency log + sealed-box recipient). 0 Move
    // change: room_capability.move:198-201 only length-checks the 32-byte field.
    //
    // Leg 7c (G3): for an INFRA peer (no session key) WITH a recovery cache wired, recover the
    // REAL 32-byte `peer_pubkey` from the observed `CapabilityIssued` event BEFORE the legacy
    // `resolvePeerPubkey` miner-id placeholder (which is NOT 32 bytes → would abort the Move
    // mint 916). A recovery MISS → fail-closed SKIP + debug-log (never a malformed mint). The
    // E2EE `sessionPubkeyB64` branch is NEVER routed through recovery — it resolves verbatim.
    let peerPubkey: number[];
    if (peer.sessionPubkeyB64 === undefined && this.infraPeerCache) {
      const recovered = recoverInfraPeerClaim(
        { roomId, peerId: peer.id, role: peer.role, expiresEpoch, nonce },
        this.infraPeerCache,
      );
      if (recovered === null) {
        // FAIL-CLOSED SKIP: no cached CapabilityIssued for (room, peer) yet (or a non-32-byte
        // value). Skip this infra peer's mint rather than risk a 916 abort. Visible via debug.
        this.logger.debug(
          {
            trace_id: traceId,
            module: 'cap-token-issuer',
            context: { dedupe_key: dedupeKey, peer_id: peer.id, reason: 'infra-peer-pubkey-unrecovered' },
          },
          'G3 recovery miss — fail-closed skip of infra-peer cap-token issue (no 916 mint)',
        );
        return;
      }
      peerPubkey = recovered.peerPubkey;
    } else {
      peerPubkey = resolvePeerPubkey(peer);
    }
    const canonicalMsg = buildIssueCanonicalMsg({
      roomId,
      peerPubkey,
      role: peer.role,
      expiresEpoch,
      nonce,
    });

    const { qs, pubkeys, aggregateSig } = await this.keystore.collectQuorumSignatures(
      canonicalMsg,
      this.threshold,
    );

    const result = await this.submitFn({
      label: 'issue-capability-token',
      args: {
        target: `${this.packageId}::room_capability::issue_capability_token`,
        networkRegistryId: this.networkRegistryId,
        cpRegistryObjectId: this.cpRegistryObjectId,
        quorumStateObjectId: this.quorumStateObjectId,
        roomId,
        peerId: peer.id,
        peerPubkey,
        role: peer.role,
        expiresEpoch,
        nonce,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        // D-011: BCS-serialized QuorumSig blob stored on-chain as the minted
        // RoomCapability's `aggregate_sig` field (Move param 11 between
        // signer_pubkeys and ctx). Aligns TS daemon → Move chain SOT.
        aggregateSig,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'onRoomAssigned',
          tx_digest: result.digest,
          peer_id: peer.id,
          role: peer.role,
        },
      },
      'TX submitted',
    );
  }

  /** Collect quorum for revoke + submit revoke_capability_token_via_quorum TX. */
  private async submitRevoke(
    capObjectId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const reason = 1; // 1 = slash per capability_events.move encoding (D-002)
    const canonicalMsg = buildRevokeCanonicalMsg({ capObjectId, reason });

    const { qs, pubkeys } = await this.keystore.collectQuorumSignatures(
      canonicalMsg,
      this.threshold,
    );

    const result = await this.submitFn({
      label: 'revoke-capability-token-via-quorum',
      args: {
        target: `${this.packageId}::room_capability::revoke_capability_token_via_quorum`,
        networkRegistryId: this.networkRegistryId,
        cpRegistryObjectId: this.cpRegistryObjectId,
        quorumStateObjectId: this.quorumStateObjectId,
        capObjectId,
        reason,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'onRelaySlashed',
          tx_digest: result.digest,
          cap_object_id: capObjectId,
        },
      },
      'TX submitted',
    );
  }

  // ── Phase 3.4 — grace timer + refresh helpers ────────────────────────────

  /**
   * Cancel any pending grace timer for the given minerId. Called BEFORE
   * scheduling a new timer; if a prior timer exists (e.g. previous role-change
   * is being superseded by a revert), `clearTimeout` aborts it and a single
   * INFO log line records the cancellation for operator visibility.
   *
   * The cancel-on-revert mandate (REQ-ADM-014 + briefing) treats any
   * subsequent role-change/role-assigned event for the same minerId as the
   * canonical reverse-direction signal — the issuer does NOT inspect
   * old_role/new_role pairings, since the second event by definition
   * supersedes the first (whatever its direction). This is the safest
   * interpretation: if both events ultimately fire refreshes, the second
   * one's parameters win.
   */
  private cancelPendingGrace(minerId: string, kind: 'role-change' | 'role-assigned', traceId: string): boolean {
    let cancelled = false;
    const timerKey = `${minerId}::${kind}`;
    const existing = this.graceTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
      this.graceTimers.delete(timerKey);
      cancelled = true;
      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { timer_key: timerKey, miner_id: minerId, kind },
        },
        'grace timer cancelled — role reverted before 60s window',
      );
    }
    // Also cancel a timer scheduled under the OPPOSITE kind for the same
    // minerId — a role-change can be superseded by a role-assigned and vice
    // versa, per REQ-ADM-014 cancel-on-revert semantics.
    const oppositeKey = `${minerId}::${kind === 'role-change' ? 'role-assigned' : 'role-change'}`;
    const opposite = this.graceTimers.get(oppositeKey);
    if (opposite) {
      clearTimeout(opposite);
      this.graceTimers.delete(oppositeKey);
      cancelled = true;
      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { timer_key: oppositeKey, miner_id: minerId, kind: 'opposite' },
        },
        'grace timer cancelled — role reverted before 60s window',
      );
    }
    return cancelled;
  }

  /**
   * Schedule a refresh that fires after `graceMs`. Only enqueues a real timer
   * when the caller supplied affectedTokenId + roomId + peerPubkey (test
   * fixtures without this context fall through to a log-only path so the
   * existing onRoleChanged-without-token fixture still exercises dedupe).
   */
  private scheduleGraceRefresh(
    minerId: string,
    kind: 'role-change' | 'role-assigned',
    ctx: {
      affectedTokenId?: string;
      roomId?: string;
      peerPubkey?: number[];
      newRole: number;
    },
    traceId: string,
  ): void {
    if (!ctx.affectedTokenId || !ctx.roomId || !ctx.peerPubkey) {
      return;
    }

    const timerKey = `${minerId}::${kind}`;
    const timer = setTimeout(() => {
      this.graceTimers.delete(timerKey);
      // executeRefresh is async; we intentionally do not await here (setTimeout
      // callback is sync). Errors are absorbed inside executeRefresh.
      void this.executeRefresh(
        {
          oldTokenId: ctx.affectedTokenId!,
          roomId: ctx.roomId!,
          peerPubkey: ctx.peerPubkey!,
          newRole: ctx.newRole,
        },
        timerKey,
        traceId,
      );
    }, this.graceMs);
    this.graceTimers.set(timerKey, timer);
  }

  /**
   * Phase 3.4 + C4 inject (Case B). Builds canonical refresh payload, increments
   * the per-(room,peer) nonce, collects M-of-N quorum, submits refresh TX, then
   * follows with a revoke_capability_token_via_quorum TX for the OLD token
   * (reason=4 refresh-driven) so cap-token-cache.ts evicts the stale entry on
   * the next CapabilityRevoked chain event.
   *
   * Case B chosen: Move `refresh_capability_token` (room_capability.move
   * S54 commit `e3780d3`) emits ONLY `CapabilityRefreshed` — it does NOT emit
   * `CapabilityRevoked` for the old token despite mutating `old_token.revoked =
   * true`. cap-token-cache fast-path eviction at lines 156-159 depends on the
   * revoke event. The follow-up TX ensures REQ-ADM-005 ≤5s eviction holds.
   *
   * Defense narrative: chain-as-SOT (Fork 3) — the cache reacts to canonical
   * chain events; we never derive eviction logic from the refresh event
   * payload (which lacks an old-token-id field), so the second TX is the
   * defensible path until Move-side emits both events atomically (post-thesis).
   */
  private async executeRefresh(
    ctx: { oldTokenId: string; roomId: string; peerPubkey: number[]; newRole: number },
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    try {
      const peerHex = bytesToHex(ctx.peerPubkey);
      const nonceKey = `${ctx.roomId}::${peerHex}`;
      const currentNonce = this.nonces.get(nonceKey) ?? 0;
      const nextNonce = currentNonce + 1;

      const newExpiresEpoch = this.resolveExpiresEpoch(); // W-P2 D-W7: live epoch + offset (was 100n placeholder)
      const canonicalMsg = buildRefreshCanonicalMsg({
        oldTokenId: ctx.oldTokenId,
        newRole: ctx.newRole,
        newExpiresEpoch,
        refreshNonce: nextNonce,
      });

      const { qs, pubkeys, aggregateSig } = await this.keystore.collectQuorumSignatures(
        canonicalMsg,
        this.threshold,
      );

      // Increment nonce BEFORE TX submit so a concurrent replay attempt sees
      // the bumped counter and gets rejected.
      this.nonces.set(nonceKey, nextNonce);

      const refreshResult = await this.submitFn({
        label: 'refresh-capability-token',
        args: {
          target: `${this.packageId}::room_capability::refresh_capability_token`,
          networkRegistryId: this.networkRegistryId,
          cpRegistryObjectId: this.cpRegistryObjectId,
          quorumStateObjectId: this.quorumStateObjectId,
          oldTokenId: ctx.oldTokenId,
          newRole: ctx.newRole,
          newExpiresEpoch,
          refreshNonce: nextNonce,
          cpQuorumProof: qs,
          signerPubkeys: pubkeys,
          // D-011: aggregate_sig param between signer_pubkeys and ctx
          aggregateSig,
          canonicalMsg: Array.from(canonicalMsg),
        },
      });

      this.logger.info(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: {
            dedupe_key: dedupeKey,
            handler: 'executeRefresh',
            tx_digest: refreshResult.digest,
            old_token_id: ctx.oldTokenId,
            refresh_nonce: nextNonce,
          },
        },
        'TX submitted',
      );

      // C4 Case B: follow-up revoke-old TX so cap-token-cache evicts the old entry.
      await this.submitRevokeOld(ctx.oldTokenId, dedupeKey, traceId);
    } catch (err) {
      this.logger.error(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { dedupe_key: dedupeKey, err: (err as Error).message },
        },
        'executeRefresh failed — quorum collection or TX submit error',
      );
    }
  }

  /**
   * C4 Case B helper — submit `revoke_capability_token_via_quorum` for the OLD
   * token after a successful refresh. reason=4 distinguishes refresh-driven
   * revocations from slash (1) / admin (2) / turn-revoked (3) per the
   * extensible reason enum noted in D-002 + capability_events.move.
   */
  private async submitRevokeOld(
    oldTokenId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const reason = 4; // refresh-driven (extension of D-002 base enum 0/1/2)
    const canonicalMsg = buildRevokeCanonicalMsg({ capObjectId: oldTokenId, reason });

    const { qs, pubkeys } = await this.keystore.collectQuorumSignatures(
      canonicalMsg,
      this.threshold,
    );

    const result = await this.submitFn({
      label: 'revoke-capability-token-via-quorum',
      args: {
        target: `${this.packageId}::room_capability::revoke_capability_token_via_quorum`,
        networkRegistryId: this.networkRegistryId,
        cpRegistryObjectId: this.cpRegistryObjectId,
        quorumStateObjectId: this.quorumStateObjectId,
        capObjectId: oldTokenId,
        reason,
        cpQuorumProof: qs,
        signerPubkeys: pubkeys,
        canonicalMsg: Array.from(canonicalMsg),
      },
    });

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: {
          dedupe_key: dedupeKey,
          handler: 'submitRevokeOld',
          tx_digest: result.digest,
          cap_object_id: oldTokenId,
          reason,
          cross_wave: 'C4-cache-fast-path-eviction',
        },
      },
      'TX submitted',
    );
  }

  /**
   * REQ-ADM-013 test seam — synchronous nonce-replay guard. External callers
   * (e.g. a hypothetical future "force-refresh" admin RPC) supply an explicit
   * nonce; the issuer rejects any submission where nonce ≤ stored current.
   * Returns true if the nonce is acceptable (would be accepted by a real
   * refresh path) + bumps the stored counter; false if rejected.
   *
   * The leading underscore + ForTest suffix follows the existing dvconf-daemons
   * test-seam naming convention (e.g. event-handler._setStateForTest).
   */
  _attemptRefreshWithNonceForTest(
    roomId: string,
    peerHex: string,
    incomingNonce: number,
    traceId: string,
  ): boolean {
    const nonceKey = `${roomId}::${peerHex}`;
    const current = this.nonces.get(nonceKey) ?? 0;
    if (incomingNonce <= current) {
      this.logger.warn(
        {
          trace_id: traceId,
          module: 'cap-token-issuer',
          context: { reason: 'nonce-replay', incoming: incomingNonce, current, nonce_key: nonceKey },
        },
        'Nonce replay rejected — refresh skipped',
      );
      return false;
    }
    this.nonces.set(nonceKey, incomingNonce);
    return true;
  }
}
