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
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
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
  reserved_primary_count: bcs.u64(),
  reserved_standby_count: bcs.u64(),
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

/**
 * Create a new room on-chain. Returns the new room's id.
 *
 * @param graphqlClient - Optional. devnet's public fullnode returns empty
 *   `events` on the JSON-RPC execute response (event-shaped reads are
 *   deprecated there); when provided, `extractRoomId`'s `RoomCreated` lookup
 *   is backfilled via GraphQL instead of the (empty) JSON-RPC response.
 */
export async function createRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  opts: RoomProvisionOpts,
  logger: Logger,
  graphqlClient?: SuiGraphQLClient,
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
    graphqlClient,
  );

  const roomId = extractRoomId(roomResult);
  return { roomId };
}

/**
 * 1 SUI escrow deposit — mirrors scripts/demo/escrow-driver.ts's ESCROW_AMOUNT_MIST.
 * cp-daemon's room-assignment handler will not assign a relay to a room until
 * it observes this room's EscrowCreated event (see event-handlers/room-assignment.ts's
 * "waiting for escrow before assignment" gate) -- without this, resolveRoomRelayUrl
 * polls forever and the bot session never starts.
 */
const ESCROW_AMOUNT_MIST = 1_000_000_000n;

/**
 * Create the room's escrow deposit (economic_layer::create_escrow). Must be
 * called by the same signer that created the room (create_escrow asserts
 * room_creator == ctx.sender()).
 */
export async function createEscrow(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<void> {
  await signAndAssert(
    client,
    signer,
    (tx) => {
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(ESCROW_AMOUNT_MIST)]);
      tx.moveCall({
        target: `${config.packageId}::economic_layer::create_escrow`,
        arguments: [
          tx.object(config.networkRegistryId),
          tx.object(config.roomManagerId),
          tx.pure.id(roomId),
          payment!,
        ],
      });
    },
    'create_escrow',
    logger,
  );
}

/** Backward-compatible composition: register (idempotent) then create a room. */
export async function registerAndCreateRoom(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  opts: RoomProvisionOpts,
  logger: Logger,
  graphqlClient?: SuiGraphQLClient,
): Promise<RoomProvisionResult> {
  await registerUser(client, signer, config, logger);
  return createRoom(client, signer, config, opts, logger, graphqlClient);
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

/**
 * Reads `relay_registry::get_active_relays` and decodes the full list.
 * NEVER throws — the public devnet fullnode has been observed to intermittently
 * return a truncated/undecodable devInspect payload (a transient RPC-layer
 * hiccup, not a schema mismatch), which used to surface as an uncaught
 * `RangeError: Offset is outside the bounds of the DataView` straight out of
 * bcs's reader and crash the whole bot session. Treat any network OR decode
 * failure as "no active relays this attempt" (mirrors getAssignedRelayIds's
 * tolerant behavior) so the caller's poll/retry loop gets another chance
 * instead of the session dying outright.
 */
export async function getActiveRelays(
  client: SuiClient,
  config: NetworkConfig,
  logger: Logger,
): Promise<Array<{ minerId: string; endpointUrl: string }>> {
  try {
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
      logger.debug({ module: 'bot-chain', err: r.error }, 'get_active_relays errored — treating as empty');
      return [];
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
  } catch (err) {
    logger.debug({ module: 'bot-chain', err }, 'get_active_relays read/decode failed — treating as empty');
    return [];
  }
}

/**
 * Reads a SINGLE relay's `endpoint_url` directly (`relay_registry::borrow_info`
 * chained into `info_endpoint_url` in one PTB), instead of scanning the whole
 * active-relay set and filtering client-side. Used by `resolveRoomRelayUrl`
 * once cp-daemon has already assigned this exact relay to the room — at that
 * point we trust cp-daemon's own on-chain read of the registry and just need
 * the endpoint, not a second independent "is it active" opinion. This sidesteps
 * a specific failure mode seen against the public devnet fullnode where
 * `get_active_relays()`'s full-registry scan (`active_set` + a `nodes` table
 * walk) returned an empty list for 30+ consecutive seconds for a relay that
 * had registered and been heartbeating for several minutes already, while a
 * plain devInspect of this narrower per-id lookup did not exhibit the same lag.
 * NEVER throws — any network/decode failure or `E_NOT_REGISTERED` abort (miner
 * not yet visible in `nodes`) resolves `null` so the caller can retry.
 */
export async function getRelayEndpoint(
  client: SuiClient,
  config: NetworkConfig,
  minerId: string,
  logger: Logger,
): Promise<string | null> {
  try {
    const tx = new Transaction();
    const info = tx.moveCall({
      target: `${config.packageId}::relay_registry::borrow_info`,
      arguments: [tx.object(config.relayRegistryId), tx.pure.id(minerId)],
    });
    tx.moveCall({
      target: `${config.packageId}::relay_registry::info_endpoint_url`,
      arguments: [info],
    });
    const r = (await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO_ADDRESS,
    })) as DevInspectLike;
    if (r.error) {
      logger.debug({ module: 'bot-chain', minerId, err: r.error }, 'get_relay_endpoint errored — treating as not-found');
      return null;
    }
    const bytes = r.results?.[1]?.returnValues?.[0]?.[0];
    if (bytes === undefined) return null;
    const urlBytes = bcs.vector(bcs.u8()).parse(Uint8Array.from(bytes)) as number[];
    return decodeUtf8(urlBytes);
  } catch (err) {
    logger.debug({ module: 'bot-chain', minerId, err }, 'get_relay_endpoint read/decode failed — treating as not-found');
    return null;
  }
}

/**
 * Resolves the endpoint_url of every relay in assigned_relays AFTER the
 * primary (index 0), in on-chain order — not just assigned_relays[1]. A
 * relay death can chain (standby 1 dies after already being promoted to
 * active use, before cp-daemon's async promotion has rewritten the
 * assignment), so the caller must be able to try assigned_relays[2], [3],
 * etc., not just the first standby slot — mirrors cp-daemon's
 * room-health-sweep.ts, which walks assigned_relays.slice(1) rather than a
 * hardcoded index. Single-shot, no polling — used at relay-death time by
 * session.ts's handleRelayDeath to attempt an immediate standby cutover.
 * Skips (does not fail on) any id whose endpoint isn't resolvable.
 */
export async function getStandbyRelayUrls(
  client: SuiClient,
  config: NetworkConfig,
  roomId: string,
  logger: Logger,
): Promise<string[]> {
  const assignedIds = await getAssignedRelayIds(client, config, roomId, logger);
  const standbyIds = assignedIds.slice(1);
  const urls: string[] = [];
  for (const id of standbyIds) {
    const url = await getRelayEndpoint(client, config, id, logger);
    if (url) urls.push(url);
  }
  return urls;
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
 * resolve `assigned_relays[0]`'s `endpoint_url` via `getRelayEndpoint` (a
 * targeted per-id lookup, not a full active-set scan). Throws a clear error if
 * the room never gets assigned within `opts.timeoutMs` (cp-daemon might not be
 * running) or the assigned relay's endpoint never resolves within a second,
 * independent `opts.timeoutMs` budget.
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

  // Retry the per-relay endpoint lookup on its OWN fresh deadline (not the
  // remainder of the assignment wait above). Uses getRelayEndpoint's targeted
  // borrow_info/info_endpoint_url PTB rather than get_active_relays' full
  // active-set scan — the latter was observed to return an empty list for
  // 30+ consecutive seconds against the public devnet fullnode for a relay
  // that had already been registered and heartbeating for minutes, while this
  // narrower per-id lookup does not exhibit the same lag. Sharing one deadline
  // with the assignment wait also meant a slow-but-normal assignment (which
  // can itself eat most of the budget) left too little runway here.
  const endpointDeadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const endpointUrl = await getRelayEndpoint(client, config, primaryRelayId, logger);
    if (endpointUrl) {
      logger.info(
        { module: 'bot-chain', roomId, relayId: primaryRelayId, relayUrl: endpointUrl },
        'resolved room relay endpoint',
      );
      return endpointUrl;
    }
    logger.warn(
      { module: 'bot-chain', roomId, relayId: primaryRelayId },
      'assigned relay endpoint not (yet) resolvable via relay_registry::borrow_info — retrying',
    );
    if (Date.now() >= endpointDeadline) {
      throw new Error(
        `resolveRoomRelayUrl: room ${roomId}'s assigned relay ${primaryRelayId} has no resolvable ` +
          `endpoint_url in relay_registry after ${opts.timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
}
