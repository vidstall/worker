/**
 * Periodic heartbeat + load reporting for SignalingRegistry.
 *
 * Combined heartbeat + update_load in a single PTB (confirmed viable per ADD IMP-3).
 * Uses executeWithRetry from @dvconf/shared for exponential backoff (DAEMON-07).
 *
 * Requirements: SIG-02
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger } from '@dvconf/shared';
import type { RoomManager } from './rooms.js';

/**
 * Build a heartbeat moveCall on the given transaction.
 *
 * Target: signaling_registry::heartbeat (per ADD IC-2)
 */
export function buildHeartbeatTx(
  tx: Transaction,
  config: NetworkConfig,
  minerCapId: string,
): void {
  tx.moveCall({
    target: `${config.packageId}::signaling_registry::heartbeat`,
    arguments: [
      tx.object(config.networkRegistryId),       // net_reg: &NetworkRegistry
      tx.object(config.signalingRegistryId),      // registry: &mut SignalingRegistry
      tx.object(minerCapId),                      // cap: &MinerCap
    ],
  });
}

/**
 * Build an update_load moveCall on the given transaction.
 *
 * Target: signaling_registry::update_load (per ADD IC-2)
 */
export function buildUpdateLoadTx(
  tx: Transaction,
  config: NetworkConfig,
  minerCapId: string,
  currentLoad: number,
): void {
  tx.moveCall({
    target: `${config.packageId}::signaling_registry::update_load`,
    arguments: [
      tx.object(config.networkRegistryId),       // net_reg: &NetworkRegistry
      tx.object(config.signalingRegistryId),      // registry: &mut SignalingRegistry
      tx.object(minerCapId),                      // cap: &MinerCap
      tx.pure.u64(currentLoad),                   // new_load: u64
    ],
  });
}

/**
 * Start the heartbeat + load reporting loop.
 *
 * Sends a combined heartbeat + update_load PTB at the configured interval (default 30s).
 * Load = roomManager.getStats().connections (current WebSocket count, per ADD Q4).
 *
 * @returns A stop function that clears the interval.
 */
export function startHeartbeat(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  roomManager: RoomManager,
  intervalMs: number,
  logger: Logger,
): () => void {
  logger.info({ intervalMs, minerCapId }, 'Starting signaling heartbeat loop');

  const sendHeartbeat = async (): Promise<void> => {
    const stats = roomManager.getStats();
    const currentLoad = stats.connections;

    logger.debug({ currentLoad, rooms: stats.rooms }, 'Sending heartbeat + load update');

    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        // Combined PTB: heartbeat + update_load (per ADD IMP-3)
        buildHeartbeatTx(tx, config, minerCapId);
        buildUpdateLoadTx(tx, config, minerCapId, currentLoad);
      },
      'signaling-heartbeat',
      logger,
    );
  };

  // Send first heartbeat immediately
  sendHeartbeat().catch((err) => {
    logger.error({ err }, 'Initial signaling heartbeat failed');
  });

  const handle = setInterval(() => {
    sendHeartbeat().catch((err) => {
      logger.error({ err }, 'Signaling heartbeat interval failed');
    });
  }, intervalMs);

  return () => {
    clearInterval(handle);
    logger.info('Signaling heartbeat loop stopped');
  };
}
