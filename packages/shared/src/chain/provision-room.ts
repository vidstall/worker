/**
 * provision-room — committed, non-test lifecycle for register_user → create_room →
 * assign_relay_and_signaling. EXTRACTED from validator-daemon's __tests__ canary-localnet-helpers.ts
 * so BOTH that test helper AND scripts/demo/provision-room.ts import ONE source (no drift).
 * fundAddress is INJECTED (the sole test-fixture coupling) so this module stays test-free.
 * Move sigs verbatim: user_registry.move:63, room_manager.move:247, room_manager.move:644.
 */
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { NetworkConfig, Logger } from '../index.js';

const MODULE = 'provision-room';
const GAS_BUDGET = 100_000_000;

interface SuiObjectChange { type: string; objectId?: string; objectType?: string; }

export interface TxStatusLike {
  effects?: { status?: { status?: string; error?: string } };
  objectChanges?: SuiObjectChange[];
  events?: Array<{ type?: string; parsedJson?: unknown }>;
  digest: string;
}

/** Sign+execute a built TX, wait for finality, assert success. */
export async function signAndAssert(
  client: SuiClient,
  signer: Ed25519Keypair,
  build: (tx: Transaction) => void,
  label: string,
  logger: Logger,
): Promise<TxStatusLike> {
  const tx = new Transaction();
  build(tx);
  tx.setGasBudget(GAS_BUDGET);
  const result = (await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  })) as unknown as TxStatusLike;
  await client.waitForTransaction({
    digest: result.digest,
    options: { showEffects: true, showObjectChanges: true },
  });
  const status = result.effects?.status?.status;
  if (status !== 'success') {
    const err = result.effects?.status?.error ?? '(no error string)';
    throw new Error(`${label} failed on-chain: status=${status ?? 'unknown'} error=${err}`);
  }
  logger.info({ module: MODULE, action: label, context: { digest: result.digest } }, `${label} succeeded on-chain`);
  return result;
}

/** Read the RoomCreated event's room_id. */
export function extractRoomId(result: TxStatusLike): string {
  const evt = (result.events ?? []).find((e) => (e.type ?? '').includes('::room_manager::RoomCreated'));
  const roomId = (evt?.parsedJson as { room_id?: unknown })?.room_id;
  if (typeof roomId !== 'string') {
    throw new Error('extractRoomId: RoomCreated event missing or malformed');
  }
  return normalizeSuiAddress(roomId);
}

/**
 * Register a USER, create a room (SFU, 2 participants, room_class_hint=0), and AdminCap-assign
 * relayMinerId to it. fundAddress faucets the fresh user. Returns the room ID.
 */
export async function createRoomWithRelay(
  client: SuiClient,
  userKp: Ed25519Keypair,
  deployer: Ed25519Keypair,
  adminCapId: string,
  relayMinerId: string,
  config: NetworkConfig,
  logger: Logger,
  fundAddress: (address: string) => Promise<void>,
): Promise<string> {
  await fundAddress(userKp.getPublicKey().toSuiAddress());
  await new Promise((r) => setTimeout(r, 1500));

  await signAndAssert(client, userKp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::user_registry::register_user`,
      arguments: [tx.object(config.networkRegistryId), tx.object(config.userRegistryId), tx.pure.vector('u8', [99])],
    });
  }, 'register_user', logger);

  const roomResult = await signAndAssert(client, userKp, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::room_manager::create_room`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roomManagerId),
        tx.object(config.userRegistryId),
        tx.pure.u8(0), // relay_mode SFU
        tx.pure.u64(2), // expected_participants
        tx.pure.u8(0), // room_class_hint = small
      ],
    });
  }, 'create_room', logger);
  const roomId = extractRoomId(roomResult);

  await signAndAssert(client, deployer, (tx) => {
    tx.moveCall({
      target: `${config.packageId}::room_manager::assign_relay_and_signaling`,
      arguments: [
        tx.object(config.networkRegistryId),
        tx.object(config.roomManagerId),
        tx.object(adminCapId),
        tx.pure.id(roomId),
        tx.pure.id(relayMinerId),
        tx.pure.id(relayMinerId), // signaling_id placeholder
      ],
    });
  }, 'assign_relay_and_signaling', logger);

  logger.info({ module: MODULE, action: 'create_room_with_relay', context: { roomId, relayMinerId } }, 'room created + relay assigned');
  return roomId;
}
