/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer (cp-daemon module).
 *
 * Issues + revokes RoomCapability tokens in response to chain events:
 *   - room_manager::RoomAssigned   → issue tokens to each peer in the room
 *   - miner::registration::RoleChanged → trigger refresh (Phase 3.4 grace timer; here stub-stage)
 *   - role_voting::RoleAssigned    → trigger refresh on vote consensus
 *   - economic_layer::RelaySlashed → bulk-revoke tokens for the slashed relay
 *   - F8 stub SecretRotated         → log WARN (no TX until F8 ships)
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
 */
import type { Logger, QuorumSig } from '@dvconf/shared';

// ── Submit DI ────────────────────────────────────────────────────────────

export interface SubmitResult {
  digest: string;
}

export interface SubmitFn {
  (opts: { label: string; args: Record<string, unknown> }): Promise<SubmitResult>;
}

// ── Keystore abstraction ─────────────────────────────────────────────────

export interface CpKeystore {
  /** Sign an arbitrary canonical message with the local CP key. */
  sign(message: Uint8Array): Promise<{ signature: number[]; pubkey: number[]; addr: string }>;
  /** Local CP's Sui operator address. */
  getCpAddress(): string;
  /**
   * Collect at least `threshold` signatures over `canonicalMsg` from peer CP nodes
   * (M-of-N quorum, REQ-ADM-003, D-B4 default M=2/N=3). Throws if quorum cannot be
   * assembled within the implementation-defined timeout — caller treats the throw as
   * "issuance temporarily unavailable" and logs an error.
   */
  collectQuorumSignatures(
    canonicalMsg: Uint8Array,
    threshold: number,
  ): Promise<{ qs: QuorumSig; pubkeys: number[][] }>;
}

// ── Event payload shapes (real Move struct names per D-010-A / CONTRACTS § 4.6) ──

export interface RoomAssignedEvent {
  roomId: string;
  relayIds: string[];
  signalingId: string;
  relayMode: number;
  verifiedScore: string;
  consensusReached: boolean;
  winningCp: string;
  validatorIds: string[];
}

export interface RoleChangedEvent {
  minerId: string;
  oldRole: number;
  newRole: number;
  newStake: string;
}

export interface RoleAssignedEvent {
  minerId: string;
  role: number;
  voteCount: string;
  threshold: string;
}

export interface RelaySlashedEvent {
  roomId: string;
  relayMinerId: string;
  slashAmount: string;
}

export interface SecretRotatedEvent {
  rotationId: string;
  newKeyEpoch: string;
}

// ── Options + class ──────────────────────────────────────────────────────

export interface CapTokenIssuerOpts {
  submitFn: SubmitFn;
  packageId: string;
  networkRegistryId: string;
  cpRegistryObjectId: string;
  quorumStateObjectId: string;
  cpKeystore: CpKeystore;
  logger: Logger;
  /** M-of-N threshold (D-B4 default M=2). */
  quorumThreshold?: number;
}

/**
 * Default expiry window for fresh tokens — Sui epoch-units. Picked above
 * MIN_REMAINING_EPOCHS=5 (per D-007-A precedent) with comfortable headroom
 * so the late-join window in `verify_capability_token` is not crossed.
 */
const DEFAULT_EXPIRES_OFFSET_EPOCHS = 100n;

/** Encode a UTF-8 string into a Uint8Array. Used to build the canonical signing message. */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/**
 * Build the canonical issuance payload that CP-quorum signs off-chain. Shape derived
 * from SEQUENCES § 1: BCS({room_id, peer_pubkey, role, expires_epoch, nonce}). Encoded
 * here as a deterministic delimited byte string — a real BCS encoder would replace this
 * in production, but every signer must produce the same bytes for verify_quorum to pass.
 */
function buildIssueCanonicalMsg(opts: {
  roomId: string;
  peerId: string;
  role: number;
  expiresEpoch: bigint;
  nonce: number;
}): Uint8Array {
  return utf8(
    `issue|${opts.roomId}|${opts.peerId}|${opts.role}|${opts.expiresEpoch.toString()}|${opts.nonce}`,
  );
}

/** Canonical revoke payload: BCS({cap_object_id, reason}). */
function buildRevokeCanonicalMsg(opts: { capObjectId: string; reason: number }): Uint8Array {
  return utf8(`revoke|${opts.capObjectId}|${opts.reason}`);
}

/**
 * Map a relay/signaling/validator address to its Move role enum value used by
 * room_capability.move (matches MinerRole constants in dvconf-contracts).
 *   1 = validator, 2 = relay, 3 = CP, 4 = signaling, 0 = user/default
 */
function roleForPeerKind(kind: 'relay' | 'signaling' | 'validator'): number {
  switch (kind) {
    case 'relay':
      return 2;
    case 'signaling':
      return 4;
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
  /** Idempotency: per-handler dedupe key → seen-flag. Reset only on daemon restart. */
  private readonly seenKeys = new Set<string>();

  constructor(opts: CapTokenIssuerOpts) {
    this.submitFn = opts.submitFn;
    this.packageId = opts.packageId;
    this.networkRegistryId = opts.networkRegistryId;
    this.cpRegistryObjectId = opts.cpRegistryObjectId;
    this.quorumStateObjectId = opts.quorumStateObjectId;
    this.keystore = opts.cpKeystore;
    this.logger = opts.logger;
    this.threshold = opts.quorumThreshold ?? 2;
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
        { id: event.signalingId, role: roleForPeerKind('signaling') },
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
   * REQ-ADM-013 (partial) — role-change refresh trigger.
   * Phase 3.1 scope: dedupe + log only; Phase 3.4 dev extends with 60s grace timer +
   * call to `refresh_capability_token` Move entry (CONTRACTS § 4.1, available via
   * cp-quorum-sig.contract.ts since lane-a2 ship).
   */
  async onRoleChanged(event: RoleChangedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoleChanged received',
    );

    const dedupeKey = `${event.minerId}::${event.newRole}::role-change`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoleChanged')) return;

    // Phase 3.1: no TX yet — Phase 3.4 will wire the 60s grace timer + refresh call.
    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: { dedupe_key: dedupeKey, miner_id: event.minerId, new_role: event.newRole },
      },
      'RoleChanged tracked — refresh scheduling deferred to Phase 3.4',
    );
  }

  /**
   * REQ-ADM-013 (partial) — vote consensus on role assignment.
   * Phase 3.1 scope: dedupe + log only; Phase 3.4 extends with refresh-on-active-token.
   */
  async onRoleAssigned(event: RoleAssignedEvent, traceId: string): Promise<void> {
    this.logger.info(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'RoleAssigned received',
    );

    const dedupeKey = `${event.minerId}::${event.role}::role-assigned`;
    if (this.markSeenOrSkip(dedupeKey, traceId, 'onRoleAssigned')) return;

    this.logger.info(
      {
        trace_id: traceId,
        module: 'cap-token-issuer',
        context: { dedupe_key: dedupeKey, miner_id: event.minerId, role: event.role },
      },
      'RoleAssigned tracked — refresh-or-new decision deferred to Phase 3.4',
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

  /**
   * F8 stub — no real Move event yet. Phase 3.4 dev fills in real refresh-all loop
   * once F8 secret rotation event is brainstormed. Phase 3.1 logs a WARN so operators
   * see the no-op explicitly during integration testing.
   */
  async onSecretRotated(event: SecretRotatedEvent, traceId: string): Promise<void> {
    this.logger.warn(
      { trace_id: traceId, module: 'cap-token-issuer', context: { event } },
      'SecretRotated stub — F8 not yet shipped',
    );
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
    peer: { id: string; role: number },
    roomId: string,
    dedupeKey: string,
    traceId: string,
  ): Promise<void> {
    const nonce = 1; // first issuance per (room, peer) — monotonic counter per D-010-B starts at 1
    const expiresEpoch = DEFAULT_EXPIRES_OFFSET_EPOCHS; // daemon does not know current epoch here; placeholder
    const canonicalMsg = buildIssueCanonicalMsg({
      roomId,
      peerId: peer.id,
      role: peer.role,
      expiresEpoch,
      nonce,
    });

    const { qs, pubkeys } = await this.keystore.collectQuorumSignatures(
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
        role: peer.role,
        expiresEpoch,
        nonce,
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
}
