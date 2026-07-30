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
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole, findCreatedObjectByType, type NetworkConfig, type Logger } from '@dvconf/shared';
import os from 'os';

/** Relay stake: 0.25 SUI = 250_000_000 MIST (per constants.move DEFAULT_RELAY_THRESHOLD). */
const RELAY_STAKE = 250_000_000n;

/** Minimum stake for voting-mode registration (0.01 SUI). */
const MIN_VOTING_STAKE = 10_000_000n;

/** dvconf::core::constants::role_relay() — kept in sync manually (u8, stable). */
const ROLE_RELAY = 2;

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
    logger.info({ minerCapId: envCapId }, 'MINER_CAP_ID set — checking RelayRegistry status');

    const registered = await isRegisteredInRelayRegistry(client, config, envCapId, logger);
    if (registered) {
      logger.info({ minerCapId: envCapId }, 'Already registered in RelayRegistry — refreshing endpoint_url');
      // register_relay writes endpoint_url exactly once and refuses to run
      // again -- push our CURRENT address every startup so a droplet recreate
      // (new public IP under this same recycled wallet) doesn't leave the
      // registry pointing at a dead host forever (see update_endpoint_url's
      // doc comment in relay_registry.move).
      await updateEndpointUrlInRelayRegistry(client, signer, config, envCapId, endpointUrl, logger);
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

    // register_relay asserts cap.role == role_relay() (E_NOT_RELAY). A cap
    // minted by registration::register() defaults to role_user() and only
    // gets promoted once a CP casts a vote AND this miner applies it via
    // apply_voted_role -- which the full auto-registration flow below does,
    // but this MINER_CAP_ID-set shortcut never did, so a cap left over from
    // a prior registration that never got its vote applied would abort
    // Step 2 forever. Detect and apply it here before registering.
    const capInfo = await getMinerCapInfo(client, envCapId, logger);
    if (capInfo && capInfo.role !== ROLE_RELAY) {
      logger.info(
        { minerCapId: envCapId, role: capInfo.role },
        'Cap role is not yet Relay — waiting for CP vote and applying it',
      );
      await waitForRoleAssignment(client, config, capInfo.minerId, logger);
      await applyVotedRole(client, signer, config, envCapId, stakePositionId, logger);
      logger.info({ minerCapId: envCapId }, 'Voted role applied — proceeding to Step 2');
    }

    await registerInRelayRegistry(client, signer, config, envCapId, stakePositionId, endpointUrl, region, logger);
    return { minerCapId: envCapId };
  }

  logger.info('MINER_CAP_ID not set — attempting full auto-registration');
  return performFullRegistration(client, signer, config, endpointUrl, region, votingMode, logger, graphqlClient);
}

/**
 * Full Step 1 + Step 2 registration: mints a fresh MinerCap + StakePosition
 * from the signer's own wallet balance, then enrolls in RelayRegistry.
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
  // stake >= minimum_for_role (E_INSUFFICIENT_STAKE_FOR_ROLE / 713). MIN_VOTING_STAKE
  // (0.01) is below every threshold (regression after D-S70-4 moved the stake guard
  // from cast_role_vote to the miner-signed apply path).
  const stakeAmount = RELAY_STAKE;
  void MIN_VOTING_STAKE;

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

  return finishRegistration(client, signer, config, endpointUrl, region, votingMode, minerCapId, stakePositionId, logger);
}

/**
 * Voting-mode wait/apply + Step 2 RelayRegistry enrollment, shared by both a
 * fresh Step 1 mint and a recovered prior-attempt MinerCap + StakePosition.
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
    if (capInfo && capInfo.role !== ROLE_RELAY) {
      const minerId = signer.toSuiAddress();
      await waitForRoleAssignment(client, config, minerId, logger);
      await applyVotedRole(client, signer, config, minerCapId, stakePositionId, logger);
      logger.info('Voted role applied — proceeding to registry enrollment');
    }
  }

  // Step 2: Register in RelayRegistry -- a recovered (self-healed) registration
  // may already be enrolled from before an earlier crash (register_relay has no
  // idempotency guard of its own and aborts E_ALREADY_REGISTERED/521), so check
  // first instead of assuming a fresh Step 1 mint always means Step 2 is pending.
  const alreadyInRegistry = await isRegisteredInRelayRegistry(client, config, minerCapId, logger);
  if (!alreadyInRegistry) {
    await registerInRelayRegistry(client, signer, config, minerCapId, stakePositionId, endpointUrl, region, logger);
  } else {
    // Recovered a prior attempt that had already reached Step 2 -- still
    // refresh endpoint_url in case this recovery is itself happening on a
    // different host/IP than the original attempt.
    await updateEndpointUrlInRelayRegistry(client, signer, config, minerCapId, endpointUrl, logger);
  }

  logger.info(
    { minerCapId },
    `Auto-registered as Relay node. Set MINER_CAP_ID=${minerCapId} in .env to skip registration on next startup.`,
  );

  return { minerCapId };
}

/**
 * Look for a prior `registration::register` transaction from this wallet whose
 * effects created a MinerCap + StakePosition pair -- recovers from a crash
 * between Step 1 succeeding and this daemon persisting/using its result.
 * Uses GraphQL's `findCreatedObjectByType` (shared/chain/events.ts), NOT
 * `client.queryTransactionBlocks`, which is deprecated JSON-RPC on devnet's
 * public fullnode (confirmed via direct curl -- same "JSON-RPC on public
 * fullnodes has been deprecated" error every other event-shaped read in this
 * codebase hit). StakePosition is a SHARED object and cannot be found via
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

/**
 * Refresh the registered endpoint_url for an already-registered relay
 * (Step 2's `update_endpoint_url`, not `register_relay` -- which refuses to
 * run again for an already-registered miner_id). Best-effort: unlike a
 * fresh registration, a failed refresh doesn't block the daemon from
 * starting -- it just means the on-chain registry keeps serving a stale
 * address to cp-daemon's room assignment until the next successful retry
 * (next restart, or a future periodic refresh).
 *
 * On-chain signature:
 *   relay_registry::update_endpoint_url(net_reg, registry, cap, endpoint_url, ctx)
 */
async function updateEndpointUrlInRelayRegistry(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  minerCapId: string,
  endpointUrl: string,
  logger: Logger,
): Promise<void> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::relay_registry::update_endpoint_url`,
        arguments: [
          tx.object(config.networkRegistryId),          // net_reg: &NetworkRegistry
          tx.object(config.relayRegistryId),             // registry: &mut RelayRegistry
          tx.object(minerCapId),                         // cap: &MinerCap
          tx.pure.vector('u8', Array.from(new TextEncoder().encode(endpointUrl))), // endpoint_url
        ],
      });
    },
    'relay-endpoint-refresh',
    logger,
  );

  if (!result) {
    logger.warn(
      { minerCapId, endpointUrl },
      'Could not refresh RelayRegistry endpoint_url; continuing with the stale on-chain value.',
    );
    return;
  }

  logger.info({ minerCapId, endpointUrl }, 'Refreshed RelayRegistry endpoint_url');
}

// relayModeFromEnv() removed — mode is per-room, not per-relay (MCU-01).
// All relays support both SFU and MCU. See room-handler.ts for mode branching.