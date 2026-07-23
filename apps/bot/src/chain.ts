/**
 * On-chain bootstrap: register_user (idempotent) → create_room.
 *
 * Deliberately does NOT call `room_manager::assign_relay_and_signaling` — that
 * requires an AdminCap and is already handled automatically by `cp-daemon`'s
 * `RoomCreated` event listener (`apps/cp-daemon/src/event-handler.ts` +
 * `room-assignment.ts`) as part of normal running-system behavior. The bot
 * only needs to mint the room; assignment is the network's job.
 */
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { signAndAssert, extractRoomId } from '@dvconf/shared';

export interface RoomProvisionOpts {
  expectedParticipants: number;
}

export interface RoomProvisionResult {
  roomId: string;
}

/** E_ALREADY_REGISTERED (user_registry.move) — treat as success, matching the
 *  client's `useChain.ts` `registerUser` catch logic. */
const ALREADY_REGISTERED_CODE = '540';

export async function registerAndCreateRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  opts: RoomProvisionOpts,
  logger: Logger,
): Promise<RoomProvisionResult> {
  try {
    await signAndAssert(
      client,
      signer,
      (tx) => {
        tx.moveCall({
          target: `${config.packageId}::user_registry::register_user`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.userRegistryId),
            tx.pure.vector('u8', Array.from(new TextEncoder().encode('bot'))),
          ],
        });
      },
      'register_user',
      logger,
    );
  } catch (err) {
    if (!String(err).includes(ALREADY_REGISTERED_CODE)) {
      throw err;
    }
    logger.info({ module: 'bot-chain' }, 'register_user: already registered, continuing');
  }

  const roomResult = await signAndAssert(
    client,
    signer,
    (tx) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager::create_room`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.object(config.userRegistryId),
          tx.pure.u8(0), // relay_mode: SFU
          tx.pure.u64(opts.expectedParticipants),
          tx.pure.u8(0), // room_class_hint: small
        ],
      });
    },
    'create_room',
    logger,
  );

  const roomId = extractRoomId(roomResult);
  return { roomId };
}
