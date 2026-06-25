import type { CanaryForwardCapture } from './canary/verify-loop.js';

/**
 * B2 (REQ-MLW-B-01): choose which CanaryForwardCapture the verify-loop uses, ADDITIVELY.
 * Precedence: an explicit injected liveSeams capture wins (the CANARY_LIVE_SEAMS_ENABLED path,
 * unchanged); then a live pipe consumer's capture (CANARY_LIVE_CAPTURE=pipe); then the
 * byte-identical empty no-op (flag unset / any other value). This is a pure function so the
 * wiring is unit-tested without booting the daemon.
 */
export function chooseCapture(
  injected: CanaryForwardCapture | undefined,
  pipe: CanaryForwardCapture | undefined,
  emptyNoop: CanaryForwardCapture,
): CanaryForwardCapture {
  return injected ?? pipe ?? emptyNoop;
}
