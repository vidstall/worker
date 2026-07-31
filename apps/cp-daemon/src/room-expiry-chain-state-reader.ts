/**
 * LiveRoomExpiryChainStateReader — live implementation of the
 * {@link RoomExpiryChainReader} seam (`room-expiry-sweep.ts`).
 *
 * Mirrors {@link LiveRoomHealthChainStateReader} (`room-health-chain-state-reader.ts`):
 * wraps read-only `devInspectTransactionBlock` Move getters for the on-chain
 * bits (active room ids, status), and plain synchronous lookups against the
 * `roomTimestamps` map (fed by `recordRoomLifecycleTimestamp` in index.ts's
 * `trackedHandler`) for the wall-clock bits — no chain call for those two.
 *
 * Move getters consumed:
 *   - room_manager::get_active_room_ids(m): vector<ID>
 *   - room_manager::get_room_status_info(m, room_id): (u8, u64)
 *
 * BCS field order is LOAD-BEARING (positional) for the multi-return getter.
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type {
  RoomExpiryChainReader,
  RoomStatusInfo,
  RoomLifecycleTimestamps,
} from './room-expiry-sweep.js';

const MODULE = 'room-expiry-chain-state-reader';

/** Sender used for read-only devInspect calls (no gas, no signature). */
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** `vector<ID>` decodes to an array of 0x-addresses. */
const IdVectorSchema = bcs.vector(bcs.Address);

/** Minimal shape of a devInspect result we read (avoids importing the SDK type). */
interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

export class LiveRoomExpiryChainStateReader implements RoomExpiryChainReader {
  constructor(
    private readonly client: SuiClient,
    private readonly config: NetworkConfig,
    private readonly roomTimestamps: Map<string, RoomLifecycleTimestamps>,
    private readonly logger: Logger,
  ) {}

  /** All active (non-closed) room IDs to scan. Reads room_manager::get_active_room_ids. */
  async getActiveRoomIds(): Promise<string[]> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.config.packageId}::room_manager::get_active_room_ids`,
      arguments: [tx.object(this.config.roomManagerId)],
    });
    const r = (await this.client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;
    if (r.error) {
      this.logger.error(
        { module: MODULE, method: 'getActiveRoomIds', context: { err: r.error } },
        'get_active_room_ids devInspect failed',
      );
      throw new Error(`devInspect get_active_room_ids failed: ${r.error}`);
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) return [];
    const ids = IdVectorSchema.parse(Uint8Array.from(bytes)) as string[];
    return ids.map((id) => normalizeSuiAddress(id));
  }

  /** room_manager::get_room_status_info — (status, created_at epoch), in one read. */
  async getRoomStatusInfo(roomId: string): Promise<RoomStatusInfo> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.config.packageId}::room_manager::get_room_status_info`,
      arguments: [tx.object(this.config.roomManagerId), tx.pure.id(roomId)],
    });
    const r = (await this.client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;
    if (r.error) {
      this.logger.error(
        { module: MODULE, method: 'getRoomStatusInfo', context: { roomId, err: r.error } },
        'get_room_status_info devInspect failed',
      );
      throw new Error(`devInspect get_room_status_info failed for ${roomId}: ${r.error}`);
    }
    const statusBytes = r.results?.[0]?.returnValues?.[0]?.[0];
    const createdAtBytes = r.results?.[0]?.returnValues?.[1]?.[0];
    const status = statusBytes === undefined ? 0 : bcs.u8().parse(Uint8Array.from(statusBytes));
    const createdAtEpoch =
      createdAtBytes === undefined ? 0n : BigInt(bcs.u64().parse(Uint8Array.from(createdAtBytes)));
    return { status, createdAtEpoch };
  }

  /** Wall-clock ms this daemon observed RoomCreated for roomId, if any (no chain call). */
  getRoomCreatedAtMs(roomId: string): number | undefined {
    return this.roomTimestamps.get(roomId)?.createdAtMs;
  }

  /** Wall-clock ms this daemon observed RoomAssigned for roomId, if any (no chain call). */
  getRoomReadyAtMs(roomId: string): number | undefined {
    return this.roomTimestamps.get(roomId)?.readyAtMs;
  }
}
