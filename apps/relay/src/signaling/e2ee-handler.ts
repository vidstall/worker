/**
 * `e2eeKeyBundle` handling — BLIND broadcast of the coordinator's sealed group
 * key bundle to the other members of the sender's room.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import type { E2EEKeyBundleMessage } from './messages.js';
import { sendJson } from './helpers.js';
import type { SignalingServerState } from './state.js';

/**
 * W5 M2 P4 (REQ-MCS-012, transport half) — BLIND broadcast of the coordinator's
 * sealed `e2eeKeyBundle` to the OTHER members of the SENDER's room (CONTRACTS.md
 * §1, FROZEN; SEQUENCES.md §1). Signaling is BLIND transport: it FORWARDS the
 * whole opaque bundle as-is, recipient-oblivious — it never holds/derives/decrypts
 * a key, never routes per-recipient, and NEVER logs `sealedKey` / envelope
 * contents (only { kid, epoch, roomId, envelopeCount, recipientCount }).
 *
 * Room is derived from the WS (the `wsToRoom` mapping), NOT trusted from
 * `msg.roomId` — the same resolution every other handler uses (handleProduce
 * et al). A spoofed `roomId` (≠ the sender's room) is ignored + warned so a
 * peer cannot inject into another room. A sender not in any room is ignored.
 */
export function handleE2eeKeyBundle(
  state: SignalingServerState,
  ws: WebSocket,
  msg: E2EEKeyBundleMessage,
  logger: Logger,
): void {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) {
    // Sender never joined a room — ignore (no throw). Mirrors handleProduce.
    logger.warn('e2eeKeyBundle from a peer not in any room — ignoring');
    return;
  }

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) return;

  // Anti-spoof: the room is the SENDER's room (from the ws), not msg.roomId. A
  // mismatch is a peer trying to inject into another room → ignore + warn (the
  // bundle is NOT broadcast anywhere).
  if (msg.roomId !== mapping.roomId) {
    logger.warn(
      { senderRoomId: mapping.roomId, claimedRoomId: msg.roomId, peerId: mapping.peerId },
      'e2eeKeyBundle roomId mismatch (spoof attempt) — ignoring',
    );
    return;
  }

  // Defensive: a malformed bundle (missing/non-array `envelopes`) is dropped
  // cleanly — ignore + warn — mirroring the guards above, rather than
  // half-broadcasting a junk `envelopes:undefined` frame and THEN throwing on
  // `.length`. The only possible sender is an admitted in-room peer (post
  // password gate); a malformed frame should degrade quietly, not error-reply.
  if (!Array.isArray(msg.envelopes)) {
    logger.warn(
      { roomId: mapping.roomId, peerId: mapping.peerId },
      'e2eeKeyBundle missing/invalid envelopes — ignoring',
    );
    return;
  }

  // Broadcast the WHOLE bundle as-is to every OTHER peer (recipient-oblivious;
  // NO per-recipient filtering/fan-out). Reuses the per-room peer-iteration
  // idiom + sendJson (which guards readyState===OPEN). Opaque forward — the
  // envelopes are passed through byte-for-byte.
  let recipientCount = 0;
  for (const [existingPeerId, existingPeer] of room.peers) {
    if (existingPeerId === mapping.peerId) continue; // skip self — no echo
    sendJson(existingPeer.ws, {
      type: 'e2eeKeyBundle',
      roomId: msg.roomId,
      epoch: msg.epoch,
      kid: msg.kid,
      coordinatorPubkey: msg.coordinatorPubkey,
      envelopes: msg.envelopes,
    });
    recipientCount += 1;
  }

  // Logging discipline (CONTRACTS.md §1 / ROADMAP HARD-GATE): KID/epoch/roomId +
  // COUNTS only — NEVER the sealedKey or any envelope contents.
  logger.info(
    { kid: msg.kid, epoch: msg.epoch, roomId: msg.roomId, envelopeCount: msg.envelopes.length, recipientCount },
    'Broadcast e2eeKeyBundle (blind)',
  );
}
