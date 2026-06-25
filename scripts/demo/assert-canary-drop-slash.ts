// scripts/demo/assert-canary-drop-slash.ts  (NEW — B-WAN, REQ-MLW-B-18)
// assertCanarySlash hard-requires observed_present===true (TAMPER). A DROP/withholding slash has
// observed_present=false, so the DROP acceptance needs this variant. Same >=2-distinct + room checks.
import type { CanarySlashEvent, SlashAssertResult } from './assert-canary-slash.ts';

export function assertCanaryDropSlash(ev: CanarySlashEvent, expectedRoomId: string): SlashAssertResult {
  const count = Number(ev.attester_count ?? 0);
  const ids = ev.attester_ids ?? [];
  const distinct = new Set(ids).size;
  if (count < 2) return { ok: false, reason: `attester_count ${count} < 2` };
  if (distinct < 2) return { ok: false, reason: `only ${distinct} distinct attester_ids (need >=2)` };
  if (ev.room_id !== expectedRoomId) {
    return { ok: false, reason: `room_id ${ev.room_id} != shared roomId ${expectedRoomId}` };
  }
  if (ev.observed_present !== false) return { ok: false, reason: 'observed_present != false (expected a DROP/withholding)' };
  return { ok: true, distinct };
}
