/**
 * Periodic liveness heartbeat for ValidatorRegistry.
 *
 * Writes last_heartbeat on-chain; consumed by pairing eligibility check
 * in room_manager.move (PVR_HEARTBEAT_STALE=7 epochs).
 *
 * Validators have no `update_load` path on-chain (unlike relay/signaling),
 * so this is a single-moveCall PTB per cycle.
 *
 * IMPORTANT: must be signed by the MAIN wallet (operator/mainKeypair), not
 * the session wallet -- the on-chain assertion `info.operator == ctx.sender()`
 * (E_NOT_OPERATOR=536) requires the main wallet that owns the MinerCap.
 *
 * Uses executeWithRetry from @dvconf/shared for exponential backoff (DAEMON-07).
 *
 * Requirements: F40
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';

/**
 * Build a heartbeat moveCall on the given transaction.
 *
 * Target: validator_registry::heartbeat(net_reg, registry, cap)
 */
export function buildHeartbeatTx(
  tx: Transaction,
  config: NetworkConfig,
  minerCapId: string,
): void {
  tx.moveCall({
    target: `${config.packageId}::validator_registry::heartbeat`,
    arguments: [
      tx.object(config.networkRegistryId),       // net_reg: &NetworkRegistry
      tx.object(config.validatorRegistryId),      // registry: &mut ValidatorRegistry
      tx.object(minerCapId),                      // cap: &MinerCap
    ],
  });
}

/**
 * Start the validator heartbeat loop.
 *
 * Sends a single heartbeat moveCall PTB at the configured interval (default 30s).
 *
 * @returns A stop function that clears the interval.
 */
export function startHeartbeat(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  intervalMs: number,
  logger: Logger,
): () => void {
  logger.info({ intervalMs, minerCapId }, 'Starting validator heartbeat loop');

  const sendHeartbeat = async (): Promise<void> => {
    logger.debug({ minerCapId }, 'Sending validator heartbeat');

    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        buildHeartbeatTx(tx, config, minerCapId);
      },
      'validator-heartbeat',
      logger,
    );
  };

  // Send first heartbeat immediately
  sendHeartbeat().catch((err) => {
    logger.error({ err }, 'Initial validator heartbeat failed');
  });

  const handle = setInterval(() => {
    sendHeartbeat().catch((err) => {
      logger.error({ err }, 'Validator heartbeat interval failed');
    });
  }, intervalMs);

  return () => {
    clearInterval(handle);
    logger.info('Validator heartbeat loop stopped');
  };
}
