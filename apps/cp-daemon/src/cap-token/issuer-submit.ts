/**
 * F62 M1 Stage 3 / Phase 3.1 — cap-token-issuer TX-submit helpers.
 *
 * Pure extraction from issuer.ts: submitIssue/submitRevoke/submitRevokeOld as
 * free functions over an explicit `IssuerSubmitCtx`, so they stay unit-
 * testable independent of the CapTokenIssuer class's private-field surface.
 * CapTokenIssuer's methods build the ctx object (referencing its own fields
 * by value/reference) and delegate here — no logic change.
 */
import type { Logger } from '@dvconf/shared';
import type { SubmitFn, CpKeystore } from './types.js';
import {
  resolvePeerPubkey,
  buildIssueCanonicalMsg,
  buildRevokeCanonicalMsg,
} from './canonical-messages.js';
import { recoverInfraPeerClaim, type InfraPeerPubkeyCache } from './infra-peer-recovery.js';

export interface IssuerSubmitCtx {
  submitFn: SubmitFn;
  packageId: string;
  networkRegistryId: string;
  cpRegistryObjectId: string;
  quorumStateObjectId: string;
  keystore: CpKeystore;
  logger: Logger;
  threshold: number;
  /** Leg 7c (G3) — optional infra-peer pubkey recovery cache (multi-CP infra path). */
  infraPeerCache?: InfraPeerPubkeyCache;
  /** W-P2 (D-W7) — resolve a fresh token's expiry epoch (live epoch + offset, lazily read). */
  resolveExpiresEpoch: () => bigint;
}

/**
 * Build canonical message, collect M-of-N signatures, submit issue TX.
 * On collectQuorumSignatures throw: re-throw to caller which logs + absorbs.
 */
export async function submitIssue(
  ctx: IssuerSubmitCtx,
  peer: { id: string; role: number; sessionPubkeyB64?: string },
  roomId: string,
  dedupeKey: string,
  traceId: string,
): Promise<void> {
  const nonce = 1; // first issuance per (room, peer) — monotonic counter per D-010-B starts at 1
  const expiresEpoch = ctx.resolveExpiresEpoch(); // W-P2 D-W7: live epoch + offset (was 100n placeholder)
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
  if (peer.sessionPubkeyB64 === undefined && ctx.infraPeerCache) {
    const recovered = recoverInfraPeerClaim(
      { roomId, peerId: peer.id, role: peer.role, expiresEpoch, nonce },
      ctx.infraPeerCache,
    );
    if (recovered === null) {
      // FAIL-CLOSED SKIP: no cached CapabilityIssued for (room, peer) yet (or a non-32-byte
      // value). Skip this infra peer's mint rather than risk a 916 abort. Visible via debug.
      ctx.logger.debug(
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

  const { qs, pubkeys, aggregateSig } = await ctx.keystore.collectQuorumSignatures(
    canonicalMsg,
    ctx.threshold,
  );

  const result = await ctx.submitFn({
    label: 'issue-capability-token',
    args: {
      target: `${ctx.packageId}::room_capability::issue_capability_token`,
      networkRegistryId: ctx.networkRegistryId,
      cpRegistryObjectId: ctx.cpRegistryObjectId,
      quorumStateObjectId: ctx.quorumStateObjectId,
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

  ctx.logger.info(
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
export async function submitRevoke(
  ctx: IssuerSubmitCtx,
  capObjectId: string,
  dedupeKey: string,
  traceId: string,
): Promise<void> {
  const reason = 1; // 1 = slash per capability_events.move encoding (D-002)
  const canonicalMsg = buildRevokeCanonicalMsg({ capObjectId, reason });

  const { qs, pubkeys } = await ctx.keystore.collectQuorumSignatures(
    canonicalMsg,
    ctx.threshold,
  );

  const result = await ctx.submitFn({
    label: 'revoke-capability-token-via-quorum',
    args: {
      target: `${ctx.packageId}::room_capability::revoke_capability_token_via_quorum`,
      networkRegistryId: ctx.networkRegistryId,
      cpRegistryObjectId: ctx.cpRegistryObjectId,
      quorumStateObjectId: ctx.quorumStateObjectId,
      capObjectId,
      reason,
      cpQuorumProof: qs,
      signerPubkeys: pubkeys,
      canonicalMsg: Array.from(canonicalMsg),
    },
  });

  ctx.logger.info(
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

/**
 * C4 Case B helper — submit `revoke_capability_token_via_quorum` for the OLD
 * token after a successful refresh. reason=4 distinguishes refresh-driven
 * revocations from slash (1) / admin (2) / turn-revoked (3) per the
 * extensible reason enum noted in D-002 + capability_events.move.
 */
export async function submitRevokeOld(
  ctx: IssuerSubmitCtx,
  oldTokenId: string,
  dedupeKey: string,
  traceId: string,
): Promise<void> {
  const reason = 4; // refresh-driven (extension of D-002 base enum 0/1/2)
  const canonicalMsg = buildRevokeCanonicalMsg({ capObjectId: oldTokenId, reason });

  const { qs, pubkeys } = await ctx.keystore.collectQuorumSignatures(
    canonicalMsg,
    ctx.threshold,
  );

  const result = await ctx.submitFn({
    label: 'revoke-capability-token-via-quorum',
    args: {
      target: `${ctx.packageId}::room_capability::revoke_capability_token_via_quorum`,
      networkRegistryId: ctx.networkRegistryId,
      cpRegistryObjectId: ctx.cpRegistryObjectId,
      quorumStateObjectId: ctx.quorumStateObjectId,
      capObjectId: oldTokenId,
      reason,
      cpQuorumProof: qs,
      signerPubkeys: pubkeys,
      canonicalMsg: Array.from(canonicalMsg),
    },
  });

  ctx.logger.info(
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
