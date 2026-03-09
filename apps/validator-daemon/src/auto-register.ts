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
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { executeWithRetry, extractCreatedObjectByType } from '@dvconf/shared';

/** Minimum stake for Validator role — 0.5 DVCONF (500_000_000 MIST). */
const MIN_STAKE_AMOUNT = 500_000_000n;

/** Encode a UTF-8 string as a u8 vector argument for Move vector<u8> params. */
function strToU8Vec(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

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

  // ── Step 1: Register as miner (role determined on-chain by staking::determine_role) ──────────
  // Move signature: registration::register(
  //   registry: &NetworkRegistry,       arg 0 — shared
  //   store: &mut MinerStore,           arg 1 — shared
  //   coin: Coin<TOKEN>,                arg 2 — owned (split from gas)
  //   ip: vector<u8>,                   arg 3
  //   port: u16,                        arg 4
  //   stun_url: vector<u8>,             arg 5
  //   turn_url: vector<u8>,             arg 6
  //   region: vector<u8>,               arg 7
  //   bandwidth_mbps: u64,              arg 8
  //   max_concurrent: u64,              arg 9
  //   cpu_cores: u64,                   arg 10
  //   relay_mode: u8,                   arg 11
  //   turn_credential_hash: vector<u8>, arg 12
  // )  — 13 args total, no MinerRole arg
  const minerResult = await executeWithRetry(
    client,
    signer,
    (tx) => {
      // Split a coin for stake
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(MIN_STAKE_AMOUNT)]);

      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),                              // 0 &NetworkRegistry
          tx.object(config.minerStoreId),                                   // 1 &mut MinerStore
          stakeCoin,                                                         // 2 Coin<TOKEN>
          tx.pure.vector('u8', strToU8Vec('0.0.0.0')),                      // 3 ip: vector<u8>
          tx.pure.u16(0),                                                    // 4 port: u16
          tx.pure.vector('u8', strToU8Vec('')),                              // 5 stun_url: vector<u8>
          tx.pure.vector('u8', strToU8Vec('')),                              // 6 turn_url: vector<u8>
          tx.pure.vector('u8', strToU8Vec('global')),                        // 7 region: vector<u8>
          tx.pure.u64(0),                                                    // 8 bandwidth_mbps
          tx.pure.u64(0),                                                    // 9 max_concurrent
          tx.pure.u64(0),                                                    // 10 cpu_cores
          tx.pure.u8(0),                                                     // 11 relay_mode
          tx.pure.vector('u8', []),                                          // 12 turn_credential_hash
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

  // Extract both objects created by registration::register for Validator role:
  //   - MinerCap  (caps::new_miner_cap + transfer::public_transfer)
  //   - StakePosition (staking::create + staking::transfer_to)
  const minerCapId = extractCreatedObjectByType(minerResult, '::caps::MinerCap');
  const stakePositionId = extractCreatedObjectByType(minerResult, '::staking::StakePosition');

  if (!minerCapId) {
    logger.error({ effects: minerResult.effects }, 'Failed to extract MinerCap ID from TX effects');
    process.exit(1);
  }
  if (!stakePositionId) {
    logger.error({ effects: minerResult.effects }, 'Failed to extract StakePosition ID from TX effects');
    process.exit(1);
  }

  logger.info({ minerCapId, stakePositionId }, 'Miner registration succeeded');

  // ── Step 2: Register in ValidatorRegistry ────────────────────────────────────────────────────
  // Move signature: validator_registry::register_validator(
  //   net_reg: &NetworkRegistry,         arg 0 — shared
  //   registry: &mut ValidatorRegistry,  arg 1 — shared
  //   cap: &MinerCap,                    arg 2 — owned (from Step 1)
  //   stake: &StakePosition,             arg 3 — owned (from Step 1)
  // )
  const validatorResult = await executeWithRetry(
    client,
    signer,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::validator_registry::register_validator`,
        arguments: [
          tx.object(config.networkRegistryId),   // 0 &NetworkRegistry
          tx.object(config.validatorRegistryId), // 1 &mut ValidatorRegistry
          tx.object(minerCapId),                 // 2 &MinerCap (from Step 1)
          tx.object(stakePositionId),            // 3 &StakePosition (from Step 1)
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

  // register_validator does not create a new cap — the MinerCap from Step 1 is the validator cap
  const validatorCapId = minerCapId;

  logger.info(
    { validatorCapId },
    `Auto-registered as Validator — cap ID: ${validatorCapId}. ` +
    `Set VALIDATOR_CAP_ID=${validatorCapId} in .env to skip registration on next startup.`,
  );

  return { validatorCapId };
}
