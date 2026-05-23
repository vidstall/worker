/**
 * Combined heartbeat + load reporting for RelayRegistry.
 *
 * heartbeat() is the liveness signal (writes last_heartbeat on-chain).
 * update_load reports current load. Combined PTB per ADD IMP-3 pattern.
 *
 * Post-F40: relay_registry now has a dedicated relay_heartbeat entry
 * mirroring signaling_registry::heartbeat. update_load is no longer
 * doubling as the liveness signal -- it only reports load.
 *
 * Uses executeWithRetry from @dvconf/shared for exponential backoff (DAEMON-07).
 *
 * Requirements: RELAY-05, F40
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';
import type { MetricsTracker } from './metrics.js';

/**
 * Build a heartbeat moveCall on the given transaction.
 *
 * Target: relay_registry::relay_heartbeat(net_reg, registry, cap)
 * Liveness signal -- writes last_heartbeat. No load arg (mirrors signaling pattern).
 */
export function buildHeartbeatTx(
  tx: Transaction,
  config: NetworkConfig,
  minerCapId: string,
): void {
  tx.moveCall({
    target: `${config.packageId}::relay_registry::relay_heartbeat`,
    arguments: [
      tx.object(config.networkRegistryId),       // net_reg: &NetworkRegistry
      tx.object(config.relayRegistryId),          // registry: &mut RelayRegistry
      tx.object(minerCapId),                      // cap: &MinerCap
    ],
  });
}

/**
 * Build an update_load moveCall on the given transaction.
 *
 * Target: relay_registry::update_load(net_reg, registry, cap, new_load)
 * Load reporting only (post-F40, no longer doubles as liveness signal).
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
 * Start the heartbeat + load reporting loop.
 *
 * Sends a combined heartbeat + update_load PTB at the configured interval (default 30s).
 * Mirrors signaling/heartbeat.ts pattern (combined PTB per ADD IMP-3).
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
  logger.info({ intervalMs, minerCapId }, 'Starting relay heartbeat + load-update loop');

  const sendHeartbeat = async (): Promise<void> => {
    const roomCount = getRoomCount();
    const currentLoad = calculateLoad(metrics, roomCount);

    logger.debug(
      { currentLoad, rooms: roomCount, sessions: metrics.getActiveSessionCount() },
      'Sending relay heartbeat + load update',
    );

    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        // Combined PTB: heartbeat (liveness) + update_load (load reporting) per ADD IMP-3
        buildHeartbeatTx(tx, config, minerCapId);
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
