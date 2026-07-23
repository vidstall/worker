/**
 * On-chain bootstrap for the bot: register_user (idempotent) → create_room,
 * plus relay-assignment resolution so a session can join the room's REAL
 * relay endpoint instead of a static env var (the topology has multiple
 * relays; a static RELAY_URL is usually wrong for a given room).
 *
 * Deliberately does NOT call `room_manager::assign_relay_and_signaling` — that
 * requires an AdminCap and is already handled automatically by `cp-daemon`'s
 * `RoomCreated` event listener (`apps/cp-daemon/src/event-handler.ts` +
 * `room-assignment.ts`) as part of normal running-system behavior. The bot
 * only needs to mint the room; assignment is the network's job.
 *
 * BCS layouts below mirror the deployed Move structs EXACTLY (positional
 * decode — a missing trailing field silently desyncs every field after the
 * divergence). Cross-checked against:
 *   - services/client/admin/src/hooks/dashboard/useActiveRooms.ts (RoomInfo)
 *   - services/client/admin/src/hooks/dashboard/useRegistryOverview.ts (RelayNodeInfo)
 *   - apps/cp-daemon/src/relay-chain-state-reader.ts (get_room_assignment usage)
 */
import type { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { signAndAssert, extractRoomId } from '@dvconf/shared';

/** Sender used for read-only devInspect calls (no gas, no signature). */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000000000000000000000000000';

export interface RoomProvisionOpts {
  expectedParticipants: number;
}

export interface RoomProvisionResult {
  roomId: string;
}

/** E_ALREADY_REGISTERED (user_registry.move) — treat as success, matching the
 *  client's `useChain.ts` `registerUser` catch logic. */
const ALREADY_REGISTERED_CODE = '540';

/** `vector<ID>` decodes to an array of 0x-addresses. */
const IdVectorSchema = bcs.vector(bcs.Address);

/**
 * relay_registry::RelayNodeInfo — field order mirrors the deployed Move
 * struct (matches useRegistryOverview.ts's RelayNodeInfoBcs exactly).
 */
const RelayNodeInfoBcs = bcs.struct('RelayNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  region: bcs.vector(bcs.u8()),
  endpoint_url: bcs.vector(bcs.u8()),
});

interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

function decodeUtf8(bytes: number[]): string {
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Register the bot as a user. Idempotent — swallows E_ALREADY_REGISTERED. */
export async function registerUser(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): Promise<void> {
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
}

/** Create a new room on-chain. Returns the new room's id. */
export async function createRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  opts: RoomProvisionOpts,
  logger: Logger,
): Promise<RoomProvisionResult> {
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

/** Backward-compatible composition: register (idempotent) then create a room. */
export async function registerAndCreateRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  opts: RoomProvisionOpts,
  logger: Logger,
): Promise<RoomProvisionResult> {
  await registerUser(client, signer, config, logger);
  return createRoom(client, signer, config, opts, logger);
}

/**
 * Reads `room_manager::get_room_assignment`'s first return value
 * (`assigned_relays: vector<ID>`). Returns [] if the room is unassigned, not
 * found, or the call errors (mirrors LiveRelayChainStateReader's tolerant
 * behavior in apps/cp-daemon/src/relay-chain-state-reader.ts).
 */
export async function getAssignedRelayIds(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<string[]> {
  try {
    const tx = new Transaction();
    tx.moveCall({
      target: `${config.packageId}::room_manager::get_room_assignment`,
      arguments: [tx.object(config.roomManagerId), tx.pure.id(roomId)],
    });
    const r = (await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO_ADDRESS,
    })) as DevInspectLike;
    if (r.error) {
      logger.debug(
        { module: 'bot-chain', roomId, err: r.error },
        'get_room_assignment errored — treating as unassigned',
      );
      return [];
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) return [];
    const ids = IdVectorSchema.parse(Uint8Array.from(bytes)) as string[];
    return ids.map((id) => normalizeSuiAddress(id));
  } catch (err) {
    logger.debug(
      { module: 'bot-chain', roomId, err },
      'get_room_assignment read failed — treating as unassigned',
    );
    return [];
  }
}

/** Reads `relay_registry::get_active_relays` and decodes the full list. */
export async function getActiveRelays(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<Array<{ minerId: string; endpointUrl: string }>> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${config.packageId}::relay_registry::get_active_relays`,
    arguments: [tx.object(config.relayRegistryId)],
  });
  const r = (await client.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: ZERO_ADDRESS,
  })) as DevInspectLike;
  if (r.error) {
    throw new Error(`devInspect relay_registry::get_active_relays failed: ${r.error}`);
  }
  const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
  if (bytes === undefined) {
    logger.debug({ module: 'bot-chain' }, 'get_active_relays returned no values');
    return [];
  }
  const decoded = bcs.vector(RelayNodeInfoBcs).parse(Uint8Array.from(bytes)) as Array<{
    miner_id: string;
    endpoint_url: number[];
  }>;
  return decoded.map((r2) => ({
    minerId: normalizeSuiAddress(r2.miner_id),
    endpointUrl: decodeUtf8(r2.endpoint_url),
  }));
}

export interface ResolveRelayEndpointOpts {
  /** Max time to poll for an assignment before giving up. */
  timeoutMs: number;
  /** Delay between poll attempts. */
  pollIntervalMs: number;
}

export const CREATE_ROOM_POLL_OPTS: ResolveRelayEndpointOpts = { timeoutMs: 30_000, pollIntervalMs: 2_000 };
export const JOIN_ROOM_POLL_OPTS: ResolveRelayEndpointOpts = { timeoutMs: 10_000, pollIntervalMs: 1_000 };

/**
 * Poll `get_room_assignment` until `assigned_relays` is non-empty (cp-daemon's
 * `RoomCreated` listener sets this asynchronously after room creation), then
 * cross-reference `assigned_relays[0]` against `get_active_relays()`'s
 * `miner_id` to resolve the real `wss://...` endpoint. Throws a clear error
 * if the room never gets assigned within `opts.timeoutMs` (cp-daemon might
 * not be running) or the assigned relay isn't found in the active-relay set.
 */
export async function resolveRoomRelayUrl(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
  opts: ResolveRelayEndpointOpts,
): Promise<string> {
  const deadline = Date.now() + opts.timeoutMs;
  let assignedIds: string[] = [];

  for (;;) {
    assignedIds = await getAssignedRelayIds(client, config, roomId, logger);
    if (assignedIds.length > 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `resolveRoomRelayUrl: room ${roomId} was not assigned a relay within ${opts.timeoutMs}ms ` +
          `— is cp-daemon running? (its RoomCreated listener performs the assignment)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }

  const primaryRelayId = assignedIds[0]!;
  const activeRelays = await getActiveRelays(client, config, logger);
  const match = activeRelays.find((r) => r.minerId === primaryRelayId);
  if (!match) {
    throw new Error(
      `resolveRoomRelayUrl: room ${roomId}'s assigned relay ${primaryRelayId} was not found in ` +
        `relay_registry::get_active_relays() (${activeRelays.length} active relays)`,
    );
  }
  logger.info(
    { module: 'bot-chain', roomId, relayId: primaryRelayId, relayUrl: match.endpointUrl },
    'resolved room relay endpoint',
  );
  return match.endpointUrl;
}
