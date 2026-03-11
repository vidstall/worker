/**
 * Periodic load reporting for RelayRegistry.
 *
 * RelayRegistry does NOT have a dedicated heartbeat function --
 * update_load serves as the liveness signal.
 * Uses executeWithRetry from @dvconf/shared for exponential backoff.
 *
 * Requirements: RELAY-05
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';
import type { MetricsTracker } from './metrics.js';

/**
 * Build an update_load moveCall on the given transaction.
 *
 * Target: relay_registry::update_load(net_reg, registry, cap, new_load)
 */
export function buildUpdateLoadTx(
  tx: Transaction,
  config: NetworkConfig,
  minerCapId: string,
  currentLoad: number,
): void {
  tx.moveCall({
    target: `${config.packageId}::relay_registry::update_load`,
    arguments: [
      tx.object(config.networkRegistryId),       // net_reg: &NetworkRegistry
      tx.object(config.relayRegistryId),          // registry: &mut RelayRegistry
      tx.object(minerCapId),                      // cap: &MinerCap
      tx.pure.u64(currentLoad),                   // new_load: u64
    ],
  });
}

/**
 * Calculate current load metric.
 *
 * Load = active session count + total bytes forwarded (scaled to a manageable number).
 * For simplicity, we use active session count as the primary load indicator.
 */
function calculateLoad(metrics: MetricsTracker, roomCount: number): number {
  const sessions = metrics.getActiveSessionCount();
  // Combine room count and session count as a load metric
  return roomCount + sessions;
}

/**
 * Start the load reporting loop.
 *
 * Sends update_load PTB at the configured interval (default 30s).
 * update_load serves as the liveness signal for RelayRegistry.
 *
 * @param getRoomCount - Callback to get current active room count
 * @returns A stop function that clears the interval.
 */
export function startHeartbeat(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  metrics: MetricsTracker,
  getRoomCount: () => number,
  intervalMs: number,
  logger: Logger,
): () => void {
  logger.info({ intervalMs, minerCapId }, 'Starting relay heartbeat/load-update loop');

  const sendHeartbeat = async (): Promise<void> => {
    const roomCount = getRoomCount();
    const currentLoad = calculateLoad(metrics, roomCount);

    logger.debug(
      { currentLoad, rooms: roomCount, sessions: metrics.getActiveSessionCount() },
      'Sending relay load update',
    );

    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        buildUpdateLoadTx(tx, config, minerCapId, currentLoad);
      },
      'relay-heartbeat',
      logger,
    );
  };

  // Send first heartbeat immediately
  sendHeartbeat().catch((err) => {
    logger.error({ err }, 'Initial relay heartbeat failed');
  });

  const handle = setInterval(() => {
    sendHeartbeat().catch((err) => {
      logger.error({ err }, 'Relay heartbeat interval failed');
    });
  }, intervalMs);

  return () => {
    clearInterval(handle);
    logger.info('Relay heartbeat loop stopped');
  };
}
