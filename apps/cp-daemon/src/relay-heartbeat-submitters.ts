/**
 * Relay heartbeat watcher — live submitter/candidate-selector factories wired
 * in cp-daemon index.ts / cp-watchers-wiring.ts.
 *
 * Pure extraction from relay-heartbeat-watcher.ts. See that file's module doc
 * for the M1 Phase 3.1 (REQ-RO-009) background.
 */

import type { Logger } from '@dvconf/shared';
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig } from '@dvconf/shared';
import { selectReplacementCandidate, type RelayCapacity } from './admission-capacity.js';
import type {
  RelayChainStateReader,
  PromoteSubmitter,
  ReplacementSubmitter,
  ReplacementCandidateSelector,
} from './relay-heartbeat-watcher.js';

const MODULE = 'relay-heartbeat-watcher';

/**
 * Build a real {@link ReplacementCandidateSelector} from a reader exposing
 * `getActiveRelayIds()`. Candidate pool = every currently-active relay minus whatever's
 * already assigned to the room; no live capacity/RTT feed is wired at this call site
 * (a vote-in decision, unlike bootstrap placement), so every candidate is treated as
 * uniformly eligible -- `selectReplacementCandidate`'s capacity/health gates still apply
 * defensively (e.g. a canary-flagged relay is skipped) if the reader is later extended to
 * populate those fields.
 */
export function makeLiveReplacementCandidateSelector(
  reader: Pick<RelayChainStateReader, 'getActiveRelayIds'>,
): ReplacementCandidateSelector {
  return async (_roomId, assignedRelayIds) => {
    const activeIds = (await reader.getActiveRelayIds?.()) ?? [];
    const capacities: RelayCapacity[] = activeIds.map((minerId) => ({
      minerId,
      attestedLoadPaths: 0,
      cWorker: Number.POSITIVE_INFINITY,
      rtt: 0n,
    }));
    const chosen = selectReplacementCandidate(capacities, assignedRelayIds, 0);
    return chosen?.minerId ?? null;
  };
}

/**
 * Build a real {@link PromoteSubmitter} that signs + submits `promote_relay`
 * PTBs via `executeWithRetry`. Arg order matches D-RO-1 decision:
 *   promote_relay(net_reg, manager, relay_reg, room_id, new_primary, ctx)
 *
 * NOTE: room_id and new_primary are passed as pure IDs; old_primary is
 * included in the trace log but NOT as a PTB arg (the on-chain entry
 * derives it from `assigned_relays[0]`).
 */
export function makePromoteSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): PromoteSubmitter {
  return async (roomId, oldPrimary, newPrimary, traceId) => {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          // promote_relay is defined in the room_manager_failover satellite
          // module (failover.move), not room_manager itself.
          target: `${config.packageId}::room_manager_failover::promote_relay`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.roomManagerId),      // manager: &mut RoomManager
            tx.object(config.relayRegistryId),    // relay_reg: &RelayRegistry
            tx.pure.id(roomId),                   // room_id: ID
            tx.pure.id(newPrimary),               // new_primary: ID
          ],
        });
      },
      'promote-relay',
      logger,
    );
    logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'promote_confirmed',
        context: { roomId, oldPrimary, newPrimary },
      },
      'Relay heartbeat watcher: promote_relay confirmed on-chain',
    );
  };
}

/**
 * Build a real {@link ReplacementSubmitter} that signs + submits
 * `propose_relay_replacement` PTBs (relay_replacement.move) via `executeWithRetry`.
 * CP-cap-gated: requires this daemon's own registered `cpCapId`. `submittedScore` is a
 * fixed placeholder (this vote only decides WHO replaces the dead standby, not room
 * scoring) — mirrors the fixed score used by other post-bootstrap CP-quorum votes.
 */
export function makeReplacementSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  logger: Logger,
): ReplacementSubmitter {
  return async (roomId, deadRelayId, candidateRelayId, traceId) => {
    const alertBoxId = config.roomHealthAlertBoxId;
    if (!alertBoxId) {
      logger.warn(
        { trace_id: traceId, module: MODULE, context: { roomId } },
        'Relay heartbeat watcher: roomHealthAlertBoxId not configured — cannot submit propose_relay_replacement',
      );
      return;
    }
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager_relay_replacement::propose_relay_replacement`,
          arguments: [
            tx.object(config.networkRegistryId),  // net_reg: &NetworkRegistry
            tx.object(config.roomManagerId),      // manager: &mut RoomManager
            tx.object(config.cpRegistryId),       // cp_reg: &mut ControlPlaneRegistry
            tx.object(config.relayRegistryId),    // relay_reg: &mut RelayRegistry
            tx.object(alertBoxId),                // alert_box: &mut RoomHealthAlertBox
            tx.object(cpCapId),                   // cap: &ControlPlaneCap
            tx.pure.id(roomId),                   // room_id: ID
            tx.pure.id(deadRelayId),               // dead_relay_id: ID
            tx.pure.id(candidateRelayId),          // candidate_relay_id: ID
            tx.pure.u64(0),                        // submitted_score: u64 (placeholder, not room-scoring)
          ],
        });
      },
      'propose-relay-replacement',
      logger,
    );
    logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'replacement_confirmed',
        context: { roomId, deadRelayId, candidateRelayId },
      },
      'Relay heartbeat watcher: propose_relay_replacement confirmed on-chain',
    );
  };
}
