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
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole } from '@dvconf/shared';

/** Minimum stake for Validator role — 0.1 SUI (100_000_000 MIST). */
const MIN_STAKE_AMOUNT = 100_000_000n;

/** Minimum stake for voting-mode registration (0.01 SUI). */
const MIN_VOTING_STAKE = 10_000_000n;

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

  // S25.C-followup.E NOTE: an earlier attempt to hard-code votingMode=false
  // for validators (matching G-009/G-012 docs) caused a regression — live
  // smoke aborted at validator_registry::register_validator with MoveAbort
  // 530 because staking::determine_role does NOT auto-assign role=Validator
  // for MIN_STAKE_AMOUNT under the current Move-side stake thresholds. The
  // voting path (register with MIN_VOTING_STAKE, CP votes role=3, apply)
  // remains the working production path. G-014 stays open as a real
  // code/doc tension to resolve on the Move side, not here.
  const votingMode = process.env['REGISTRATION_MODE'] === 'voting';
  // voting mode also stakes the full role threshold: apply_voted_role asserts
  // stake >= minimum_for_role (713). MIN_VOTING_STAKE (0.01) < validator threshold.
  const stakeAmount = MIN_STAKE_AMOUNT;
  void MIN_VOTING_STAKE;
  if (votingMode) {
    logger.info('REGISTRATION_MODE=voting — will register as role=0 and wait for CP vote');
  }

  // ── Step 1: Register as miner (role determined on-chain by staking::determine_role) ──────────
  const minerResult = await executeWithRetry(
    client,
    signer,
    (tx) => {
      // Split stake from gas coin (registration uses Coin<SUI>)
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeAmount)]);

      tx.moveCall({
        target: `${config.packageId}::registration::register`,
        arguments: [
          tx.object(config.networkRegistryId),                              // 0 &NetworkRegistry
          tx.object(config.minerStoreId),                                   // 1 &mut MinerStore
          stakeCoin,                                                         // 2 Coin<SUI>
          tx.pure.vector('u8', strToU8Vec('0.0.0.0')),                      // 3 ip: vector<u8>
          tx.pure.u16(0),                                                    // 4 port: u16
          tx.pure.vector('u8', strToU8Vec('')),                              // 5 stun_url: vector<u8>
          tx.pure.vector('u8', strToU8Vec('')),                              // 6 turn_url: vector<u8>
          tx.pure.vector('u8', strToU8Vec('global')),                        // 7 region: vector<u8>
          tx.pure.u64(0),                                                    // 8 bandwidth_mbps
          tx.pure.u64(0),                                                    // 9 max_concurrent
          tx.pure.u64(0),                                                    // 10 cpu_cores
          tx.pure.vector('u8', []),                                          // 11 turn_credential_hash
        ],
      });
    },
    'registration::register (validator)',
    logger,
  );

  if (!minerResult) {
    logger.error(
      'Auto-registration failed: ensure wallet has sufficient SUI balance. ' +
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

  // Voting mode: wait for CPs to vote on our role, then apply it
  if (votingMode) {
    const minerId = signer.toSuiAddress();
    await waitForRoleAssignment(client, config, minerId, logger);
    await applyVotedRole(client, signer, config, minerCapId, stakePositionId, logger);
    logger.info('Voted role applied — proceeding to registry enrollment');
  }

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
