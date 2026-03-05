/**
 * Auto-registration flow for the Validator daemon.
 *
 * On startup, checks if VALIDATOR_CAP_ID is set in env:
 * - If set: returns it immediately (already registered)
 * - If not: registers as miner (role=Validator), then registers in ValidatorRegistry
 *
 * All TX calls use executeWithRetry from @dvconf/shared (DAEMON-07/DAEMON-12 compliance).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, TxResult, Logger } from '@dvconf/shared';
import { executeWithRetry, MinerRole } from '@dvconf/shared';

/** Minimum stake amount for registration (in MIST). */
const MIN_STAKE_AMOUNT = 1_000_000n;

/**
 * Ensure the validator is registered on-chain.
 *
 * Returns the validator cap ID, either from env or from fresh registration.
 * Exits process with code 1 on registration failure.
 */
export async function ensureRegistered(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<{ validatorCapId: string }> {
  // Check env first — skip registration if already registered
  const envCapId = process.env['VALIDATOR_CAP_ID'];
  if (envCapId) {
    logger.info({ validatorCapId: envCapId }, 'VALIDATOR_CAP_ID found in env, skipping registration');
    return { validatorCapId: envCapId };
  }

  logger.info('VALIDATOR_CAP_ID not set — attempting auto-registration');

  // Step 1: Register as miner with Validator role
  const minerResult = await executeWithRetry(
    client,
    signer,
    (tx) => {
      // Split a coin for stake
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(MIN_STAKE_AMOUNT)]);

      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.minerStoreId),
          stakeCoin,
          tx.pure.u8(MinerRole.Validator),         // role = Validator (1)
          tx.pure.string('0.0.0.0'),                // ip (placeholder — validators don't serve media)
          tx.pure.u64(0),                            // port (placeholder)
          tx.pure.string(''),                        // stun_url (placeholder)
          tx.pure.string(''),                        // turn_url (placeholder)
          tx.pure.string('global'),                  // region
          tx.pure.u64(0),                            // bandwidth_mbps (N/A for validators)
          tx.pure.u64(0),                            // max_concurrent (N/A)
          tx.pure.u64(0),                            // cpu_cores (N/A)
          tx.pure.u8(0),                             // relay_mode (N/A)
          tx.pure.vector('u8', []),                  // turn_credential_hash (empty)
        ],
      });
    },
    'registration::register (validator)',
    logger,
  );

  if (!minerResult) {
    logger.error(
      'Auto-registration failed: ensure wallet has DVCONF tokens and SUI gas. ' +
      'Set VALIDATOR_CAP_ID in .env if already registered.',
    );
    process.exit(1);
  }

  // Extract miner cap ID from created objects
  const minerCapId = extractCreatedObjectId(minerResult);
  if (!minerCapId) {
    logger.error({ effects: minerResult.effects }, 'Failed to extract miner cap ID from TX effects');
    process.exit(1);
  }

  logger.info({ minerCapId }, 'Miner registration succeeded');

  // Step 2: Register in ValidatorRegistry
  const validatorResult = await executeWithRetry(
    client,
    signer,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::register_validator`,
        arguments: [
          tx.object(config.validatorRegistryId),
          tx.object(config.minerStoreId),
          tx.object(minerCapId),
        ],
      });
    },
    'validator_registry::register_validator',
    logger,
  );

  if (!validatorResult) {
    logger.error('Validator registry registration failed after miner registration succeeded');
    process.exit(1);
  }

  const validatorCapId = extractCreatedObjectId(validatorResult) ?? minerCapId;

  logger.info(
    { validatorCapId },
    `Auto-registered as Validator — cap ID: ${validatorCapId}. ` +
    `Set VALIDATOR_CAP_ID=${validatorCapId} in .env to skip registration on next startup.`,
  );

  return { validatorCapId };
}

/**
 * Extract the first created object ID from TX effects.
 */
function extractCreatedObjectId(result: TxResult): string | null {
  const effects = result.effects as Record<string, unknown>;
  const created = effects['created'] as Array<{ reference?: { objectId?: string } }> | undefined;
  if (created && created.length > 0) {
    return created[0]?.reference?.objectId ?? null;
  }
  return null;
}
