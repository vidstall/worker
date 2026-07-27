/**
 * cp-daemon event-handler case arms — validator/signaling registration + role
 * voting/assignment events (god-file split out of the former monolithic
 * `event-handler.ts`).
 *
 * Covers: ValidatorRegistered, SignalingRegistered, SignalingLoadUpdated,
 * RoomCreated, RoomAssigned, CapabilityIssued, RoleAssigned, RoleChanged,
 * MinerRegistered, RevoteEligibleMarked.
 */
import { randomUUID } from 'node:crypto';
import type { SuiEvent } from '@mysten/sui/client';
import type {
  MinerRegistered,
  RoomCreated,
  RoomAssigned,
  SignalingRegistered,
  SignalingLoadUpdated,
  ValidatorRegistered,
  RoleAssigned as RoleAssignedEvent,
  RoleChanged,
  RevoteEligibleMarked,
} from '@dvconf/shared';
import { MinerRole } from '@dvconf/shared';
import { PVR_DEFAULT_HISTORY, type NodeCandidate } from '../scoring.js';
import { clearVotedRoom, type SignalingCandidate } from '../room-assignment.js';
import { clearVotedMiner, trackUnassignedMiner, trackRevoteCandidate } from '../role-voter.js';
import type {
  RoomAssignedEvent as IssuerRoomAssigned,
  RoleChangedEvent as IssuerRoleChanged,
  RoleAssignedEvent as IssuerRoleAssigned,
} from '../cap-token/index.js';
import { decodeVectorU8ToNumbers, dispatchCapToken, type EventHandlerCtx } from '../event-handler.js';

export function handleValidatorRegistered(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as ValidatorRegistered;
  if (ctx.validatorState) {
    const candidate: NodeCandidate = {
      minerId: e.miner_id,
      rtt: 0n,
      load: 0n,
      stakeAmount: BigInt(e.stake_amount),
      heartbeatAge: 0n, // Assume fresh at registration
      region: '', // Validators don't have region in event
      historyScore: PVR_DEFAULT_HISTORY,
    };
    ctx.validatorState.set(e.miner_id, candidate);
    ctx.logger.info({ minerId: e.miner_id }, 'Validator registered');
  }
}

export function handleSignalingRegistered(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as SignalingRegistered;
  const regionBytes = decodeVectorU8ToNumbers(e.region);
  const regionStr = regionBytes ? regionBytes.map((n) => String(n)).join(',') : '';
  const candidate: SignalingCandidate = {
    minerId: e.miner_id,
    load: 0n,
    region: regionStr,
  };
  ctx.signalingState.set(e.miner_id, candidate);
  ctx.logger.info({ minerId: e.miner_id, region: regionStr }, 'Signaling node registered');
}

export function handleSignalingLoadUpdated(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as SignalingLoadUpdated;
  const existing = ctx.signalingState.get(e.miner_id);
  if (existing) {
    existing.load = BigInt(e.new_load);
    ctx.logger.info({ minerId: e.miner_id, newLoad: e.new_load }, 'Signaling load updated');
  } else {
    ctx.logger.warn({ minerId: e.miner_id }, 'SignalingLoadUpdated for unknown signaling node, ignoring');
  }
}

export function handleRoomCreated(
  event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as RoomCreated;
  // Check if escrow already arrived before this room event (race condition)
  const earlyEscrow = ctx.pendingEscrows?.get(e.room_id);
  if (earlyEscrow) {
    ctx.pendingEscrows!.delete(e.room_id);
    ctx.logger.info({ roomId: e.room_id, creator: e.creator, relayMode: e.relay_mode }, 'Room created -- escrow already pending, triggering assignment');
    // Add room to pendingRooms so the EscrowCreated handler can find it
    ctx.pendingRooms.set(e.room_id, e);
    // Re-dispatch through EscrowCreated handler by synthesizing the event
    ctx.redispatch({
      ...event,
      type: `${event.type.split('::')[0]}::economic_layer::EscrowCreated`,
      parsedJson: earlyEscrow as unknown as Record<string, unknown>,
    });
  } else {
    ctx.logger.info({ roomId: e.room_id, creator: e.creator, relayMode: e.relay_mode }, 'Room created — waiting for escrow before assignment');
    ctx.pendingRooms.set(e.room_id, e);
  }
}

export function handleRoomAssigned(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // PAIR-03: Clear voted rooms when assignment is finalized
  const e = data as unknown as RoomAssigned;
  clearVotedRoom(e.room_id);
  // Finalized by quorum (possibly without needing this CP's own vote) --
  // stop the periodic retryPendingAssignments sweep from resubmitting.
  ctx.pendingRooms.delete(e.room_id);
  ctx.pendingEscrows?.delete(e.room_id);
  ctx.logger.info(
    { roomId: e.room_id, relayIds: e.relay_ids, signalingId: e.signaling_id },
    'Room assigned — cleared from voted rooms',
  );
  // F62 M2 W-P2 (D-W9) — issue cap-tokens to every assigned peer (REQ-ADM-001).
  // Map the snake_case Move event payload to the issuer's camelCase shape.
  if (ctx.txContext?.capTokenIssuer) {
    const capTokenIssuer = ctx.txContext.capTokenIssuer;
    const traceId = randomUUID();
    const evt: IssuerRoomAssigned = {
      roomId: e.room_id,
      relayIds: e.relay_ids,
      signalingId: e.signaling_id,
      relayMode: e.relay_mode,
      verifiedScore: e.verified_score,
      consensusReached: e.consensus_reached,
      winningCp: e.winning_cp,
      validatorIds: e.validator_ids,
    };
    dispatchCapToken(
      capTokenIssuer.onRoomAssigned(evt, traceId),
      ctx.logger,
      { roomId: e.room_id, handler: 'onRoomAssigned' },
    );
  }
}

export function handleCapabilityIssued(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // Leg 7c (G3) — observe the on-chain CapabilityIssued event to feed the infra-peer
  // pubkey recovery cache (clones the RoomAssigned dispatch shape above). The cache is
  // keyed by (roomId, peerId); the event carries the real 32-byte peer_pubkey + the
  // emitting peer's miner-id (peer_id). FAIL-CLOSED-AT-INSERT: the cache itself rejects a
  // non-32-byte pubkey (never poisons recovery into a 916 mint). When the event omits a
  // peer_id (the accepted async-hazard per the locked decision) we debug-log + skip the
  // observe rather than key by a non-recovery field.
  const e = data as unknown as {
    token_id?: string;
    room_id: string;
    peer_pubkey: number[];
    role?: number;
    expires_epoch?: string;
    peer_id?: string;
  };
  if (ctx.txContext?.capTokenIssuer) {
    const traceId = randomUUID();
    if (e.peer_id) {
      ctx.txContext.capTokenIssuer.onCapabilityIssued(
        e.peer_id,
        {
          tokenId: e.token_id,
          roomId: e.room_id,
          peerPubkey: e.peer_pubkey,
          role: e.role,
          expiresEpoch: e.expires_epoch,
        },
        traceId,
      );
    } else {
      ctx.logger.debug(
        { roomId: e.room_id },
        'CapabilityIssued observed without a peer_id — infra-peer recovery cache not fed (accepted G3 async-hazard)',
      );
    }
  }
}

export function handleRoleAssigned(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // Clear voted miner from role-voter when role is assigned
  const e = data as unknown as RoleAssignedEvent;
  clearVotedMiner(e.miner_id);
  ctx.logger.info(
    { minerId: e.miner_id, role: e.role },
    'Role assigned — cleared from voted miners',
  );
  // F62 M2 W-P2 (D-W9) — vote-consensus role assignment drives the cap-token
  // refresh path (REQ-ADM-013/014, grace-timer inside the issuer).
  if (ctx.txContext?.capTokenIssuer) {
    const capTokenIssuer = ctx.txContext.capTokenIssuer;
    const traceId = randomUUID();
    const evt: IssuerRoleAssigned = {
      minerId: e.miner_id,
      role: e.role,
      voteCount: e.vote_count,
      threshold: e.threshold,
    };
    dispatchCapToken(
      capTokenIssuer.onRoleAssigned(evt, traceId),
      ctx.logger,
      { minerId: e.miner_id, handler: 'onRoleAssigned' },
    );
  }
}

export function handleRoleChanged(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // F62 M2 W-P2 (D-W8) — NEW case arm. registration::RoleChanged was emitted
  // (registration.move:51) but previously had no handler. Drives the cap-token
  // role-change refresh (REQ-ADM-013/014); the issuer schedules a cancellable
  // grace timer (a B→A revert cancels a pending A→B refresh).
  const e = data as unknown as RoleChanged;
  if (ctx.txContext?.capTokenIssuer) {
    const capTokenIssuer = ctx.txContext.capTokenIssuer;
    const traceId = randomUUID();
    const evt: IssuerRoleChanged = {
      minerId: e.miner_id,
      oldRole: e.old_role,
      newRole: e.new_role,
      newStake: e.new_stake,
    };
    dispatchCapToken(
      capTokenIssuer.onRoleChanged(evt, traceId),
      ctx.logger,
      { minerId: e.miner_id, handler: 'onRoleChanged' },
    );
  } else {
    ctx.logger.debug(
      { minerId: e.miner_id, newRole: e.new_role },
      'RoleChanged observed but no CapTokenIssuer in txContext — refresh not scheduled',
    );
  }
}

export function handleMinerRegistered(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // VOTE-05: Track unassigned miners (role=0/User) for role voting
  const e = data as unknown as MinerRegistered;
  if (e.role === MinerRole.User) {
    trackUnassignedMiner(e.miner_id);
    ctx.logger.info(
      { minerId: e.miner_id },
      'Unassigned miner registered — added to role voting queue',
    );
  }
}

export function handleRevoteEligibleMarked(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // F47 RV-010: a miner became re-vote-eligible → queue it for a re-vote.
  // Field names read here MUST match the Move struct exactly (OQ-PH16 lock).
  const e = data as unknown as RevoteEligibleMarked;
  trackRevoteCandidate(e.miner_id);
  ctx.logger.info(
    { minerId: e.miner_id, reason: e.reason, currentRole: e.current_role, markedAt: e.marked_at },
    'Re-vote eligible marked — added to re-vote queue',
  );
}
