/**
 * Validator-daemon audit-loop latency probe — S23.1.A3.
 *
 * Wraps the per-room measurement body (resolve relay, fetch metrics, build
 * proof, dual-sign) with a `performance.now()` timer and emits
 * `L_validator_check` per call when `BENCH_LATENCY=1`. When unset it is a
 * thin pass-through with zero allocation in the hot path beyond an
 * already-resolved null check.
 *
 * Plan deviation note (CI-7): the S23 plan named the wrapper signature
 * `timedMeasureRoom(state, roomId, validatorMinerId, log)`, but inlining a
 * direct call to the existing `measureRoom` would create a circular import
 * between `index.ts` (defines `measureRoom`) and this module. The
 * callback-based signature below — `timedMeasureRoom(roomId, resolveRelay,
 * body)` — keeps the wrapper agnostic of `measureRoom`'s internals and
 * lets `index.ts:384` thread the right closure into it.
 *
 * Module-level singleton, mirroring `apps/cp-daemon/src/latency-probe.ts`.
 *
 * Methodology: `docs/80-research/evaluation/m1-latency-methodology.md` §3.1
 */

import { LatencyWriter, isBenchEnabled } from '@dvconf/shared';

let cachedWriter: LatencyWriter | null = null;
let initialized = false;

function ensureWriter(): LatencyWriter | null {
  if (initialized) return cachedWriter;
  initialized = true;
  if (!isBenchEnabled()) {
    cachedWriter = null;
    return null;
  }
  cachedWriter = new LatencyWriter({
    source: 'validator',
    instance: process.env['VALIDATOR_INSTANCE'] ?? 'validator-default',
  });
  return cachedWriter;
}

/**
 * Time one measurement-room body and emit `L_validator_check`.
 *
 * The `resolveRelayMinerId` callback runs in the `finally` block so the
 * relay id is captured from the *current* state at completion time (mid-cycle
 * `RoomAssigned` events may change the assignment); it may return `null`
 * when the room is still unassigned, in which case the event still records.
 *
 * If `body` throws, the duration is still recorded (with the error
 * re-thrown afterwards) so failure latency is observable too.
 */
export async function timedMeasureRoom<T>(
  roomId: string,
  resolveRelayMinerId: () => string | null,
  body: () => Promise<T>,
): Promise<T> {
  const writer = ensureWriter();
  if (writer === null) {
    return body();
  }
  const t0 = performance.now();
  try {
    return await body();
  } finally {
    writer.write('L_validator_check', performance.now() - t0, {
      room_id: roomId,
      relay_miner_id: resolveRelayMinerId(),
    });
  }
}

/** Close the writer at daemon shutdown. Idempotent. */
export function closeValidatorProbe(): void {
  if (cachedWriter !== null) {
    cachedWriter.close();
    cachedWriter = null;
    initialized = false;
  }
}
