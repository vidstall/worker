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
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole, findCreatedObjectByType, type NetworkConfig, type Logger } from '@dvconf/shared';

/** Signaling stake: 0.05 SUI = 50_000_000 MIST (per constants.move DEFAULT_SIGNALING_THRESHOLD). */
const SIGNALING_STAKE = 50_000_000n;

/** Minimum stake for voting-mode registration (0.01 SUI). */
const MIN_VOTING_STAKE = 10_000_000n;

/** dvconf::core::constants::role_signaling() — kept in sync manually (u8, stable). */
const ROLE_SIGNALING = 4;

/**
 * Read a MinerCap's current on-chain role + the miner_id it was minted for.
 */
async function getMinerCapInfo(
  client: SuiClient,
  minerCapId: string,
  logger: Logger,
): Promise<{ minerId: string; role: number } | null> {
  try {
    const cap = await client.getObject({ id: minerCapId, options: { showContent: true } });
    if (!cap.data) return null;
    const fields = (cap.data.content as { fields: Record<string, string> })?.fields;
    const minerId = fields?.['miner_id'];
    const roleRaw = fields?.['role'];
    if (!minerId || roleRaw === undefined) return null;
    return { minerId, role: Number(roleRaw) };
  } catch (err) {
    logger.warn({ err, minerCapId }, 'Could not read MinerCap role');
    return null;
  }
}

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
 * If MINER_CAP_ID is set but its StakePosition is gone (e.g. the node was
 * validator-quorum EJECTED -- execute_ejection destroys the StakePosition,
 * not the MinerCap, and the contract has no path to re-attach a fresh stake
 * to an existing cap), the old cap is permanently unusable. Falls back to a
 * full re-registration instead of hard-failing: ejection is explicitly
 * non-punitive/no-slash (the old stake was already returned in full to this
 * same wallet), so that balance funds the fresh MinerCap + StakePosition here
 * -- same wallet, same keypair, new on-chain identity.
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
  graphqlClient?: SuiGraphQLClient,
): Promise<{ minerCapId: string }> {
  const envCapId = process.env['MINER_CAP_ID'];
  const votingMode = process.env['REGISTRATION_MODE'] === 'voting';

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
      filter: { StructType: `${config.originalPackageId ?? config.packageId}::staking::StakePosition` },
      options: { showContent: true },
    });

    const stakePositionId = ownedObjects.data[0]?.data?.objectId;
    if (!stakePositionId) {
      logger.warn(
        { minerCapId: envCapId },
        'MINER_CAP_ID has no StakePosition (likely ejected — the cap cannot be reused). ' +
        'Falling back to full re-registration with a fresh MinerCap + StakePosition.',
      );
      return performFullRegistration(client, signer, config, endpointUrl, region, votingMode, logger, graphqlClient);
    }

    // register_signaling asserts cap.role == role_signaling() (E_NOT_SIGNALING).
    // A cap minted by registration::register() defaults to role_user() and
    // only gets promoted once a CP casts a vote AND this miner applies it via
    // apply_voted_role -- which the full auto-registration flow below does,
    // but this MINER_CAP_ID-set shortcut never did, so a cap left over from
    // a prior registration that never got its vote applied would abort
    // Step 2 forever. Detect and apply it here before registering.
    const capInfo = await getMinerCapInfo(client, envCapId, logger);
    if (capInfo && capInfo.role !== ROLE_SIGNALING) {
      logger.info(
        { minerCapId: envCapId, role: capInfo.role },
        'Cap role is not yet Signaling — waiting for CP vote and applying it',
      );
      await waitForRoleAssignment(client, config, capInfo.minerId, logger);
      await applyVotedRole(client, signer, config, envCapId, stakePositionId, logger);
      logger.info({ minerCapId: envCapId }, 'Voted role applied — proceeding to Step 2');
    }

    await registerInSignalingRegistry(client, signer, config, envCapId, stakePositionId, endpointUrl, region, logger);
    return { minerCapId: envCapId };
  }

  logger.info('MINER_CAP_ID not set — attempting full auto-registration');
  return performFullRegistration(client, signer, config, endpointUrl, region, votingMode, logger, graphqlClient);
}

/**
 * Full Step 1 + Step 2 registration: mints a fresh MinerCap + StakePosition
 * from the signer's own wallet balance, then enrolls in SignalingRegistry.
 * Shared by both "MINER_CAP_ID unset" (first-ever boot) and "MINER_CAP_ID
 * set but its StakePosition is permanently gone" (post-ejection self-heal).
 */
async function performFullRegistration(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  endpointUrl: string,
  region: string,
  votingMode: boolean,
  logger: Logger,
  graphqlClient?: SuiGraphQLClient,
): Promise<{ minerCapId: string }> {
  // Before minting a brand-new identity, check whether an EARLIER attempt (e.g.
  // a container restart mid-registration) already succeeded at Step 1.
  // registration::register derives miner_id DETERMINISTICALLY from the wallet
  // address, so retrying it blindly aborts E_ALREADY_REGISTERED (404) once a
  // profile exists for this address -- and StakePosition is a SHARED object
  // (transfer::share_object), invisible to getOwnedObjects, so the only way to
  // recover its id is from the transaction that created it.
  const prior = await findPriorRegistration(signer, config, logger, graphqlClient);
  if (prior) {
    logger.info(
      prior,
      'Found MinerCap + StakePosition from a prior partial registration attempt — reusing instead of minting a new identity',
    );
    return finishRegistration(client, signer, config, endpointUrl, region, votingMode, prior.minerCapId, prior.stakePositionId, logger);
  }

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

  return finishRegistration(client, signer, config, endpointUrl, region, votingMode, minerCapId, stakePositionId, logger);
}

/**
 * Voting-mode wait/apply + Step 2 SignalingRegistry enrollment, shared by both
 * a fresh Step 1 mint and a recovered prior-attempt MinerCap + StakePosition.
 */
async function finishRegistration(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  endpointUrl: string,
  region: string,
  votingMode: boolean,
  minerCapId: string,
  stakePositionId: string,
  logger: Logger,
): Promise<{ minerCapId: string }> {
  // Voting mode: wait for CPs to vote on our role, then apply it (skipped if
  // this cap's role was already applied by a prior attempt).
  if (votingMode) {
    const capInfo = await getMinerCapInfo(client, minerCapId, logger);
    if (capInfo && capInfo.role !== ROLE_SIGNALING) {
      const minerId = signer.toSuiAddress();
      await waitForRoleAssignment(client, config, minerId, logger);
      await applyVotedRole(client, signer, config, minerCapId, stakePositionId, logger);
      logger.info('Voted role applied — proceeding to registry enrollment');
    }
  }

  // Step 2: Register in SignalingRegistry -- a recovered (self-healed)
  // registration may already be enrolled from before an earlier crash
  // (register_signaling has no idempotency guard of its own and aborts
  // E_ALREADY_REGISTERED), so check first instead of assuming a fresh Step 1
  // mint always means Step 2 is pending.
  const alreadyInRegistry = await isRegisteredInSignalingRegistry(client, config, minerCapId, logger);
  if (!alreadyInRegistry) {
    await registerInSignalingRegistry(client, signer, config, minerCapId, stakePositionId, endpointUrl, region, logger);
  }

  logger.info(
    { minerCapId },
    `Auto-registered as Signaling node. Set MINER_CAP_ID=${minerCapId} in .env to skip registration on next startup.`,
  );

  return { minerCapId };
}

/**
 * Look for a prior `registration::register` transaction from this wallet whose
 * effects created a MinerCap + StakePosition pair -- recovers from a crash
 * between Step 1 succeeding and this daemon persisting/using its result. Uses
 * GraphQL's `findCreatedObjectByType` (shared/chain/events.ts), NOT
 * `client.queryTransactionBlocks`, which is deprecated JSON-RPC on devnet's
 * public fullnode. StakePosition is a SHARED object and cannot be found via
 * getOwnedObjects, hence the transaction-history scan. Returns null (not an
 * error, and also when `graphqlClient` is unset) if none is found -- callers
 * fall through to minting a fresh pair.
 */
async function findPriorRegistration(
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
  graphqlClient?: SuiGraphQLClient,
): Promise<{ minerCapId: string; stakePositionId: string } | null> {
  if (!graphqlClient) {
    return null;
  }
  const pkg = config.originalPackageId ?? config.packageId;
  const address = signer.toSuiAddress();
  try {
    const minerCapId = await findCreatedObjectByType(graphqlClient, address, `${pkg}::caps::MinerCap`);
    const stakePositionId = await findCreatedObjectByType(graphqlClient, address, `${pkg}::staking::StakePosition`);
    if (minerCapId && stakePositionId) {
      return { minerCapId, stakePositionId };
    }
    return null;
  } catch (err) {
    logger.warn({ err }, 'Could not query prior registration transactions; will mint a fresh MinerCap + StakePosition');
    return null;
  }
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
