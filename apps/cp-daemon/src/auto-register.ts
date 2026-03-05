/**
 * CP daemon auto-registration flow.
 *
 * On startup, checks if CP_CAP_ID is set in environment.
 * If not, registers as a miner (role=CP) then registers as CP in ControlPlaneRegistry.
 * All TX calls go through executeWithRetry from @dvconf/shared (DAEMON-07/DAEMON-12).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig, type Logger, MinerRole } from '@dvconf/shared';

/**
 * Ensure the CP daemon is registered on-chain.
 *
 * @returns The CP capability object ID.
 */
export async function ensureRegistered(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<{ cpCapId: string }> {
  // Check if already registered via env
  const envCapId = process.env['CP_CAP_ID'];
  if (envCapId) {
    logger.info({ cpCapId: envCapId }, 'CP already registered (from env)');
    return { cpCapId: envCapId };
  }

  logger.info('CP_CAP_ID not set — attempting auto-registration');

  // Step 1: Register as a miner with role=CP
  const minerResult = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      // Split a coin for stake (1 DVCONF = 1_000_000_000 MIST)
      const [stakeCoin] = tx.splitCoins(tx.gas, [1_000_000_000]);

      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          stakeCoin!,
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('127.0.0.1'))), // ip (placeholder)
          tx.pure.u16(8080), // port (placeholder)
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(''))), // stun_url
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(''))), // turn_url
          tx.pure.u8(0), // region
          tx.pure.u64(0), // bandwidth_mbps (CP doesn't serve media)
          tx.pure.u64(0), // max_concurrent
          tx.pure.u8(1), // cpu_cores
          tx.pure.u8(MinerRole.CP), // relay_mode / role = CP
          tx.pure.vector('u8', []), // turn_credential_hash
        ],
      });
    },
    'miner-registration',
    logger,
  );

  if (!minerResult) {
    logger.error(
      'Auto-registration failed: ensure wallet has DVCONF tokens and SUI gas. ' +
      'Set CP_CAP_ID in .env if already registered.',
    );
    process.exit(1);
  }

  // Extract MinerCap object ID from created objects
  const createdObjects = (minerResult.effects as any)?.created ?? [];
  const minerCapId = createdObjects[0]?.reference?.objectId;

  if (!minerCapId) {
    logger.error({ effects: minerResult.effects }, 'Could not extract MinerCap from TX effects');
    process.exit(1);
  }

  logger.info({ minerCapId }, 'Miner registered successfully');

  // Step 2: Register as CP in ControlPlaneRegistry
  const cpResult = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.cpRegistryId),
          tx.object(config.minerStoreId),
          tx.object(minerCapId),
        ],
      });
    },
    'cp-registration',
    logger,
  );

  if (!cpResult) {
    logger.error(
      'CP registration failed after miner registration succeeded. ' +
      'Manual intervention required.',
    );
    process.exit(1);
  }

  // Extract CP cap ID from created objects
  const cpCreatedObjects = (cpResult.effects as any)?.created ?? [];
  const cpCapId = cpCreatedObjects[0]?.reference?.objectId;

  if (!cpCapId) {
    logger.error({ effects: cpResult.effects }, 'Could not extract CP cap from TX effects');
    process.exit(1);
  }

  logger.info(
    { cpCapId },
    `Auto-registered as CP. Set CP_CAP_ID=${cpCapId} in .env to skip registration on next startup.`,
  );

  return { cpCapId };
}
