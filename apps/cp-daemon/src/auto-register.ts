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
 * Look up whether this wallet already owns a ControlPlaneCap (i.e. it
 * already ran registration::register successfully on a prior boot), and if
 * so, its miner_id and any owned StakePosition.
 */
async function findExistingCpCap(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<{ cpCapId: string; stakePositionId: string } | null> {
  try {
    const owner = signer.toSuiAddress();
    // Object type tags are pinned to the package that ORIGINALLY defined
    // them, not the latest upgraded packageId -- must use originalPackageId
    // here (see NetworkConfig's doc comment) or this silently returns
    // nothing after any contract upgrade, even though the objects are
    // still valid. relay/signaling/validator-daemon already do this
    // correctly; this was the one copy that didn't.
    const pkg = config.originalPackageId ?? config.packageId;
    const [capObjects, stakeObjects] = await Promise.all([
      client.getOwnedObjects({
        owner,
        filter: { StructType: `${pkg}::caps::ControlPlaneCap` },
        options: { showContent: false },
      }),
      client.getOwnedObjects({
        owner,
        filter: { StructType: `${pkg}::staking::StakePosition` },
        options: { showContent: false },
      }),
    ]);
    const cpCapId = capObjects.data[0]?.data?.objectId;
    const stakePositionId = stakeObjects.data[0]?.data?.objectId;
    if (!cpCapId || !stakePositionId) return null;
    return { cpCapId, stakePositionId };
  } catch (err) {
    logger.warn({ err }, 'Could not check for an existing ControlPlaneCap');
    return null;
  }
}

/**
 * Check if this CP is already registered in ControlPlaneRegistry via devInspect.
 */
async function isRegisteredInCpRegistry(
  client: SuiClient,
  config: NetworkConfig,
  cpCapId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const cap = await client.getObject({ id: cpCapId, options: { showContent: true } });
    const fields = (cap.data?.content as { fields: Record<string, string> } | undefined)?.fields;
    const minerId = fields?.['miner_id'];
    if (!minerId) return false;

    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::control_plane_registry::is_registered`,
      arguments: [tx.object(config.cpRegistryId), tx.pure.id(minerId)],
    });
    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    if (result.results?.[0]?.returnValues?.[0]) {
      const bytes = result.results[0].returnValues[0][0];
      return bytes[0] === 1;
    }
    return false;
  } catch (err) {
    logger.warn({ err, cpCapId }, 'Could not verify ControlPlaneRegistry status via devInspect; assuming not registered');
    return false;
  }
}

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
    // Self-heal: registration::register aborts with E_ALREADY_REGISTERED on
    // every restart after a successful prior boot that never got CP_CAP_ID
    // persisted back into the deploy env (e.g. a Docker restart-policy
    // trigger, host reboot, or daemon restart outside the deploy pipeline).
    // Before giving up, check whether this wallet already owns a
    // ControlPlaneCap from that earlier run and pick up from there instead
    // of crash-looping forever.
    logger.warn('Miner registration failed — checking for an existing ControlPlaneCap before giving up');
    const existing = await findExistingCpCap(client, signer, config, logger);
    if (!existing) {
      logger.error(
        'Auto-registration failed: ensure wallet has sufficient SUI balance. ' +
        'Set CP_CAP_ID in .env if already registered.',
      );
      process.exit(1);
    }
    logger.info({ cpCapId: existing.cpCapId }, 'Found existing ControlPlaneCap — resuming from Step 2');
    const alreadyInRegistry = await isRegisteredInCpRegistry(client, config, existing.cpCapId, logger);
    if (!alreadyInRegistry) {
      const healed = await registerCpInRegistry(client, signer, config, existing.cpCapId, existing.stakePositionId, logger);
      if (!healed) {
        logger.error('CP registration failed while self-healing from an existing cap. Manual intervention required.');
        process.exit(1);
      }
    }
    logger.info(
      { cpCapId: existing.cpCapId },
      `Recovered CP registration. Set CP_CAP_ID=${existing.cpCapId} in .env to skip this check on next startup.`,
    );
    return { cpCapId: existing.cpCapId };
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
  const registered = await registerCpInRegistry(client, signer, config, cpCapId, stakePositionId, logger);
  if (!registered) {
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

/**
 * Register in ControlPlaneRegistry (Step 2). Shared by the fresh-registration
 * path and the self-heal path above.
 */
async function registerCpInRegistry(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  stakePositionId: string,
  logger: Logger,
): Promise<boolean> {
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
  return Boolean(cpResult);
}
