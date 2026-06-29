/**
 * Extracted InterRelayContext.onReverseAnnounce orchestration closure.
 *
 * Lives in its OWN module (not inline in index.ts) so it is unit-testable WITHOUT
 * importing index.ts's daemon-`main` side effects. index.ts wires this factory's
 * result into interRelayContext.onReverseAnnounce; reverse-announce-handler.test.ts
 * runs the SAME factory against a mock PrimaryPipeCoordinator.
 *
 * A6-gate remediation (REQ-RMS-037 / REQ-RMS-034): the PRIMARY received a reverse
 * announce from a standby's local client. We must mint a LOCAL hub copy onto the
 * room router and fan it. The fix vs the prior inline closure is the ADDED
 * ensureReverseLeg call BEFORE reverseMint -- see the inline comment for why.
 *
 * Requirements: REQ-RMS-037 (reverse-leg drain ordering), REQ-RMS-034/035.
 */

import { DEFAULT_PEER_RELAY_ID } from '@dvconf/inter-relay-client';
import type { RoomState } from './room-handler.js';
import type { types as msTypes } from 'mediasoup';

/** The announced reverse-pipe consumer descriptor reverseMint mints a hub copy from. */
interface ReverseAnnounced {
  producerId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
  /** B4a (REQ-RMS-037): the ORIGINAL publishing peer, threaded onto the queue so a
   *  double-race announce (queued before the leg connects) is fanned bound to the
   *  real publisher when drainReverseMints fires onReverseMinted. */
  producerPeerId?: string;
}

/** Collaborators the handler orchestrates (the PrimaryPipeCoordinator reverse-leg
 *  pair + the signaling-layer room lookup + reverse-mint registrar). Bound by
 *  index.ts to primaryPipe.* / signalingRef.* so the unit test can mock each. */
export interface ReverseAnnounceDeps {
  /** Establish + DRAIN the primary's reverse-leg pipe transport for this (room,peer).
   *  No-op when the leg already exists (drain-only branch) and when the standby's
   *  pipe-connect params are not yet present (logs + returns, no mint). */
  ensureReverseLeg: (roomId: string, router: msTypes.Router, peerRelayId: string) => Promise<void>;
  /** Mint a LOCAL hub producer from the announced reverse-pipe consumer, or null if
   *  QUEUED (leg not connected) / a benign dedup. */
  reverseMint: (
    roomId: string,
    router: msTypes.Router,
    announced: ReverseAnnounced,
    peerRelayId: string,
  ) => Promise<msTypes.Producer | null>;
  /** Room lookup (returns undefined before the signaling server is live). */
  getRoom: (roomId: string) => RoomState | undefined;
  /** Seed + fan the hub-minted reverse producer to this relay's local clients. */
  registerReverseMinted: (
    roomId: string,
    minted: msTypes.Producer,
    originRelayId: string,
    producerPeerId?: string,
  ) => void;
}

/**
 * Build the onReverseAnnounce handler. The returned fn matches
 * InterRelayContext['onReverseAnnounce'].
 */
export function makeOnReverseAnnounce(deps: ReverseAnnounceDeps) {
  return async function onReverseAnnounce(
    roomId: string,
    producerId: string,
    kind: msTypes.MediaKind,
    rtpParameters: msTypes.RtpParameters | undefined,
    peerRelayId: string | undefined,
    producerPeerId: string | undefined,
  ): Promise<void> {
    const room = deps.getRoom(roomId);
    // Fail-safe guards: a missing room (server not live yet / unknown room) or an
    // absent rtpParameters announce is a no-op (no leg ensure, no mint).
    if (!room || rtpParameters === undefined) return;
    const origin = peerRelayId ?? DEFAULT_PEER_RELAY_ID;
    // REQ-RMS-037: establish + DRAIN the reverse leg FIRST so a standby-produces-
    // first ordering (this reverse announce arrives BEFORE any primary forward
    // producer minted the shared pipe) still mints the hub copy. In the live first-
    // peer-join ordering the standby's pipe-connect params reach the primary BEFORE
    // its client's reverse announce, so by now standbyParams ARE present ->
    // ensureReverseLeg mints+connects+replies+drains the leg -> the reverseMint
    // below sees a connected transport and mints THIS announce immediately.
    // ensureReverseLeg is a no-op when the leg already exists (forward-first case:
    // drain-only branch, empty queue) and when standbyParams are absent (it logs +
    // returns, no mint). WITHOUT this call the announce queued in reverseMintPending
    // and was NEVER drained -- ensureReverseLeg/drainReverseMints had ZERO
    // production callers.
    //
    // RESIDUAL double-race (Stage R-B / Task B4 carryover): the rarer ordering where
    // standbyParams are ALSO not yet present when this announce arrives -> ensure is
    // a no-op (deferred) -> reverseMint QUEUES the announce. drainReverseMints (run
    // by a later onStandbyConnectParams/onProducer) WILL mint it, but it CANNOT FAN
    // it because queue entries carry no producerPeerId. B4 threads producerPeerId
    // into reverseMintPending + fans on drain to close that residual leg.
    await deps.ensureReverseLeg(roomId, room.router, origin);
    const minted = await deps.reverseMint(
      roomId,
      room.router,
      // B4a: carry producerPeerId on the announced descriptor so the QUEUED path
      // (double-race: leg + standby params both absent) preserves it for the drain
      // fan. The immediate path is unaffected -- mintOne ignores producerPeerId and
      // the `if (minted)` registerReverseMinted below already fans with it.
      { producerId, kind, rtpParameters, producerPeerId },
      origin,
    );
    if (minted) deps.registerReverseMinted(roomId, minted, origin, producerPeerId);
  };
}
