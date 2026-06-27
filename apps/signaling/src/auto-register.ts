/**
 * Signaling daemon auto-registration flow.
 *
 * On startup, checks if MINER_CAP_ID is set in environment.
 * If not, registers as a miner (role=Signaling) then registers in SignalingRegistry.
 * If MINER_CAP_ID is set but not in SignalingRegistry, runs step 2 only (per ADD Q3).
 * All TX calls go through executeWithRetry from @dvconf/shared (DAEMON-07/DAEMON-12).
 *
 * Requirements: SIG-01
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole, type NetworkConfig, type Logger } from '@dvconf/shared';

/** Signaling stake: 0.05 SUI = 50_000_000 MIST (per constants.move DEFAULT_SIGNALING_THRESHOLD). */
const SIGNALING_STAKE = 50_000_000n;

/** Minimum stake for voting-mode registration (0.01 SUI). */
const MIN_VOTING_STAKE = 10_000_000n;

/**
 * Check if a miner is registered in SignalingRegistry via devInspect.
 */
async function isRegisteredInSignalingRegistry(
  client: SuiClient,
  config: NetworkConfig,
  minerCapId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    // Read the MinerCap object to extract the miner_id field inside it
    const cap = await client.getObject({ id: minerCapId, options: { showContent: true } });
    if (!cap.data) {
      logger.warn({ minerCapId }, 'MinerCap object not found on chain');
      return false;
    }

    // Extract miner_id from MinerCap content — the Move function expects
    // a raw ID (pure value), NOT the MinerCap object reference itself.
    const fields = (cap.data.content as { fields: Record<string, string> })?.fields;
    const minerId = fields?.['miner_id'];
    if (!minerId) {
      logger.warn({ minerCapId, content: cap.data.content }, 'Could not extract miner_id from MinerCap');
      return false;
    }

    // Use devInspect to call is_registered on SignalingRegistry
    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::signaling_registry::is_registered`,
      arguments: [
        tx.object(config.signalingRegistryId),
        tx.pure.address(minerId),
      ],
    });

    const result = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });

    if (result.results?.[0]?.returnValues?.[0]) {
      const bytes = result.results[0].returnValues[0][0];
      // BCS bool: [1] = true, [0] = false
      return bytes[0] === 1;
    }

    return false;
  } catch (err) {
    logger.warn({ err, minerCapId }, 'Could not verify SignalingRegistry status via devInspect; assuming not registered');
    return false;
  }
}

/**
 * Ensure the signaling daemon is registered on-chain.
 *
 * Two-step process:
 *   1. Register as miner with 0.25 DVCONF stake (creates MinerCap + StakePosition)
 *   2. Register in SignalingRegistry (using MinerCap + StakePosition)
 *
 * If MINER_CAP_ID is set, skips step 1.
 * If MINER_CAP_ID is set but not in SignalingRegistry, runs step 2 only.
 *
 * @returns The MinerCap object ID.
 */
export async function ensureRegistered(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  endpointUrl: string,
  region: string,
  logger: Logger,
): Promise<{ minerCapId: string }> {
  const envCapId = process.env['MINER_CAP_ID'];

  if (envCapId) {
    logger.info({ minerCapId: envCapId }, 'MINER_CAP_ID set — checking SignalingRegistry status');

    const registered = await isRegisteredInSignalingRegistry(client, config, envCapId, logger);
    if (registered) {
      logger.info({ minerCapId: envCapId }, 'Already registered in SignalingRegistry');
      return { minerCapId: envCapId };
    }

    // Per ADD Q3: MINER_CAP_ID set but not in SignalingRegistry — run step 2 only
    logger.info(
      { minerCapId: envCapId },
      'MINER_CAP_ID is set but node is not registered in SignalingRegistry. Running Step 2 only.',
    );

    // Need StakePosition ID — query owned objects
    const ownedObjects = await client.getOwnedObjects({
      owner: signer.toSuiAddress(),
      filter: { StructType: `${config.packageId}::staking::StakePosition` },
      options: { showContent: true },
    });

    const stakePositionId = ownedObjects.data[0]?.data?.objectId;
    if (!stakePositionId) {
      logger.error('Cannot find StakePosition for step 2 registration. Manual intervention required.');
      process.exit(1);
    }

    await registerInSignalingRegistry(client, signer, config, envCapId, stakePositionId, endpointUrl, region, logger);
    return { minerCapId: envCapId };
  }

  logger.info('MINER_CAP_ID not set — attempting full auto-registration');

  const votingMode = process.env['REGISTRATION_MODE'] === 'voting';
  // voting mode also stakes the full role threshold: apply_voted_role asserts
  // stake >= minimum_for_role (713). MIN_VOTING_STAKE (0.01) < signaling threshold.
  const stakeAmount = SIGNALING_STAKE;
  void MIN_VOTING_STAKE;

  if (votingMode) {
    logger.info('Voting mode enabled — registering with minimum stake, awaiting CP role assignment');
  }

  // Step 1: Register as a miner with role=Signaling (or role=0 in voting mode)
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
          tx.pure.u16(8080),  // port (placeholder)
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(''))), // stun_url
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(''))), // turn_url
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(region))), // region
          tx.pure.u64(0),  // bandwidth_mbps (signaling doesn't serve media)
          tx.pure.u64(0),  // max_concurrent
          tx.pure.u64(1),  // cpu_cores
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
      'Set MINER_CAP_ID in .env if already registered.',
    );
    process.exit(1);
  }

  // Extract MinerCap and StakePosition from created objects
  const minerCapId = extractCreatedObjectByType(minerResult, '::caps::MinerCap');
  const stakePositionId = extractCreatedObjectByType(minerResult, '::staking::StakePosition');

  if (!minerCapId || !stakePositionId) {
    logger.error(
      { effects: minerResult.effects, minerCapId, stakePositionId },
      'Could not extract MinerCap or StakePosition from TX effects',
    );
    process.exit(1);
  }

  logger.info({ minerCapId, stakePositionId }, 'Miner registered successfully (Step 1)');

  // Voting mode: wait for CPs to vote on our role, then apply it
  if (votingMode) {
    const minerId = signer.toSuiAddress();
    await waitForRoleAssignment(client, config, minerId, logger);
    await applyVotedRole(client, signer, config, minerCapId, stakePositionId, logger);
    logger.info('Voted role applied — proceeding to registry enrollment');
  }

  // Step 2: Register in SignalingRegistry
  await registerInSignalingRegistry(client, signer, config, minerCapId, stakePositionId, endpointUrl, region, logger);

  logger.info(
    { minerCapId },
    `Auto-registered as Signaling node. Set MINER_CAP_ID=${minerCapId} in .env to skip registration on next startup.`,
  );

  return { minerCapId };
}

/**
 * Register in SignalingRegistry (Step 2).
 * Matches IC-1 from ADD: signaling_registry::register_signaling
 */
async function registerInSignalingRegistry(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  stakePositionId: string,
  endpointUrl: string,
  region: string,
  logger: Logger,
): Promise<void> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::signaling_registry::register_signaling`,
        arguments: [
          tx.object(config.networkRegistryId),          // net_reg: &NetworkRegistry
          tx.object(config.signalingRegistryId),         // registry: &mut SignalingRegistry
          tx.object(minerCapId),                         // cap: &MinerCap
          tx.object(stakePositionId),                    // stake: &StakePosition
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(endpointUrl))),  // endpoint_url
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(region))),       // region
        ],
      });
    },
    'signaling-registration',
    logger,
  );

  if (!result) {
    logger.error(
      'SignalingRegistry registration failed after miner registration succeeded. ' +
      'Manual intervention required.',
    );
    process.exit(1);
  }

  logger.info({ minerCapId }, 'Registered in SignalingRegistry (Step 2)');
}
