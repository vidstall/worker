/**
 * Reward distribution trigger for the Validator daemon.
 *
 * After a room closes and sufficient session proofs have been submitted,
 * the validator triggers on-chain reward distribution via
 * economic_layer::distribute_rewards.
 *
 * All numeric values use bigint (basis-point invariant).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import {
  executeWithRetry,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';

/** Polling interval when waiting for proofs (ms). */
const PROOF_POLL_INTERVAL_MS = 5_000;

/**
 * Poll the escrow object on-chain until the proof count reaches minProofs or timeout.
 *
 * Reads the escrow object's `proofs` vector and checks its length.
 *
 * @param client     - SuiClient instance
 * @param escrowId   - RoomEscrow object ID
 * @param minProofs  - Minimum number of proofs required
 * @param timeoutMs  - Maximum wait time in ms
 * @param logger     - Logger instance
 * @returns true if minProofs reached, false if timed out
 */
export async function waitForProofs(
  client: SuiClient,
  escrowId: string,
  minProofs: number,
  timeoutMs: number,
  logger: Logger,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const obj = await client.getObject({
        id: escrowId,
        options: { showContent: true },
      });

      if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
        logger.warn({ escrowId }, 'Escrow object not found or not a MoveObject');
        return false;
      }

      const fields = obj.data.content.fields as Record<string, unknown>;
      const proofs = fields['proofs'] as unknown[];
      const proofCount = Array.isArray(proofs) ? proofs.length : 0;

      logger.debug(
        { escrowId, proofCount, minProofs },
        `Proof count check: ${proofCount}/${minProofs}`,
      );

      if (proofCount >= minProofs) {
        logger.info(
          { escrowId, proofCount, minProofs },
          `Sufficient proofs collected: ${proofCount} >= ${minProofs}`,
        );
        return true;
      }
    } catch (err) {
      logger.warn({ err, escrowId }, 'Failed to poll escrow proof count');
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, PROOF_POLL_INTERVAL_MS));
  }

  logger.warn(
    { escrowId, timeoutMs },
    `Timed out waiting for proofs on escrow=${escrowId}`,
  );
  return false;
}

/**
 * Trigger on-chain reward distribution for a closed room.
 *
 * Calls economic_layer::distribute_rewards with the correct shared objects.
 *
 * @param client        - SuiClient instance
 * @param signer        - Keypair to sign the TX (main wallet)
 * @param config        - Network configuration with shared object IDs
 * @param escrowId      - RoomEscrow object ID
 * @param roomId        - Room ID (for logging)
 * @param relayStakeId  - Relay's StakePosition object ID
 * @param logger        - Logger instance
 * @returns true if distribution succeeded, false otherwise
 */
export async function triggerDistribution(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  escrowId: string,
  roomId: string,
  relayStakeId: string,
  logger: Logger,
): Promise<boolean> {
  logger.info(
    { roomId, escrowId, relayStakeId },
    `Triggering reward distribution for room=${roomId}`,
  );

  const result = await executeWithRetry(
    client,
    signer,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::economic_layer::distribute_rewards`,
        arguments: [
          tx.object(config.networkRegistryId),    // &NetworkRegistry
          tx.object(escrowId),                     // &mut RoomEscrow
          tx.object(config.roomManagerId),          // &RoomManager
          tx.object(config.relayRegistryId),        // &mut RelayRegistry
          tx.object(config.validatorRegistryId),    // &mut ValidatorRegistry
          tx.object(relayStakeId),                  // &mut StakePosition
        ],
      });
    },
    'distribute-rewards',
    logger,
  );

  if (result) {
    logger.info(
      { digest: result.digest, roomId, escrowId },
      `Reward distribution succeeded for room=${roomId}, digest=${result.digest}`,
    );
    return true;
  }

  logger.error(
    { roomId, escrowId },
    `Reward distribution failed for room=${roomId}`,
  );
  return false;
}
