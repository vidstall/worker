/**
 * Periodic heartbeat submission to ControlPlaneRegistry.
 *
 * Uses executeWithRetry from @dvconf/shared for exponential backoff (DAEMON-07).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';

/**
 * Build a heartbeat transaction.
 *
 * Adds a moveCall to `control_plane_registry::heartbeat` with the required arguments.
 */
export function buildHeartbeatTx(
  tx: Transaction,
  config: NetworkConfig,
  cpCapId: string,
): void {
  tx.moveCall({
    target: `${config.packageId}::control_plane_registry::heartbeat`,
    arguments: [
      tx.object(config.networkRegistryId),
      tx.object(config.cpRegistryId),
      tx.object(cpCapId),
    ],
  });
}

/**
 * Start the heartbeat loop. Sends a heartbeat at the configured interval.
 *
 * @returns A stop function that clears the interval.
 */
export function startHeartbeat(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  intervalMs: number,
  logger: Logger,
): () => void {
  logger.info({ intervalMs, cpCapId }, 'Starting heartbeat loop');

  const sendHeartbeat = async (): Promise<void> => {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => buildHeartbeatTx(tx, config, cpCapId),
      'heartbeat',
      logger,
    );
  };

  // Send first heartbeat immediately
  sendHeartbeat().catch((err) => {
    logger.error({ err }, 'Initial heartbeat failed');
  });

  const handle = setInterval(() => {
    sendHeartbeat().catch((err) => {
      logger.error({ err }, 'Heartbeat interval failed');
    });
  }, intervalMs);

  return () => {
    clearInterval(handle);
    logger.info('Heartbeat loop stopped');
  };
}
