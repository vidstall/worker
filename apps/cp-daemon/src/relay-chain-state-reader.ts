/**
 * LiveRelayChainStateReader — live implementation of the
 * {@link RelayChainStateReader} seam (M1 Phase 3.1, REQ-RO-009 / C3).
 *
 * Mirrors {@link SuiChainStateReader} (F47 Phase 4.0): wraps read-only
 * `devInspectTransactionBlock` Move getters so the {@link RelayHeartbeatWatcher}
 * decision logic can run against a real chain. No TX is signed or submitted here.
 *
 * Move getters consumed (verified against dvconf-contracts/sources/registry):
 *   - room_manager::get_active_room_ids(m): vector<ID>          → getActiveRoomIds()
 *   - room_manager::get_room_assignment(m, room_id): (vector<ID>, Option<ID>)
 *                                                              → getAssignedRelays()
 *   - relay_registry::get_active_relays(r): vector<RelayNodeInfo>
 *                                          → getRelayLastHeartbeats() (match by miner_id)
 *
 * BCS field order is LOAD-BEARING (positional). RelayNodeInfoSchema mirrors the
 * deployed relay_registry::RelayNodeInfo struct order EXACTLY — identical to the
 * schema in sui-chain-state-reader.ts (kept independent so the two readers stay
 * decoupled; a divergence would surface in the live integration smoke).
 *
 * Structured logging only (pino child via injected Logger). No console.*, no
 * hardcoded ids/urls — every id comes from the injected {@link NetworkConfig}.
 *
 * Implements REQ-RO-009 (read seam).
 */

import type { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import type { RelayChainStateReader } from './relay-heartbeat-watcher.js';

const MODULE = 'relay-chain-state-reader';

/** Sender used for read-only devInspect calls (no gas, no signature). */
const ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * relay_registry::RelayNodeInfo — field order mirrors the deployed Move struct
 * (same as sui-chain-state-reader.ts RelayNodeInfoSchema).
 */
const RelayNodeInfoSchema = bcs.struct('RelayNodeInfo', {
  operator: bcs.Address,
  miner_id: bcs.Address,
  stake_amount: bcs.u64(),
  reputation: bcs.u64(),
  registered_at: bcs.u64(),
  last_heartbeat: bcs.u64(),
  region: bcs.vector(bcs.u8()),
  endpoint_url: bcs.vector(bcs.u8()),
});

/** `vector<ID>` decodes to an array of 0x-addresses. */
const IdVectorSchema = bcs.vector(bcs.Address);

/** Minimal shape of a devInspect result we read (avoids importing the SDK type). */
interface DevInspectLike {
  error?: string | null;
  results?: Array<{ returnValues?: Array<[number[], string]> } | undefined> | null;
}

export class LiveRelayChainStateReader implements RelayChainStateReader {
  constructor(
    private readonly client: SuiClient,
    private readonly config: NetworkConfig,
    private readonly logger: Logger,
  ) {}

  /** Current Sui epoch (straight from the system state — no Move call). */
  async getCurrentEpoch(): Promise<bigint> {
    const s = await this.client.getLatestSuiSystemState();
    const epoch = BigInt(s.epoch);
    this.logger.debug(
      { module: MODULE, method: 'getCurrentEpoch', epoch: epoch.toString() },
      'read current epoch',
    );
    return epoch;
  }

  /**
   * Per-relay last_heartbeat for all relays assigned to a room. Reads the global
   * active-relays vector once, indexes by miner_id, then projects the room's
   * assigned relays onto their heartbeats. Relays not in the active set (e.g. a
   * dead relay dropped from active_count) report lastHeartbeat 0n so the watcher
   * treats them as maximally stale.
   */
  async getRelayLastHeartbeats(
    roomId: string,
  ): Promise<Array<{ relayId: string; lastHeartbeat: bigint }>> {
    const [assigned, activeRelays] = await Promise.all([
      this.getAssignedRelays(roomId),
      this.readActiveRelays(),
    ]);
    const hbByRelay = new Map(
      activeRelays.map((r) => [normalizeSuiAddress(r.miner_id), BigInt(r.last_heartbeat)]),
    );
    const out = assigned.map((relayId) => ({
      relayId,
      lastHeartbeat: hbByRelay.get(normalizeSuiAddress(relayId)) ?? 0n,
    }));
    this.logger.debug(
      { module: MODULE, method: 'getRelayLastHeartbeats', context: { roomId, count: out.length } },
      'read relay heartbeats for room',
    );
    return out;
  }

  /**
   * Assigned relays for the room: assigned_relays[0]=primary, [1]=standby.
   * Reads room_manager::get_room_assignment, whose first return value is the
   * `vector<ID>` we want (the second is the signaling Option<ID>, ignored).
   * Returns [] if the room is unassigned or the call errors.
   */
  async getAssignedRelays(roomId: string): Promise<string[]> {
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
          { module: MODULE, method: 'getAssignedRelays', context: { roomId, err: r.error } },
          'get_room_assignment errored — treating as unassigned',
        );
        return [];
      }
      // First return value [0] = assigned_relays vector<ID>.
      const bytes = r.results?.[0]?.returnValues?.[0]?.[0];
      if (bytes === undefined) return [];
      const ids = IdVectorSchema.parse(Uint8Array.from(bytes)) as string[];
      return ids.map((id) => normalizeSuiAddress(id));
    } catch (err) {
      this.logger.debug(
        { module: MODULE, method: 'getAssignedRelays', context: { roomId, err } },
        'get_room_assignment read failed — treating as unassigned',
      );
      return [];
    }
  }

  /** All active (non-closed) room IDs to scan. Reads room_manager::get_active_room_ids. */
  async getActiveRoomIds(): Promise<string[]> {
    const bytes = await this.devInspectBytes(
      `${this.config.packageId}::room_manager::get_active_room_ids`,
      this.config.roomManagerId,
    );
    const ids = IdVectorSchema.parse(Uint8Array.from(bytes)) as string[];
    const normalized = ids.map((id) => normalizeSuiAddress(id));
    this.logger.debug(
      { module: MODULE, method: 'getActiveRoomIds', context: { count: normalized.length } },
      'read active room ids',
    );
    return normalized;
  }

  // ── private helpers ────────────────────────────────────────────────────

  /** Decode the global active-relays vector once (shared by getRelayLastHeartbeats). */
  private async readActiveRelays(): Promise<Array<{ miner_id: string; last_heartbeat: string }>> {
    const bytes = await this.devInspectBytes(
      `${this.config.packageId}::relay_registry::get_active_relays`,
      this.config.relayRegistryId,
    );
    return bcs.vector(RelayNodeInfoSchema).parse(Uint8Array.from(bytes)) as unknown as Array<{
      miner_id: string;
      last_heartbeat: string;
    }>;
  }

  /**
   * devInspect a getter that takes a single shared-object arg and returns a
   * single value; returns the raw return-value bytes. Throws (logged) on
   * devInspect error or missing results.
   */
  private async devInspectBytes(target: string, objectId: string): Promise<number[]> {
    const tx = new Transaction();
    tx.moveCall({ target, arguments: [tx.object(objectId)] });
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
