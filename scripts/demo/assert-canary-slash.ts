/**
 * Stage-5 on-chain proof assertion (consolidated E2E demo, REQ-CMD-8).
 * The proven shape (STEP3-WAN-SLASH-EVIDENCE.md): a CanaryDivergenceSlashed event with
 * attester_count >= 2 AND >= 2 DISTINCT attester_ids (on-chain VecSet dedup by miner_id),
 * scoped to the shared roomId, observed_present=true (TAMPER, present-but-different).
 */
export interface CanarySlashEvent {
  attester_count?: string | number;
  attester_ids?: string[];
  relay_miner_id?: string;
  room_id?: string;
  canary_id?: string | number;
  frame_seq?: string | number;
  observed_present?: boolean;
}

export interface SlashAssertResult {
  ok: boolean;
  distinct?: number;
  reason?: string;
}

export function assertCanarySlash(ev: CanarySlashEvent, expectedRoomId: string): SlashAssertResult {
  const count = Number(ev.attester_count ?? 0);
  const ids = ev.attester_ids ?? [];
  const distinct = new Set(ids).size;
  if (count < 2) return { ok: false, reason: `attester_count ${count} < 2` };
  if (distinct < 2) return { ok: false, reason: `only ${distinct} distinct attester_ids (need >=2)` };
  if (ev.room_id !== expectedRoomId) {
    return { ok: false, reason: `room_id ${ev.room_id} != shared roomId ${expectedRoomId}` };
  }
  if (ev.observed_present !== true) return { ok: false, reason: 'observed_present != true (expected a TAMPER)' };
  return { ok: true, distinct };
}
