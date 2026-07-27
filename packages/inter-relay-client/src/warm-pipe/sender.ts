/**
 * Primary-side inter-relay announcer — the outbound sink the primary uses to
 * push `pipe-producer` announce frames to the standby (index.ts wiring glue).
 *
 * Split out of the former `inter-relay.ts` (see warm-pipe/index.ts).
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import { buildPipeProducerAnnounce } from './pipe-protocol.js';

// ── Primary-side announcer (index.ts glue) ──────────────────────────────

/**
 * Minimal sink for the outbound inter-relay link. The wiring layer (index.ts)
 * backs this with the WS connection to the standby (a `ws` WebSocket's `.send`).
 * Kept as an interface so the announcer is unit-testable with a mock sender.
 */
export interface InterRelaySender {
  send(data: string): void;
}

/**
 * Builds the `announceProducer` callback for an InterRelayContext on the PRIMARY.
 * Serializes the locked frame and pushes it via the sender. Best-effort:
 * sender errors (link down) are swallowed so the primary's produce path never
 * crashes because the standby link is momentarily unavailable.
 *
 * REQ-RMS-008 — the returned closure gained a trailing OPTIONAL `peerRelayId`
 * (4th arg) forwarded into the frame's peerRelayId field, so this LIVE backing of
 * PrimaryPipeCoordinator.deps.announcer carries the cascade peer on the wire. All
 * trailing args default to undefined → the legacy single-standby path emits a
 * byte-identical frame (builder OMITS undefined fields). The two live call sites
 * thread the slots they have: the legacy in-process bench announce passes
 * `producerPeerId` (3rd arg, peerRelayId omitted); the coordinator drain (via the
 * index.ts adapter) NOW threads BOTH the ORIGINAL publisher's `producerPeerId`
 * (3rd arg) AND the cascade `peerRelayId` (4th arg) on the CASCADE/mesh path
 * (REQ-RMS-029 — the publisher id travels alongside the PIPED consumer id so a
 * cross-relay consume binds to the real publisher, not the cascade relayId). On
 * the DEFAULT/legacy single-standby leg the drain leaves producerPeerId undefined
 * → that part of the frame stays byte-stable.
 *
 * REQ-RMS-026 — the closure also forwards a trailing OPTIONAL `rtpParameters`
 * (5th arg) into the frame so the live primary→standby wire carries the piped
 * consumer's RtpParameters (the standby needs them for transport.produce()). Like
 * the other trailing args it defaults to undefined → the builder omits the field
 * → a legacy frame is byte-identical.
 */
export function createInterRelayAnnouncer(
  sender: InterRelaySender,
): (
  roomId: string,
  producer: Pick<msTypes.Producer, 'id' | 'kind'>,
  producerPeerId?: string,
  peerRelayId?: string,
  rtpParameters?: msTypes.RtpParameters,
  hopTtl?: number,
  originProducerId?: string,
) => void {
  return (roomId, producer, producerPeerId, peerRelayId, rtpParameters, hopTtl, originProducerId) => {
    const frame = buildPipeProducerAnnounce(
      roomId, producer, producerPeerId, peerRelayId, rtpParameters, hopTtl, originProducerId,
    );
    try {
      sender.send(JSON.stringify(frame));
    } catch {
      // Best-effort — link down must not break the primary's produce path.
      // The standby re-syncs on its next reconnect (link reconnect is the
      // wiring layer's concern). Swallowed silently here (no logger coupling);
      // the wiring layer logs link health.
    }
  };
}

/**
 * Minimal duck-type of a `ws` WebSocket the live inter-relay sink needs.
 * Kept narrow (readyState + send) so the sender is unit-testable with a plain
 * object and stays decoupled from the `ws` import in index.ts.
 */
export interface InterRelaySocketLike {
  readyState: number;
  send(data: string): void;
}

/** `ws` WebSocket.OPEN — the only readyState on which a send is attempted. */
const WS_OPEN = 1;

/**
 * BENCH-2 / G1: builds the LIVE inter-relay sender used on the PRIMARY.
 *
 * The prior index.ts sink was a no-op log stub — `announceProducer` serialized
 * a frame that never left the process, so the standby never received a real
 * producerId. This sink ACTUALLY TRANSMITS: it pulls the current accepted
 * standby socket from `getSocket()` (the wiring layer sets it when the standby
 * opens its inter-relay link) and `.send()`s the frame when the socket is OPEN.
 *
 * Best-effort by contract (mirrors createInterRelayAnnouncer's swallow):
 *   - no socket attached yet (standby not connected) → drop, no throw;
 *   - socket not OPEN (connecting / closed)          → drop, no throw;
 *   - socket.send throws (link died mid-flight)       → propagated to the
 *     announcer's try/catch, which swallows it (produce path never crashes).
 *
 * @param getSocket - returns the live standby socket, or null when none.
 * @param logger    - optional structured logger; logs drop reasons at debug.
 */
export function createWsInterRelaySender(
  getSocket: () => InterRelaySocketLike | null | undefined,
  logger?: Logger,
): InterRelaySender {
  return {
    send(data: string): void {
      const socket = getSocket();
      if (!socket) {
        logger?.debug('G1: inter-relay announce dropped — no standby link attached yet');
        return;
      }
      if (socket.readyState !== WS_OPEN) {
        logger?.debug(
          { readyState: socket.readyState },
          'G1: inter-relay announce dropped — standby link not OPEN',
        );
        return;
      }
      // Let send() throw propagate to createInterRelayAnnouncer's try/catch.
      socket.send(data);
    },
  };
}
