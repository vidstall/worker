/**
 * Room assignment — submits assign_relay_and_signaling TX on-chain.
 *
 * Picks the top-scored relay (from scoring.ts) and a signaling node,
 * then calls room_manager::assign_relay_and_signaling via executeWithRetry.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';

/** Minimal signaling node state tracked from events. */
export interface SignalingCandidate {
  minerId: string;
  load: bigint;
  region: string;
}

/**
 * Score signaling nodes for a room.
 *
 * Simple approach: pick the signaling node with the lowest load.
 * Returns the miner_id of the best candidate, or undefined if none available.
 */
export function pickSignalingNode(
  signalingState: Map<string, SignalingCandidate>,
): string | undefined {
  let best: SignalingCandidate | undefined;

  for (const candidate of signalingState.values()) {
    if (!best || candidate.load < best.load) {
      best = candidate;
    }
  }

  return best?.minerId;
}

/**
 * Submit assign_relay_and_signaling TX on-chain.
 */
export async function assignRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  roomId: string,
  relayMinerId: string,
  signalingMinerId: string,
  logger: Logger,
): Promise<void> {
  await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::assign_relay_and_signaling`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(cpCapId),
          tx.pure.id(roomId),
          tx.pure.id(relayMinerId),
          tx.pure.id(signalingMinerId),
        ],
      });
    },
    'assign-room',
    logger,
  );
}
