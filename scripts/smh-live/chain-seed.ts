/**
 * SMH-LIVE orchestrator — on-chain user-side ops (reuse @dvconf/shared primitives;
 * do NOT hand-roll): fresh-config reload, funded-user creation, room + escrow
 * seeding, and registration-readiness polling.
 *
 * Split out of run-smh-live.ts (pure code movement, no behavior change).
 */

import * as fs from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { requestSuiFromFaucetV2, getFaucetHost } from '@mysten/sui/faucet';
import {
  createGraphQLClient,
  loadNetworkConfig,
  executeWithRetry,
  type NetworkConfig,
  type Logger,
} from '../../packages/shared/src/index.js';
import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { DAEMONS_ENV, sleep } from './infra-control.js';

/**
 * Reload the freshly-written daemons .env into process.env (OVERRIDE: a prior phase's stale
 * ids must lose — `loadNetworkConfig` only dotenv-loads CWD/../../.env without override), then
 * reuse `loadNetworkConfig` to assemble the NetworkConfig from process.env (not hand-rolled).
 */
export function loadFreshConfig(): NetworkConfig {
  const raw = fs.readFileSync(DAEMONS_ENV, 'utf8');
  const setKeys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) {
      process.env[m[1]!] = m[2]!;
      setKeys.push(m[1]!);
    }
  }
  const config = loadNetworkConfig();
  // CRITICAL (D1b fix): delete the keys we just set so they DON'T leak into the NEXT boot's ps1
  // daemon children. execFileSync inherits THIS process.env, and the daemons' dotenv is
  // override:false — an inherited stale PACKAGE_ID from the prior phase's (torn-down, regenesis'd)
  // chain would win over the fresh .env, making every daemon fail "Package object does not exist"
  // (registration stuck at 0/0/0). The returned `config` is a plain object, so cleanup is safe.
  for (const k of setKeys) delete process.env[k];
  return config;
}

export async function createFundedUser(logger: Logger): Promise<Ed25519Keypair> {
  const kp = Ed25519Keypair.generate();
  await requestSuiFromFaucetV2({ host: getFaucetHost('localnet'), recipient: kp.getPublicKey().toSuiAddress() });
  await sleep(2000); // gas coin queryable before the first TX
  logger.info({ addr: kp.getPublicKey().toSuiAddress() }, 'funded user keypair');
  return kp;
}

export async function registerUser(client: SuiClient, kp: Ed25519Keypair, config: NetworkConfig, logger: Logger): Promise<void> {
  await executeWithRetry(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::user_registry::register_user`,
        arguments: [tx.object(config.networkRegistryId), tx.object(config.userRegistryId), tx.pure.vector('u8', [115, 109, 104])],
      });
    },
    'register_user',
    logger,
  );
}

/** create_room (pattern scripts/load-test.ts) → the created Room object id (== RoomAssigned.room_id). */
export async function createRoom(
  client: SuiClient,
  kp: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
  graphqlClient: SuiGraphQLClient,
): Promise<string> {
  const result = await executeWithRetry(
    client,
    kp,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(config.userRegistryId),
          tx.pure.u8(0), // relay_mode = SFU
          tx.pure.u64(2), // expected_participants (floors required_validators to 4)
          tx.pure.u8(0), // room_class_hint = small
        ],
      });
    },
    'create_room',
    logger,
    graphqlClient,
  );
  if (!result) throw new Error('create_room failed');
  // create_room stores the room in the RoomManager TABLE (no standalone Room object — verified
  // room_manager.move + rms-live-local test), so the id comes from the RoomCreated event, NOT
  // extractCreatedObjectByType. Normalize so it matches rpc-verify's normalized RoomAssigned.room_id.
  const events = result.events ?? [];
  const evt = events.find(
    (e) => typeof e['type'] === 'string' && (e['type'] as string).includes('::room_manager::RoomCreated'),
  );
  const rawRoomId = (evt?.['parsedJson'] as { room_id?: unknown } | undefined)?.room_id;
  if (typeof rawRoomId !== 'string') throw new Error('create_room: RoomCreated event missing room_id');
  return normalizeSuiAddress(rawRoomId);
}

/** create_escrow (pattern scripts/load-test.ts:126-159) — the NATIVE placement trigger (EscrowCreated). */
export async function createEscrow(client: SuiClient, kp: Ed25519Keypair, config: NetworkConfig, roomId: string, logger: Logger): Promise<void> {
  await executeWithRetry(
    client,
    kp,
    (tx) => {
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(1_000_000_000n)]); // 1 DVCONF
      tx.moveCall({
        target: `${config.packageId}::economic_layer::create_escrow`,
        arguments: [tx.object(config.networkRegistryId), tx.object(config.roomManagerId), tx.pure.address(roomId), payment!],
      });
    },
    'create_escrow',
    logger,
  );
}

/** Register a fresh user + create a room + create its escrow (the placement trigger). Returns the room id. */
export async function seedRoom(client: SuiClient, config: NetworkConfig, logger: Logger): Promise<string> {
  const user = await createFundedUser(logger);
  await registerUser(client, user, config, logger);
  const graphqlClient = createGraphQLClient('localnet');
  const roomId = await createRoom(client, user, config, logger, graphqlClient);
  await createEscrow(client, user, config, roomId, logger);
  return roomId;
}

// ── Registration readiness (devInspect active-count getters) ───────────

/** devInspect a `public fun <module>::<fn>(&Registry): u64` and parse the u64 (LE bytes). */
export async function activeCount(client: SuiClient, packageId: string, moduleFn: string, registryId: string): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({ target: `${packageId}::${moduleFn}`, arguments: [tx.object(registryId)] });
  const res = await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
  });
  const bytes = (res.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[];
  let n = 0;
  for (let i = 0; i < bytes.length; i++) n += bytes[i]! * Math.pow(256, i);
  return n;
}

export interface ActiveCounts {
  relays: number;
  validators: number;
}

/**
 * Poll on-chain active counts until >=3 relays + >=4 validators (ballot floor), or
 * deadline. The native daemons self-register asynchronously (voting flow) AFTER `daemons` returns;
 * seeding the room BEFORE they are up makes the cp defer at "No relays available" and the escrow
 * re-drive only fires on RelayRegistered (NOT ValidatorRegistered), so we must gate on full readiness.
 * (The standalone signaling node type was removed from the contract, so there is no signaling
 * count to gate on anymore.)
 */
export async function waitForRegistration(client: SuiClient, config: NetworkConfig, logger: Logger, deadlineMs: number): Promise<ActiveCounts> {
  const deadline = Date.now() + deadlineMs;
  let counts: ActiveCounts = { relays: 0, validators: 0 };
  while (Date.now() < deadline) {
    try {
      counts = {
        relays: await activeCount(client, config.packageId, 'relay_registry::active_count', config.relayRegistryId),
        validators: await activeCount(client, config.packageId, 'validator_registry::active_count', config.validatorRegistryId),
      };
      logger.info({ ...counts }, 'registration readiness poll');
      if (counts.relays >= 3 && counts.validators >= 4) return counts;
    } catch (err) {
      logger.debug({ err }, 'readiness poll failed — retrying');
    }
    await sleep(5000);
  }
  return counts;
}
