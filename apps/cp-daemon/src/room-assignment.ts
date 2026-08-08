/**
 * Room assignment — submits pairing proposals via submit_pairing_proposal TX.
 *
 * Replaces the old assign_relay_and_signaling bypass with the proper multi-CP
 * voting flow. CPs submit proposals; on-chain 2/3 threshold triggers assignment.
 * `submit_pairing_proposal` is relay-only -- the standalone signaling node
 * type (and its registry-liveness gate) was removed from the contract.
 *
 * Implements PAIR-01, PAIR-03.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';

/**
 * Track rooms we have already voted on to prevent duplicate proposals (PAIR-03).
 */
export const votedRooms: Set<string> = new Set();

/**
 * Clear a room from the voted set (called when RoomAssigned event is received).
 */
export function clearVotedRoom(roomId: string): void {
  votedRooms.delete(roomId);
}

/**
 * Submit a pairing proposal TX on-chain (PAIR-01).
 *
 * Replaces the old assign_relay_and_signaling bypass with the proper
 * multi-CP consensus flow via submit_pairing_proposal (relay-only).
 */
export async function submitProposal(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  roomId: string,
  relayMinerIds: string[],
  validatorMinerIds: string[],
  submittedScore: bigint,
  logger: Logger,
  healthValidatorMinerIds: string[],
): Promise<boolean> {
  // PAIR-03: Skip rooms already voted on
  if (votedRooms.has(roomId)) {
    logger.debug({ roomId }, 'Already submitted proposal for this room, skipping');
    return true;
  }

  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      // Build vector<ID> arguments
      const relayVec = tx.pure.vector('id', relayMinerIds);
      const validatorVec = tx.pure.vector('id', validatorMinerIds);
      const healthValidatorVec = tx.pure.vector('id', healthValidatorMinerIds);

      tx.moveCall({
        // submit_pairing_proposal is DEFINED in the room_manager_pairing satellite
        // module (pairing.move), not room_manager itself -- same LOC-budget-split
        // pattern as room_manager_events (see chain/events.ts). Confirmed live:
        // targeting room_manager::submit_pairing_proposal 400'd with "Function not
        // found" on devnet.
        target: `${config.packageId}::room_manager_pairing::submit_pairing_proposal`,
        arguments: [
          tx.object(config.networkRegistryId),      // &NetworkRegistry
          tx.object(config.roomManagerId),           // &mut RoomManager
          tx.object(config.cpRegistryId),            // &mut ControlPlaneRegistry
          tx.object(config.relayRegistryId),         // &RelayRegistry
          tx.object(config.validatorRegistryId),     // &ValidatorRegistry
          tx.object(cpCapId),                        // &ControlPlaneCap
          tx.pure.id(roomId),                        // room_id: ID
          relayVec,                                   // relay_ids: vector<ID>
          validatorVec,                               // validator_ids: vector<ID>
          tx.pure.u64(Number(submittedScore)),          // submitted_score: u64
          healthValidatorVec,                          // health_validator_ids: vector<ID>
        ],
      });
    },
    'submit-pairing-proposal',
    logger,
  );

  // Track as voted only on genuine on-chain success -- executeWithRetry
  // returns null (not a throw) once it exhausts retries, so this used to be
  // marked "voted" even on failure, permanently blocking any future retry
  // for that room (PAIR-03's dedup check above would short-circuit forever).
  if (!result) {
    return false;
  }
  votedRooms.add(roomId);
  return true;
}

/**
 * REQ-RMS-009 — submit the authorize_spill_relay TX (CP-quorum-gated append).
 *
 * Mirrors submitProposal's PTB shape: ControlPlaneCap signer, tx.pure.id args.
 * Called when a relay's spill request (REQ-RMS-006, off-chain) is approved by the
 * CP. Appends `spillRelayMinerId` to the room's on-chain assigned_relays so the
 * cascade peer is authorized (a relay cannot self-co-opt — §4.4).
 */
export async function submitSpillAuthorization(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  roomId: string,
  spillRelayMinerId: string,
  logger: Logger,
): Promise<void> {
  await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        // authorize_spill_relay is defined in the room_manager_reassignment
        // satellite module (reassignment.move), not room_manager itself.
        target: `${config.packageId}::room_manager_reassignment::authorize_spill_relay`,
        arguments: [
          tx.object(config.networkRegistryId), // &NetworkRegistry
          tx.object(config.roomManagerId),      // &mut RoomManager
          tx.object(config.cpRegistryId),       // &ControlPlaneRegistry
          tx.object(config.relayRegistryId),    // &RelayRegistry
          tx.object(cpCapId),                   // &ControlPlaneCap
          tx.pure.id(roomId),                   // room_id: ID
          tx.pure.id(spillRelayMinerId),        // spill_relay: ID
        ],
      });
    },
    'authorize-spill-relay',
    logger,
  );
}
