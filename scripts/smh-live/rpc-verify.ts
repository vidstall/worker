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
import { Transaction } from '@mysten/sui/transactions';
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

// ── Relay endpoint -> WS port resolver (D2 exact primary/standby, per-regenesis) ──

/**
 * Decode a BCS `vector<u8>` (ULEB128 length prefix + content bytes) to a UTF-8 string.
 * This is how `devInspect` returns `relay_registry::info_endpoint_url` — the on-chain
 * relay endpoint (e.g. `ws://127.0.0.1:4000`, registered by the native relay daemon from
 * RELAY_ENDPOINT_URL). Trailing bytes beyond the declared length are ignored.
 */
export function decodeMoveString(bytes: number[]): string {
  let i = 0;
  let len = 0;
  let shift = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    i++;
    len |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  const content = bytes.slice(i, i + len);
  return new TextDecoder().decode(new Uint8Array(content));
}

/** Parse the TCP port from a `ws(s)://host:port` endpoint (or host:port). Null if absent/invalid. */
export function parseWsPort(endpoint: string): number | null {
  const validate = (raw: string): number | null => {
    const p = Number(raw);
    return Number.isInteger(p) && p > 0 && p <= 65535 ? p : null;
  };
  try {
    const u = new URL(endpoint);
    if (u.port === '') return null;
    return validate(u.port);
  } catch {
    const m = /:(\d{1,5})(?:\/|$)/.exec(endpoint);
    return m ? validate(m[1]!) : null;
  }
}

/**
 * Live resolver: given a relay `minerId`, devInspect `relay_registry::borrow_info(registry, id)`
 * → `&RelayNodeInfo`, chain `info_endpoint_url(&RelayNodeInfo)` → `vector<u8>`, decode it and parse
 * the WS port. Returns null on any failure (unresolvable id, unparseable endpoint, RPC error).
 * This replaces the WRONG `assigned[0] == 4000` heuristic — relay ids are fresh per regenesis, so
 * the primary/standby port MUST come from chain.
 */
export async function resolveRelayWsPort(
  client: SuiClient,
  pkg: string,
  relayRegistryId: string,
  minerId: string,
): Promise<number | null> {
  try {
    const tx = new Transaction();
    const info = tx.moveCall({
      target: `${pkg}::relay_registry::borrow_info`,
      arguments: [tx.object(relayRegistryId), tx.pure.id(minerId)],
    });
    tx.moveCall({ target: `${pkg}::relay_registry::info_endpoint_url`, arguments: [info] });
    const res = await client.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: '0x0000000000000000000000000000000000000000000000000000000000000000',
    });
    // The endpoint vector<u8> is the return value of the SECOND moveCall (info_endpoint_url).
    const bytes = res.results?.[1]?.returnValues?.[0]?.[0] as number[] | undefined;
    if (!bytes) return null;
    return parseWsPort(decodeMoveString(bytes));
  } catch {
    return null;
  }
}
