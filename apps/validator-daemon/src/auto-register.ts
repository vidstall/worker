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
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { executeWithRetry, extractCreatedObjectByType, waitForRoleAssignment, applyVotedRole, findCreatedObjectByType } from '@dvconf/shared';
import { Transaction } from '@mysten/sui/transactions';

/** Minimum stake for Validator role — 0.1 SUI (100_000_000 MIST). */
const MIN_STAKE_AMOUNT = 100_000_000n;

/** Minimum stake for voting-mode registration (0.01 SUI). */
const MIN_VOTING_STAKE = 10_000_000n;

/** dvconf::core::constants::role_validator() — kept in sync manually (u8, stable). */
const ROLE_VALIDATOR = 1;

/** Encode a UTF-8 string as a u8 vector argument for Move vector<u8> params. */
function strToU8Vec(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

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
 * Check if a miner is registered in ValidatorRegistry via devInspect.
 */
async function isRegisteredInValidatorRegistry(
  client: SuiClient,
  config: NetworkConfig,
  minerId: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::validator_registry::is_registered`,
      arguments: [tx.object(config.validatorRegistryId), tx.pure.id(minerId)],
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
    logger.warn({ err, minerId }, 'Could not verify ValidatorRegistry status via devInspect; assuming not registered');
    return false;
  }
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
  graphqlClient?: SuiGraphQLClient,
): Promise<{ validatorCapId: string }> {
  // Check env first — skip registration if already registered
  const envCapId = process.env['VALIDATOR_CAP_ID'];
  if (envCapId) {
    logger.info({ validatorCapId: envCapId }, 'VALIDATOR_CAP_ID found in env, checking ValidatorRegistry status');

    // This cap may come from a wallet-pool lookup (see cli/wallet.py
    // resolve_cap_id) that only confirms the cap object EXISTS -- not that
    // it already carries role=Validator, or that register_validator's
    // Step 2 ever ran for it. Both register_validator and
    // self_assign_session_wallet (called later in startDaemon) assert
    // cap.role == role_validator() (E_NOT_VALIDATOR/530), so a cap left at
    // role_user() (never voted+applied) or never registered in
    // ValidatorRegistry would abort downstream instead of here.
    const capInfo = await getMinerCapInfo(client, envCapId, logger);
    if (!capInfo) {
      logger.error({ validatorCapId: envCapId }, 'Could not read MinerCap; manual intervention required.');
      process.exit(1);
    }

    if (capInfo.role !== ROLE_VALIDATOR) {
      logger.info(
        { validatorCapId: envCapId, role: capInfo.role },
        'Cap role is not yet Validator — waiting for CP vote and applying it',
      );
      const ownedObjects = await client.getOwnedObjects({
        owner: signer.toSuiAddress(),
        filter: { StructType: `${config.originalPackageId ?? config.packageId}::staking::StakePosition` },
        options: { showContent: true },
      });
      const stakePositionId = ownedObjects.data[0]?.data?.objectId;
      if (!stakePositionId) {
        logger.error('Cannot find StakePosition to apply voted role. Manual intervention required.');
        process.exit(1);
      }
      await waitForRoleAssignment(client, config, capInfo.minerId, logger);
      await applyVotedRole(client, signer, config, envCapId, stakePositionId, logger);
      logger.info({ validatorCapId: envCapId }, 'Voted role applied');
    }

    const registered = await isRegisteredInValidatorRegistry(client, config, capInfo.minerId, logger);
    if (!registered) {
      logger.info({ validatorCapId: envCapId }, 'Not yet in ValidatorRegistry — running Step 2');
      const ownedObjects = await client.getOwnedObjects({
        owner: signer.toSuiAddress(),
        filter: { StructType: `${config.originalPackageId ?? config.packageId}::staking::StakePosition` },
        options: { showContent: true },
      });
      const stakePositionId = ownedObjects.data[0]?.data?.objectId;
      if (!stakePositionId) {
        logger.error('Cannot find StakePosition for step 2 registration. Manual intervention required.');
        process.exit(1);
      }
      const result = await executeWithRetry(
        client,
        signer,
        (tx) => {
          tx.moveCall({
            target: `${config.packageId}::validator_registry::register_validator`,
            arguments: [
              tx.object(config.networkRegistryId),
              tx.object(config.validatorRegistryId),
              tx.object(envCapId),
              tx.object(stakePositionId),
            ],
          });
        },
        'validator_registry::register_validator',
        logger,
      );
      if (!result) {
        logger.error('ValidatorRegistry registration failed after cap already existed. Manual intervention required.');
        process.exit(1);
      }
      logger.info({ validatorCapId: envCapId }, 'Registered in ValidatorRegistry (Step 2)');
    }

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

  let minerCapId: string;
  let stakePositionId: string;
  let alreadyVoted = false;

  if (!minerResult) {
    // Self-heal: registration::register aborts with E_ALREADY_REGISTERED on
    // every restart after a successful prior boot that never got
    // VALIDATOR_CAP_ID persisted back into the deploy env (e.g. Step 1
    // succeeded but the daemon then crashed waiting on the role vote,
    // Docker's restart policy relaunched it, and it's back here with no
    // memory of the earlier success). Unlike relay/cp-daemon, this path had
    // no recovery at all -- it just hard-exited, permanently wedging the
    // validator even after a CP had already voted it in. Mirror relay's
    // findPriorRegistration self-heal here instead of giving up.
    logger.warn('Miner registration failed — checking for a prior partial registration attempt before giving up');
    const prior = await findPriorRegistration(signer, config, logger, graphqlClient);
    if (!prior) {
      logger.error(
        'Auto-registration failed: ensure wallet has sufficient SUI balance. ' +
        'Set VALIDATOR_CAP_ID in .env if already registered.',
      );
      process.exit(1);
    }
    logger.info(
      prior,
      'Found MinerCap + StakePosition from a prior partial registration attempt — reusing instead of minting a new identity',
    );
    minerCapId = prior.minerCapId;
    stakePositionId = prior.stakePositionId;

    // The recovered cap may already carry role=Validator (vote was applied
    // before the earlier crash) -- re-applying would abort, so check first.
    const capInfo = await getMinerCapInfo(client, minerCapId, logger);
    alreadyVoted = capInfo?.role === ROLE_VALIDATOR;
  } else {
    // Extract both objects created by registration::register for Validator role:
    //   - MinerCap  (caps::new_miner_cap + transfer::public_transfer)
    //   - StakePosition (staking::create + staking::transfer_to)
    const createdCapId = extractCreatedObjectByType(minerResult, '::caps::MinerCap');
    const createdStakeId = extractCreatedObjectByType(minerResult, '::staking::StakePosition');

    if (!createdCapId) {
      logger.error({ effects: minerResult.effects }, 'Failed to extract MinerCap ID from TX effects');
      process.exit(1);
    }
    if (!createdStakeId) {
      logger.error({ effects: minerResult.effects }, 'Failed to extract StakePosition ID from TX effects');
      process.exit(1);
    }
    minerCapId = createdCapId;
    stakePositionId = createdStakeId;

    logger.info({ minerCapId, stakePositionId }, 'Miner registration succeeded');
  }

  // Voting mode: wait for CPs to vote on our role, then apply it
  if (votingMode && !alreadyVoted) {
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
  // A recovered (self-healed) registration may already be enrolled in
  // ValidatorRegistry from before the earlier crash -- register_validator
  // has no idempotency guard of its own, so check first to avoid a
  // needless abort.
  const alreadyInRegistry = await isRegisteredInValidatorRegistry(client, config, signer.toSuiAddress(), logger);
  if (!alreadyInRegistry) {
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
            tx.object(stakePositionId),             // 3 &StakePosition (from Step 1)
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

/**
 * Look up a MinerCap + StakePosition minted for this wallet by an earlier,
 * partially-completed registration attempt (mirrors relay's auto-register.ts
 * findPriorRegistration). StakePosition is a SHARED object
 * (transfer::share_object), invisible to getOwnedObjects, so the only way
 * to recover its id is from the transaction that created it. Uses GraphQL's
 * `findCreatedObjectByType` (shared/chain/events.ts), NOT
 * `client.queryTransactionBlocks`, which is deprecated JSON-RPC on devnet's
 * public fullnode. Returns null (not an error, and also when `graphqlClient`
 * is unset) if none is found -- callers fall through to minting a fresh pair.
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
