// apps/validator-daemon/src/canary/cohome-capture.ts  (NEW — B-WAN, REQ-MLW-B-18 SECONDARY k>=2, W-M3-SIM)
// Present a single real CanaryForwardCapture under TWO distinct receiver miner_ids so the classifier's
// SECONDARY cross-receiver signal can fire on the live drop-stream. Co-homing is SIMULATED (W-M3-SIM,
// as loss-classifier.ts documents): the SAME captured bytes are keyed under both ids. The PRIMARY
// cumulative bound carries the genuine real-drop-rate signal. Full physical multi-homing = C2 (deferred).
import type { CanaryForwardCapture } from './verify-loop.js';

export function coHomeCapture(base: CanaryForwardCapture, receiverIdB: string): CanaryForwardCapture {
  return async (scope) => {
    const r = await base(scope);
    const keys = [...r.perReceiver.keys()];
    if (keys.length !== 1) return r;                 // already co-homed or empty — leave as-is
    const frames = r.perReceiver.get(keys[0]!)!;
    r.perReceiver.set(receiverIdB, frames.map((p) => Buffer.from(p)));  // copy under a distinct key
    return r;
  };
}
