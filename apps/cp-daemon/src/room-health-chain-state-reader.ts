/**
 * LiveRoomHealthChainStateReader — live implementation of the
 * {@link RoomHealthChainReader} seam (`room-health-sweep.ts`).
 *
 * Mirrors {@link LiveRelayChainStateReader} (`relay-chain-state-reader.ts`):
 * wraps read-only `devInspectTransactionBlock` Move getters. No TX is signed
 * or submitted here.
 *
 * Move getters consumed:
 *   - room_manager::get_active_room_ids(m): vector<ID>
 *   - room_manager::get_room_assignment(m, room_id): (vector<ID>, Option<ID>)
 *   - relay_registry::get_active_relays(r): vector<RelayNodeInfo>
 *   - signaling_registry::get_active_nodes(r): vector<SignalingNodeInfo>
 *
 * BCS field order is LOAD-BEARING (positional). Schemas mirror the deployed
 * Move structs EXACTLY — same layout as `sui-chain-state-reader.ts` /
 * `relay-chain-state-reader.ts`, kept as independent copies so the readers
 * stay decoupled (a divergence would surface in the live integration smoke).
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type { RoomHealthChainReader, RoomAssignmentSnapshot, RegistryNodeHeartbeat } from './room-health-sweep.js';

const MODULE = 'room-health-chain-state-reader';

/** Sender used for read-only devInspect calls (no gas, no signature). */
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

/** relay_registry::RelayNodeInfo — field order mirrors the deployed Move struct. */
const RelayNodeInfoSchema = bcs.struct('RelayNodeInfo', {
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

/** signaling_registry::SignalingNodeInfo — field order mirrors the deployed Move struct. */
const SignalingNodeInfoSchema = bcs.struct('SignalingNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  last_heartbeat: bcs.u64(),
  is_active: bcs.bool(),
  endpoint_url: bcs.vector(bcs.u8()),
  region: bcs.vector(bcs.u8()),
  load: bcs.u64(),
  registered_at: bcs.u64(),
});

/** `vector<ID>` decodes to an array of 0x-addresses. */
const IdVectorSchema = bcs.vector(bcs.Address);
/** `Option<ID>` — the second return value of get_room_assignment. */
const IdOptionSchema = bcs.option(bcs.Address);

/** Minimal shape of a devInspect result we read (avoids importing the SDK type). */
interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

export class LiveRoomHealthChainStateReader implements RoomHealthChainReader {
  constructor(
    private readonly client: SuiClient,
    private readonly config: NetworkConfig,
    private readonly logger: Logger,
  ) {}

  /** Current Sui epoch (straight from the system state — no Move call). */
  async getCurrentEpoch(): Promise<bigint> {
    const s = await this.client.getLatestSuiSystemState();
    return BigInt(s.epoch);
  }

  /** All active (non-closed) room IDs to scan. Reads room_manager::get_active_room_ids. */
  async getActiveRoomIds(): Promise<string[]> {
    const bytes = await this.devInspectBytes(
      `${this.config.packageId}::room_manager::get_active_room_ids`,
      [this.config.roomManagerId],
    );
    const ids = IdVectorSchema.parse(Uint8Array.from(bytes)) as string[];
    const normalized = ids.map((id) => normalizeSuiAddress(id));
    this.logger.debug(
      { module: MODULE, method: 'getActiveRoomIds', context: { count: normalized.length } },
      'read active room ids',
    );
    return normalized;
  }

  /**
   * assigned_relays + assigned_signaling for the room, in one read.
   * Returns { relays: [], signaling: null } if unassigned or the call errors.
   */
  async getRoomAssignment(roomId: string): Promise<RoomAssignmentSnapshot> {
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.config.packageId}::room_manager::get_room_assignment`,
        arguments: [tx.object(this.config.roomManagerId), tx.pure.id(roomId)],
      });
      const r = (await this.client.devInspectTransactionBlock({
        transactionBlock: tx,
        sender: ZERO,
      })) as DevInspectLike;
      if (r.error) {
        this.logger.debug(
          { module: MODULE, method: 'getRoomAssignment', context: { roomId, err: r.error } },
          'get_room_assignment errored — treating as unassigned',
        );
        return { relays: [], signaling: null };
      }
      const relayBytes = r.results?.[0]?.returnValues?.[0]?.[0];
      const sigBytes = r.results?.[0]?.returnValues?.[1]?.[0];
      const relays =
        relayBytes === undefined
          ? []
          : (IdVectorSchema.parse(Uint8Array.from(relayBytes)) as string[]).map((id) => normalizeSuiAddress(id));
      const sigOpt = sigBytes === undefined ? null : (IdOptionSchema.parse(Uint8Array.from(sigBytes)) as string | null);
      const signaling = sigOpt === null ? null : normalizeSuiAddress(sigOpt);
      return { relays, signaling };
    } catch (err) {
      this.logger.debug(
        { module: MODULE, method: 'getRoomAssignment', context: { roomId, err } },
        'get_room_assignment read failed — treating as unassigned',
      );
      return { relays: [], signaling: null };
    }
  }

  /** relay_registry::get_active_relays, projected to id + heartbeat. */
  async getActiveRelayPool(): Promise<RegistryNodeHeartbeat[]> {
    const bytes = await this.devInspectBytes(
      `${this.config.packageId}::relay_registry::get_active_relays`,
      [this.config.relayRegistryId],
    );
    const nodes = bcs.vector(RelayNodeInfoSchema).parse(Uint8Array.from(bytes)) as unknown as Array<{
      miner_id: string;
      last_heartbeat: string;
    }>;
    return nodes.map((n) => ({ minerId: normalizeSuiAddress(n.miner_id), lastHeartbeat: BigInt(n.last_heartbeat) }));
  }

  /** signaling_registry::get_active_nodes, projected to id + heartbeat. */
  async getActiveSignalingPool(): Promise<RegistryNodeHeartbeat[]> {
    const bytes = await this.devInspectBytes(
      `${this.config.packageId}::signaling_registry::get_active_nodes`,
      [this.config.signalingRegistryId],
    );
    const nodes = bcs.vector(SignalingNodeInfoSchema).parse(Uint8Array.from(bytes)) as unknown as Array<{
      miner_id: string;
      last_heartbeat: string;
    }>;
    return nodes.map((n) => ({ minerId: normalizeSuiAddress(n.miner_id), lastHeartbeat: BigInt(n.last_heartbeat) }));
  }

  // ── private helpers ────────────────────────────────────────────────────

  /**
   * devInspect a getter that takes shared-object args and returns a single
   * value; returns the raw return-value bytes. Throws (logged) on devInspect
   * error or missing results.
   */
  private async devInspectBytes(target: string, objectIds: string[]): Promise<number[]> {
    const tx = new Transaction();
    tx.moveCall({ target, arguments: objectIds.map((id) => tx.object(id)) });
    const r = (await this.client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: ZERO,
    })) as DevInspectLike;
    if (r.error) {
      const msg = `devInspect ${target} failed: ${r.error}`;
      this.logger.error({ module: MODULE, target, err: r.error }, msg);
      throw new Error(msg);
    }
    const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
    if (bytes === undefined) {
      const msg = `devInspect ${target} returned no values`;
      this.logger.error({ module: MODULE, target }, msg);
      throw new Error(msg);
    }
    return bytes;
  }
}
