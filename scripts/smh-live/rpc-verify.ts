/**
 * SMH-LIVE independent on-chain re-reads.
 *
 * Every on-chain claim in the evidence file is re-read by an INDEPENDENT Sui RPC
 * query (never a daemon log). Pure parsers (unit-tested against mocked event arrays)
 * + thin live pollers that adapt `pollRoomAssignedRelays`
 * (`apps/relay/src/__tests__/integration/live/rms-live-local.integration.test.ts:124`).
 *
 * Event field names are GROUNDED (AUDIT Step 4 + Task-3 Move re-check):
 *   room_manager::RoomAssigned  { room_id: ID, relay_ids: vector<ID>, ... }
 *   room_manager::RelayPromoted { room_id: ID, old_primary: ID, new_primary: ID, epoch: u64 }
 * (RelayPromoted confirmed at dvconf-contracts/sources/registry/room_manager.move:206-211
 *  and the cp observer apps/cp-daemon/src/index.ts:1136-1137.)
 * IDs serialize as hex strings and u64 (`epoch`) as a numeric string in `parsedJson`.
 */

import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { SuiClient } from '@mysten/sui/client';

type Ev = { type?: string; parsedJson?: unknown };

/**
 * Return the normalized `relay_ids` of the `RoomAssigned` event for `roomId`, or null
 * if none of `events` is an assignment for that room. Ids are normalized so a caller
 * can compare against normalized registered relay ids and count DISTINCT.
 */
export function parseAssignedRelays(events: Ev[], pkg: string, roomId: string): string[] | null {
  const target = normalizeSuiAddress(roomId);
  for (const ev of events) {
    if (ev.type !== `${pkg}::room_manager::RoomAssigned`) continue;
    const pj = ev.parsedJson as { room_id?: unknown; relay_ids?: unknown };
    if (
      typeof pj?.room_id === 'string' &&
      normalizeSuiAddress(pj.room_id) === target &&
      Array.isArray(pj.relay_ids)
    ) {
      return (pj.relay_ids as string[]).map((id) => normalizeSuiAddress(id));
    }
  }
  return null;
}

export interface Promotion {
  newPrimary: string;
  epoch: number;
}

/**
 * Extract `{ newPrimary, epoch }` from the `RelayPromoted` event matching BOTH the
 * room AND the given `oldPrimary` (the promotion-dedup key is per (room, oldPrimary),
 * not per-room-forever — so a second kill of the new primary fires a distinct event).
 * Returns null if no such event is present.
 */
export function parseRelayPromoted(
  events: Ev[],
  pkg: string,
  roomId: string,
  oldPrimary: string,
): Promotion | null {
  const room = normalizeSuiAddress(roomId);
  const old = normalizeSuiAddress(oldPrimary);
  for (const ev of events) {
    if (ev.type !== `${pkg}::room_manager::RelayPromoted`) continue;
    const pj = ev.parsedJson as {
      room_id?: unknown;
      old_primary?: unknown;
      new_primary?: unknown;
      epoch?: unknown;
    };
    if (
      typeof pj?.room_id === 'string' &&
      normalizeSuiAddress(pj.room_id) === room &&
      typeof pj?.old_primary === 'string' &&
      normalizeSuiAddress(pj.old_primary) === old &&
      typeof pj?.new_primary === 'string'
    ) {
      return { newPrimary: normalizeSuiAddress(pj.new_primary), epoch: Number(pj.epoch) };
    }
  }
  return null;
}

/**
 * Live poller: query `RoomAssigned` until an assignment for `roomId` lands (returning
 * its normalized relay ids) or the deadline passes. Thin boundary over `queryEvents`
 * — the parsing correctness lives in `parseAssignedRelays`.
 */
export async function readAssignedRelays(
  client: SuiClient,
  pkg: string,
  roomId: string,
  deadlineMs: number,
): Promise<string[] | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await client.queryEvents({
      query: { MoveEventType: `${pkg}::room_manager::RoomAssigned` },
      limit: 50,
      order: 'descending',
    });
    const ids = parseAssignedRelays(res.data as Ev[], pkg, roomId);
    if (ids) return ids;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

/**
 * Live poller: query `RelayPromoted` until a promotion for (roomId, oldPrimary) lands
 * or the deadline passes. Thin boundary over `queryEvents`.
 */
export async function pollRelayPromoted(
  client: SuiClient,
  pkg: string,
  roomId: string,
  oldPrimary: string,
  deadlineMs: number,
): Promise<Promotion | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const res = await client.queryEvents({
      query: { MoveEventType: `${pkg}::room_manager::RelayPromoted` },
      limit: 50,
      order: 'descending',
    });
    const p = parseRelayPromoted(res.data as Ev[], pkg, roomId, oldPrimary);
    if (p) return p;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}
