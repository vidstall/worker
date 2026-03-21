/**
 * Relay daemon auto-registration flow.
 *
 * On startup, checks if MINER_CAP_ID is set in environment.
 * If not, registers as a miner (role=Relay) then registers in RelayRegistry.
 * If MINER_CAP_ID is set but not in RelayRegistry, runs step 2 only.
 * All TX calls go through executeWithRetry from @dvconf/shared.
 *
 * Requirements: RELAY-05
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole, type NetworkConfig, type Logger } from '@dvconf/shared';
import os from 'os';

/** Relay stake: 0.25 SUI = 250_000_000 MIST (per constants.move DEFAULT_RELAY_THRESHOLD). */
const RELAY_STAKE = 250_000_000n;

/** Minimum stake for voting-mode registration (0.01 SUI). */
const MIN_VOTING_STAKE = 10_000_000n;

/**
 * Check if a miner is registered in RelayRegistry via devInspect.
 */
async function isRegisteredInRelayRegistry(
  client: SuiClient,
  config: NetworkConfig,
  minerCapId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    // Read the MinerCap object to extract the miner_id field
    const cap = await client.getObject({ id: minerCapId, options: { showContent: true } });
    if (!cap.data) {
      logger.warn({ minerCapId }, 'MinerCap object not found on chain');
      return false;
    }

    const fields = (cap.data.content as { fields: Record<string, string> })?.fields;
    const minerId = fields?.['miner_id'];
    if (!minerId) {
      logger.warn({ minerCapId, content: cap.data.content }, 'Could not extract miner_id from MinerCap');
      return false;
    }

    // Use devInspect to call is_registered on RelayRegistry
    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::relay_registry::is_registered`,
      arguments: [
        tx.object(config.relayRegistryId),
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
    logger.warn({ err, minerCapId }, 'Could not verify RelayRegistry status via devInspect; assuming not registered');
    return false;
  }
}

/**
 * Ensure the relay daemon is registered on-chain.
 *
 * Two-step process:
 *   1. Register as miner with 1 DVCONF stake (creates MinerCap + StakePosition)
 *   2. Register in RelayRegistry (using MinerCap + StakePosition)
 *
 * If MINER_CAP_ID is set, skips step 1.
 * If MINER_CAP_ID is set but not in RelayRegistry, runs step 2 only.
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
    logger.info({ minerCapId: envCapId }, 'MINER_CAP_ID set — checking RelayRegistry status');

    const registered = await isRegisteredInRelayRegistry(client, config, envCapId, logger);
    if (registered) {
      logger.info({ minerCapId: envCapId }, 'Already registered in RelayRegistry');
      return { minerCapId: envCapId };
    }

    // MINER_CAP_ID set but not in RelayRegistry — run step 2 only
    logger.info(
      { minerCapId: envCapId },
      'MINER_CAP_ID is set but node is not registered in RelayRegistry. Running Step 2 only.',
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

    await registerInRelayRegistry(client, signer, config, envCapId, stakePositionId, endpointUrl, region, logger);
    return { minerCapId: envCapId };
  }

  logger.info('MINER_CAP_ID not set — attempting full auto-registration');

  const votingMode = process.env['REGISTRATION_MODE'] === 'voting';
  const stakeAmount = votingMode ? MIN_VOTING_STAKE : RELAY_STAKE;

  if (votingMode) {
    logger.info('Voting mode enabled — registering with minimum stake, awaiting CP role assignment');
  }

  // Step 1: Register as a miner with role=Relay (or role=0 in voting mode)
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
          tx.pure.u16(4000),  // port (placeholder)
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(''))), // stun_url
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(''))), // turn_url
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(region))), // region
          tx.pure.u64(100),  // bandwidth_mbps
          tx.pure.u64(50),   // max_concurrent
          tx.pure.u64(os.cpus().length),  // cpu_cores
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

  // Step 2: Register in RelayRegistry
  await registerInRelayRegistry(client, signer, config, minerCapId, stakePositionId, endpointUrl, region, logger);

  logger.info(
    { minerCapId },
    `Auto-registered as Relay node. Set MINER_CAP_ID=${minerCapId} in .env to skip registration on next startup.`,
  );

  return { minerCapId };
}

/**
 * Register in RelayRegistry (Step 2).
 *
 * On-chain signature:
 *   relay_registry::register_relay(net_reg, registry, cap, stake, region, endpoint_url, ctx)
 */
async function registerInRelayRegistry(
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
        target: `${config.packageId}::relay_registry::register_relay`,
        arguments: [
          tx.object(config.networkRegistryId),          // net_reg: &NetworkRegistry
          tx.object(config.relayRegistryId),             // registry: &mut RelayRegistry
          tx.object(minerCapId),                         // cap: &MinerCap
          tx.object(stakePositionId),                    // stake: &StakePosition
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(region))),        // region
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(endpointUrl))),   // endpoint_url
        ],
      });
    },
    'relay-registration',
    logger,
  );

  if (!result) {
    logger.error(
      'RelayRegistry registration failed after miner registration succeeded. ' +
      'Manual intervention required.',
    );
    process.exit(1);
  }

  logger.info({ minerCapId }, 'Registered in RelayRegistry (Step 2)');
}

// relayModeFromEnv() removed — mode is per-room, not per-relay (MCU-01).
// All relays support both SFU and MCU. See room-handler.ts for mode branching.