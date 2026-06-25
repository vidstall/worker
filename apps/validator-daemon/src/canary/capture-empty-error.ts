// apps/validator-daemon/src/canary/capture-empty-error.ts  (NEW — B-WAN, REQ-MLW-B-12)
/**
 * B-WAN HARD-FAIL liveness (REQ-MLW-B-12): the deployed validator was REQUESTED to run
 * CANARY_LIVE_CAPTURE=pipe but cannot deliver a live capture (missing/malformed run-config, or the
 * first verify round observes an empty perReceiver = 0 receivers / 0 captured frames). A silent
 * no-op must NOT masquerade as a passing audit — the runbook greps the fatal token below + the
 * non-zero exit BEFORE accepting any slash / no-slash result.
 */
export class CaptureEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureEmptyError';
  }
}
/** Greppable observable the B-WAN runbook asserts on a healthy capture (>=1 receiver, >=1 frame). */
export const CANARY_CAPTURE_LIVE_TOKEN = 'CANARY_CAPTURE_LIVE_OK';
/** Greppable observable logged immediately before the hard-fail exit. */
export const CANARY_CAPTURE_EMPTY_TOKEN = 'CANARY_CAPTURE_EMPTY_FATAL';
