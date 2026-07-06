import type { types as msTypes } from 'mediasoup';
import type { CanaryForwardCapture } from './canary/verify-loop.js';
import type { PipedProducerDescriptor } from './canary/live-consumer-runtime.js';

/**
 * B2 (REQ-MLW-B-01/02): the OOB run-config the single-host walkthrough orchestrator (Task 4) writes
 * for the validator's `CANARY_LIVE_CAPTURE=pipe` bring-up — the relay primary {ip,port}, the piped
 * producer descriptor, the receiver miner_id, and the verify-meta. SINGLE SOURCE OF TRUTH: both the
 * orchestrator (producer) and index.ts (consumer of CANARY_PIPE_PARAMS_PATH) reference THIS shape.
 * `kRoom`/`cellSecret` are plain number[] on the wire (re-derivation factors, not secrets on a
 * socket — see live-seams INV-C); index.ts maps them to Uint8Array before handing to the runtime.
 */
/**
 * Track-C cross-host pipe SRTP params. Aliased to mediasoup's `SrtpParameters` so `relay` stays
 * assignment-compatible with the canonical `PipeConnectParams` the deployed pipe consumer forwards it
 * into (a widened structural type would break `cryptoSuite: SrtpCryptoSuite`). Present on `relay` ONLY
 * under PIPE_SRTP=1 (the 2-host WAN hop) so the peer host can `standby.connect({..., srtpParameters})`;
 * omitted on the loopback default, where `undefined` is already the byte-identical no-SRTP connect().
 */
export type PipeSrtpParameters = msTypes.SrtpParameters;

export interface CanaryPipeParams {
  relay: { ip: string; port: number; srtpParameters?: PipeSrtpParameters };
  piped: PipedProducerDescriptor;
  receiverMinerId: string;
  // `roomId` (Track-C): the audited room the canary derived K_canary from. The DEPLOYED index.ts pipe
  // path takes roomId from its own (relay,room) scope, so this field is inert there (optional, byte-
  // identical). It exists for the STANDALONE peer-host attester (vm2), which has no scope source and
  // MUST re-derive the identical expected hashes with `verifyForwardedCanary({..., roomId})`.
  meta: { canaryKid: number; expectedCtrs: number[]; kRoom: number[]; cellSecret: number[]; roomId?: string };
}

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
