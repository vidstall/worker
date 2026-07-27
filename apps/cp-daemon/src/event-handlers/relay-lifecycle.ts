/**
 * cp-daemon event-handler case arms — relay lifecycle events (god-file split
 * out of the former monolithic `event-handler.ts`).
 *
 * Covers: RelayRegistered, RelayLoadUpdated, RelayRTTUpdated, RelayHeartbeat,
 * RelaySlashed, SecretRotated.
 */
import type { SuiEvent } from '@mysten/sui/client';
import type {
  RelayRegistered,
  RelayLoadUpdated,
  RelayRTTUpdated,
  RelaySlashed,
  SecretRotated,
} from '@dvconf/shared';
import { PVR_DEFAULT_HISTORY, type NodeCandidate } from '../scoring.js';
import type { CapTokenIssuer, RelaySlashedEvent as IssuerRelaySlashed } from '../cap-token/index.js';
import { randomUUID } from 'node:crypto';
import { decodeVectorU8ToNumbers, dispatchCapToken, type EventHandlerCtx } from '../event-handler.js';

export function handleRelayRegistered(
  event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as RelayRegistered;
  const regionBytes = decodeVectorU8ToNumbers(e.region);
  const regionStr = regionBytes ? regionBytes.map((n) => String(n)).join(',') : '';
  const candidate: NodeCandidate = {
    minerId: e.miner_id,
    rtt: 0n, // Unknown until validator probes
    load: 0n, // No load at registration
    stakeAmount: BigInt(e.stake_amount),
    heartbeatAge: 0n, // Assume fresh at registration
    region: regionStr,
    historyScore: PVR_DEFAULT_HISTORY,
  };
  ctx.relayState.set(e.miner_id, candidate);
  ctx.logger.info({ minerId: e.miner_id, region: regionStr }, 'Relay registered');

  // Re-attempt assignment for rooms deferred due to missing relays
  if (ctx.pendingEscrows && ctx.pendingEscrows.size > 0) {
    for (const [roomId, escrow] of ctx.pendingEscrows) {
      if (ctx.pendingRooms.has(roomId)) {
        ctx.logger.info({ roomId }, 'New relay registered — retrying deferred assignment');
        ctx.pendingEscrows.delete(roomId);
        ctx.redispatch({
          ...event,
          type: `${event.type.split('::')[0]}::economic_layer::EscrowCreated`,
          parsedJson: escrow as unknown as Record<string, unknown>,
        });
      }
    }
  }
}

export function handleRelayLoadUpdated(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as RelayLoadUpdated;
  const existing = ctx.relayState.get(e.miner_id);
  if (existing) {
    existing.load = BigInt(e.new_load);
    ctx.logger.info({ minerId: e.miner_id, newLoad: e.new_load }, 'Relay load updated');
  } else {
    ctx.logger.warn({ minerId: e.miner_id }, 'RelayLoadUpdated for unknown relay, ignoring');
  }
}

export function handleRelayRTTUpdated(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  const e = data as unknown as RelayRTTUpdated;
  const existing = ctx.relayState.get(e.miner_id);
  if (existing) {
    existing.rtt = BigInt(e.rtt);
    ctx.logger.info({ minerId: e.miner_id, rtt: e.rtt }, 'Relay RTT updated');
  } else {
    ctx.logger.warn({ minerId: e.miner_id }, 'RelayRTTUpdated for unknown relay, ignoring');
  }
}

export function handleRelayHeartbeat(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // REQ-RMS-019 — refresh candidate.heartbeatAge (was stuck at 0n; no arm existed).
  const e = data as unknown as { miner_id: string; epoch: string };
  const existing = ctx.relayState.get(e.miner_id);
  if (existing) {
    const hbEpoch = BigInt(e.epoch);
    const now = ctx.currentEpoch ?? hbEpoch; // in tests with no chain epoch, treat the heartbeat as fresh
    existing.heartbeatAge = now > hbEpoch ? now - hbEpoch : 0n;
    ctx.logger.info({ minerId: e.miner_id, epoch: e.epoch, heartbeatAge: existing.heartbeatAge.toString() }, 'Relay heartbeat — age refreshed');
  } else {
    ctx.logger.warn({ minerId: e.miner_id }, 'RelayHeartbeat for unknown relay, ignoring');
  }
}

export function handleRelaySlashed(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // ADR-0005 § Mid-room kill-switch — forward to TURN issuer so it stops
  // issuing fresh credentials for this miner. Existing credentials remain
  // technically valid against the slashed coturn until TTL expiry, but
  // no compliant client will use them.
  const e = data as unknown as RelaySlashed;
  if (ctx.txContext?.turnIssuer) {
    ctx.txContext.turnIssuer.markSlashed(e.relay_miner_id);
    ctx.logger.info(
      { relayMinerId: e.relay_miner_id, roomId: e.room_id, slashAmount: e.slash_amount },
      'Relay slashed — TURN issuer kill-switch armed for this miner',
    );
  } else {
    ctx.logger.warn(
      { relayMinerId: e.relay_miner_id },
      'RelaySlashed observed but no TurnIssuer in txContext — kill-switch not armed',
    );
  }
  // F62 M2 W-P2 (D-W8) — ADDITIVE cap-token revoke on slash, orthogonal to the
  // TURN kill-switch above. The issuer revokes the slashed relay's RoomCapability
  // (REQ-ADM via revoke_capability_token_via_quorum); the cache evicts on the
  // resulting CapabilityRevoked chain event.
  if (ctx.txContext?.capTokenIssuer) {
    const capTokenIssuer: CapTokenIssuer = ctx.txContext.capTokenIssuer;
    const traceId = randomUUID();
    const evt: IssuerRelaySlashed = {
      roomId: e.room_id,
      relayMinerId: e.relay_miner_id,
      slashAmount: e.slash_amount,
    };
    dispatchCapToken(
      capTokenIssuer.onRelaySlashed(evt, traceId),
      ctx.logger,
      { roomId: e.room_id, relayMinerId: e.relay_miner_id, handler: 'onRelaySlashed' },
    );
  }
}

export function handleSecretRotated(
  _event: SuiEvent,
  data: Record<string, unknown>,
  ctx: EventHandlerCtx,
): void {
  // F8 (REQ-CRR-005) — emergency relay-secret rotation kill-switch. Mirrors
  // the RelaySlashed → markSlashed precedent above: forward the LEAKED
  // `old_secret_id` to the TURN issuer so it stops serving/reusing the
  // compromised secret immediately, deliberately overriding the 2-secret
  // overlap grace. The on-chain SecretRotated event is the audit anchor;
  // coturn-side eviction + multi-CP coordination stay deferred (turn-issuer
  // scope boundary). Orthogonal to RoomCapability admission tokens (D-009):
  // this is a TURN shared-secret rotation, not a cap-token revoke.
  const e = data as unknown as SecretRotated;
  if (ctx.txContext?.turnIssuer) {
    const secretId = Number(e.old_secret_id);
    const evicted = ctx.txContext.turnIssuer.emergencyEvictSecret(secretId, e.reason);
    ctx.logger.warn(
      {
        cpMinerId: e.cp_miner_id,
        oldSecretId: e.old_secret_id,
        newSecretId: e.new_secret_id,
        reason: e.reason,
        evicted,
      },
      'SecretRotated — TURN issuer emergency kill-switch (F8)',
    );
  } else {
    ctx.logger.warn(
      { oldSecretId: e.old_secret_id },
      'SecretRotated observed but no TurnIssuer in txContext — emergency evict not armed',
    );
  }
}
