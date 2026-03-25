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
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole, type NetworkConfig, type Logger } from '@dvconf/shared';

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

  /**
   * CP stake: 1.0 SUI (1_000_000_000 MIST).
   * Dynamic CP threshold = base(0.5) + cp_count * step(0.1), so 1.0 SUI
   * covers up to 5 existing CPs.
   */
  const CP_STAKE = 1_000_000_000n;
  /** Minimum stake for voting-mode registration (0.01 SUI). */
  const MIN_VOTING_STAKE = 10_000_000n;

  // CPs always self-register directly — they ARE the voters, so voting mode
  // would create a deadlock (no CP available to vote for other CPs).
  const votingMode = false;
  if (process.env['REGISTRATION_MODE'] === 'voting') {
    logger.info('REGISTRATION_MODE=voting ignored for CP — CPs always self-register directly');
  }
  const stakeAmount = CP_STAKE;

  // Step 1: Register as a miner with role=CP (or role=0 in voting mode)
  const minerResult = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      // Split stake from gas coin (registration uses Coin<SUI>)
      const [stakeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(stakeAmount)]);

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
          tx.pure.vector('u8', Array.from(new TextEncoder().encode('local'))), // region
          tx.pure.u64(0), // bandwidth_mbps (CP doesn't serve media)
          tx.pure.u64(0), // max_concurrent
          tx.pure.u64(1), // cpu_cores
          tx.pure.vector('u8', []), // turn_credential_hash
        ],
      });
    },
    'miner-registration',
    logger,
  );

  if (!minerResult) {
    logger.error(
      'Auto-registration failed: ensure wallet has sufficient SUI balance. ' +
      'Set CP_CAP_ID in .env if already registered.',
    );
    process.exit(1);
  }

  // Extract cap and StakePosition from created objects by type suffix.
  // In voting mode, registration creates a MinerCap (role=0); in direct mode, a ControlPlaneCap.
  const capTypeSuffix = votingMode ? '::caps::MinerCap' : '::caps::ControlPlaneCap';
  const cpCapId = extractCreatedObjectByType(minerResult, capTypeSuffix);
  const stakePositionId = extractCreatedObjectByType(minerResult, '::staking::StakePosition');

  if (!cpCapId || !stakePositionId) {
    logger.error(
      { effects: minerResult.effects, cpCapId, stakePositionId },
      `Could not extract ${votingMode ? 'MinerCap' : 'ControlPlaneCap'} or StakePosition from TX effects`,
    );
    process.exit(1);
  }

  logger.info({ cpCapId, stakePositionId }, 'Miner registered successfully');

  // Voting mode: wait for CPs to vote on our role, then apply it
  if (votingMode) {
    const minerId = signer.toSuiAddress();
    await waitForRoleAssignment(client, config, minerId, logger);
    await applyVotedRole(client, signer, config, cpCapId, stakePositionId, logger);
    logger.info('Voted role applied — proceeding to registry enrollment');
  }

  // Step 2: Register as CP in ControlPlaneRegistry
  const cpResult = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::control_plane_registry::register_cp`,
        arguments: [
          tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
          tx.object(config.cpRegistryId),      // registry: &mut ControlPlaneRegistry
          tx.object(cpCapId),                  // cap: &ControlPlaneCap (from Step 1)
          tx.object(stakePositionId),          // stake: &StakePosition (from Step 1)
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

  // register_cp mutates ControlPlaneRegistry and emits an event — it creates no new objects.
  // The cpCapId was already extracted from Step 1 effects above.
  logger.info(
    { cpCapId },
    `Auto-registered as CP. Set CP_CAP_ID=${cpCapId} in .env to skip registration on next startup.`,
  );

  return { cpCapId };
}
