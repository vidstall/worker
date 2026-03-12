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
import { Transaction } from '@mysten/sui/transactions';
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

/**
 * Look up a relay's StakePosition object ID given its miner ID.
 *
 * Two-step approach:
 * 1. devInspect relay_registry::borrow_info + info_operator to get the relay operator address
 * 2. Query getOwnedObjects filtered by staking::StakePosition to find the StakePosition
 *
 * @param client       - SuiClient instance
 * @param config       - Network configuration (packageId, relayRegistryId)
 * @param relayMinerId - The relay's miner object ID
 * @param logger       - Logger instance
 * @returns The StakePosition object ID, or undefined if not found
 */
export async function lookupRelayStakeId(
  client: SuiClient,
  config: NetworkConfig,
  relayMinerId: string,
  logger: Logger,
): Promise<string | undefined> {
  try {
    // Step 1: Get relay operator address via devInspect
    const tx = new Transaction();
    const info = tx.moveCall({
      target: `${config.packageId}::relay_registry::borrow_info`,
      arguments: [tx.object(config.relayRegistryId), tx.pure.id(relayMinerId)],
    });
    tx.moveCall({
      target: `${config.packageId}::relay_registry::info_operator`,
      arguments: [info],
    });

    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });

    if (!result.results?.[1]?.returnValues?.[0]) {
      logger.warn(
        { relayMinerId },
        `devInspect for relay operator returned no results -- relay=${relayMinerId}`,
      );
      return undefined;
    }

    const bytes = new Uint8Array(result.results[1].returnValues[0][0] as number[]);
    // Sui address is 32 bytes, hex-encoded with 0x prefix
    const operatorAddress =
      '0x' +
      Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    logger.debug(
      { relayMinerId, operatorAddress },
      `Relay operator resolved: relay=${relayMinerId}, operator=${operatorAddress}`,
    );

    // Step 2: Find StakePosition owned by the operator
    const owned = await client.getOwnedObjects({
      owner: operatorAddress,
      options: { showType: true },
      filter: { StructType: `${config.packageId}::staking::StakePosition` },
    });

    const stakeObj = owned.data?.[0];
    if (stakeObj?.data?.objectId) {
      logger.debug(
        { relayMinerId, operatorAddress, stakeId: stakeObj.data.objectId },
        `StakePosition found for relay=${relayMinerId}`,
      );
      return stakeObj.data.objectId;
    }

    logger.warn(
      { relayMinerId, operatorAddress },
      `No StakePosition found for relay operator=${operatorAddress}`,
    );
    return undefined;
  } catch (err) {
    logger.warn(
      { err, relayMinerId },
      `Failed to look up relay StakePosition for relay=${relayMinerId}`,
    );
    return undefined;
  }
}
