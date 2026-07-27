/**
 * Inter-relay pipe wiring: inbound `pipe-producer` / `pipe-connect` frame
 * dispatch, plus the two outward-facing accessors (`fanLocalProducer`,
 * `reannounceLocalProducersUp`) returned from `createSignalingServer`.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import { notifyNewProducer } from '../room-handler.js';
import {
  isPipeProducerAnnounce,
  isPipeConnectFrame,
} from '@dvconf/inter-relay-client';
import type { PipeProducerMessage, PipeConnectMessage } from './messages.js';
import type { SignalingServerState, InterRelayContext } from './state.js';

/**
 * G1 STANDBY side — record an inbound inter-relay producer announce.
 * The primary pushes these so the standby can resolve the real producerId
 * for its warm pipe + for client consume requests that omit producerId.
 */
export async function handlePipeProducerAnnounce(
  state: SignalingServerState,
  msg: PipeProducerMessage,
  ws: WebSocket,
  interRelay: InterRelayContext | undefined,
  interRelayToken: string,
  logger: Logger,
): Promise<void> {
  if (!interRelay) {
    logger.debug('Received pipe-producer announce but no InterRelayContext — ignoring');
    return;
  }
  // G3.2b dispatch gate: with INTER_RELAY_TOKEN set, only a tagged inter-relay
  // peer may inject a server-side announce (an unauthed client cannot poison
  // the standby registry — the original threat). Token unset → gate open.
  if (interRelayToken !== '' && !state.interRelayPeers.has(ws)) {
    logger.warn(
      { roomId: msg.roomId },
      'G3.2b: dropping pipe-producer from untagged (non-inter-relay) socket',
    );
    return;
  }
  if (!isPipeProducerAnnounce(msg)) {
    logger.warn({ msg }, 'Malformed pipe-producer announce — ignoring');
    return;
  }
  interRelay.registry.record(msg);
  logger.info(
    { roomId: msg.roomId, producerId: msg.producerId, kind: msg.kind },
    'Inter-relay: recorded announced pipe producer (standby)',
  );
  // REQ-RMS-034 part-3 reverse leg: ONLY the PRIMARY mints a hub copy from a
  // standby's reverse announce (standby path stays record-only → byte-stable).
  if (interRelay?.role === 'primary' && interRelay.onReverseAnnounce) {
    try {
      // T-B (REQ-RMS-043/044/046) — thread the IMMUTABLE origin + loop-guard budget off the inbound
      // reverse announce into the tree hub-fan. Guard-widen: a pre-tree/star frame (both undefined)
      // keeps the EXACT 6-arg call the RED-RA-3a wiring assertion pins (byte-stable); a tree frame
      // (either field present) widens to 8-arg.
      if (msg.originProducerId === undefined && msg.hopTtl === undefined) {
        await interRelay.onReverseAnnounce(
          msg.roomId, msg.producerId, msg.kind, msg.rtpParameters, msg.peerRelayId, msg.producerPeerId,
        );
      } else {
        await interRelay.onReverseAnnounce(
          msg.roomId, msg.producerId, msg.kind, msg.rtpParameters, msg.peerRelayId, msg.producerPeerId,
          msg.originProducerId, msg.hopTtl,
        );
      }
    } catch (err) {
      logger.warn({ err, roomId: msg.roomId }, 'reverse-announce mint failed');
    }
  }
}

/**
 * REQ-RO-006 dispatch half — route an inbound inter-relay pipe-connect frame
 * to onConnectParams. Reuses the SAME interRelayPeers token gate as
 * handlePipeProducerAnnounce: with INTER_RELAY_TOKEN set, only a tagged
 * inter-relay peer may drive the primary's pipe (an unauthed client cannot).
 * Token unset → gate open (single-host / bench). Malformed frames are dropped
 * (no throw — a noisy peer must not crash the WS loop).
 */
export function handlePipeConnect(
  state: SignalingServerState,
  msg: PipeConnectMessage,
  ws: WebSocket,
  interRelay: InterRelayContext | undefined,
  interRelayToken: string,
  logger: Logger,
): void {
  if (!interRelay) {
    logger.debug('Received pipe-connect but no InterRelayContext — ignoring');
    return;
  }
  if (interRelayToken !== '' && !state.interRelayPeers.has(ws)) {
    logger.warn(
      { roomId: msg.roomId },
      'REQ-RO-006: dropping pipe-connect from untagged (non-inter-relay) socket',
    );
    return;
  }
  if (!isPipeConnectFrame(msg)) {
    logger.warn({ msg }, 'Malformed pipe-connect — ignoring');
    return;
  }
  // C6 part-2 (REQ-RMS-008): thread the standby's peerRelayId so the primary
  // connect()s the SAME per-(room,peer) leg. Undefined (legacy) → DEFAULT.
  interRelay.onConnectParams?.(
    msg.roomId,
    {
      ip: msg.ip,
      port: msg.port,
      ...(msg.srtpParameters !== undefined ? { srtpParameters: msg.srtpParameters } : {}),
    },
    msg.peerRelayId,
  );
  logger.info(
    { roomId: msg.roomId, ip: msg.ip, port: msg.port, peerRelayId: msg.peerRelayId },
    'Inter-relay: routed pipe-connect to onConnectParams',
  );
}

/**
 * REQ-RMS-027 (L1.3-b, Bridge B) — fan a standby-minted LOCAL forwarded producer
 * to the room's OWN local WebRTC clients. The wiring layer (index.ts) backs the
 * StandbyWarmPipeCoordinator's onLocalProducer callback with this, passing the RAW
 * `producerPeerId` (+ the cascade `peerRelayId`). The body resolves the bind peer
 * (`producerPeerId ?? peerRelayId`) so the clients bind to the ORIGINAL publisher,
 * AND applies the REQ-RMS-038 E2EE fail-closed gate (C1): an E2EE producer with no
 * publisher id is DROPPED here rather than bound to the relayId. Delegates to the
 * shipped `notifyNewProducer` SFU fan-out (the client then consumes the producer
 * DIRECTLY off room.router — proven by the L1.2 active-forward integration test),
 * so NO explicit RoomState/PeerState registration is needed.
 *
 * DEFERRED (RMS M4) — audio-lastN: when a standby runs with AUDIO_LASTN_K>0,
 * notifyNewProducer SUPPRESSES a forwarded AUDIO producer whose id is not in the
 * standby's own `room.audioTopK` (which only tracks the standby's local
 * AudioLevelObserver, never the upstream relay's). AUDIO_LASTN_K is OFF by default
 * (K=0 → audioTopK undefined → audio fans unconditionally), so the LOCAL headline
 * is unaffected; the cross-relay last-N union is tracked for RMS M4, not silently
 * dropped.
 */
export function fanLocalProducer(
  state: SignalingServerState,
  roomId: string,
  producerPeerId: string | undefined,
  producer: msTypes.Producer,
  peerRelayId: string | undefined,
  logger: Logger,
): void {
  const room = state.rooms.get(roomId);
  if (!room) {
    logger.warn({ roomId }, 'fanLocalProducer: room not found');
    return;
  }
  // REQ-RMS-038 E2EE fail-closed (C1): in an E2EE room a cross-relay producer
  // whose ORIGINAL publisher id is MISSING must be DROPPED — never bound to a
  // relayId — or the client cannot attribute/decrypt the SFrame. We pass the RAW
  // producerPeerId in so this gate fires HERE. (Same-relay LOCAL produce never
  // reaches fanLocalProducer — handleProduce fans it via notifyNewProducer
  // directly — so the shipped M2/M3 single-relay E2EE call is unaffected.)
  const e2ee = state.roomConfigs.get(roomId)?.e2ee ?? false;
  if (e2ee && producerPeerId === undefined) {
    logger.warn(
      { roomId, producerId: producer.id },
      'REQ-RMS-038 fail-closed: E2EE producer missing publisher id — dropping',
    );
    return;
  }
  // Open-room graceful fallback: bind to the ORIGINAL publisher when present, else
  // the cascade relayId. (Drops the prior `?? ''` fail-OPEN tail — the
  // e2ee-undefined case is now caught by the gate ABOVE; in every real open-room
  // call producerPeerId or peerRelayId is defined, so this never falls through.)
  const bindPeer = producerPeerId ?? peerRelayId;
  if (bindPeer === undefined) {
    logger.warn(
      { roomId, producerId: producer.id },
      'fanLocalProducer: no bind peer (open room, no publisher id or relayId) — dropping',
    );
    return;
  }
  void notifyNewProducer(room, bindPeer, producer, logger).catch((err) =>
    logger.warn({ err, roomId }, 'fanLocalProducer: fan failed'),
  );
}

/**
 * REQ-RMS-034/035/036 (part-3 reverse leg) — record a primary-minted reverse
 * hub producer in the per-room originRegistry (for hub-fan exclusion + loop
 * prevention) and propagate it BOTH ways from the hub:
 *   1. fanLocalProducer — fan to this relay's OWN local WebRTC clients. We pass
 *      the RAW producerPeerId so the REQ-RMS-038 E2EE fail-closed gate fires
 *      INSIDE fanLocalProducer: in an E2EE room a reverse-minted producer with no
 *      ORIGINAL publisher id is DROPPED (never bound to the originRelayId); an
 *      open room keeps the graceful relayId fallback.
 *   2. hub-fan DOWN (REQ-RMS-035/036) — drive onPrimaryProducer for every
 *      attached standby EXCEPT the origin (originRelayId is excluded so the
 *      stream is never echoed back to the standby it came from). Reuses the
 *      forward onPrimaryProducer hook (DRY-1, no new pipe path); each receiving
 *      standby mints + fans via its normal forward route.
 */
export function registerReverseMinted(
  state: SignalingServerState,
  roomId: string,
  minted: msTypes.Producer,
  originRelayId: string,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
  producerPeerId?: string,
  // T-B (REQ-RMS-043/044/046) — the IMMUTABLE origin + inbound loop-guard budget carried off the
  // reverse announce (threaded via onReverseAnnounce). PASSED IN — NOT read off minted.appData
  // (which is empty). Undefined on the shipped star hub-fan / the double-race drain path → the
  // legacy keys() flood below is byte-stable.
  originProducerId?: string,
  inboundHopTtl?: number,
): void {
  const room = state.rooms.get(roomId);
  if (!room) return;
  let bucket = state.originRegistry.get(roomId);
  if (!bucket) {
    bucket = new Map();
    state.originRegistry.set(roomId, bucket);
  }
  bucket.set(minted.id, { originRelayId, kind: minted.kind, producerPeerId, producer: minted });
  minted.on('@close', () => state.originRegistry.get(roomId)?.delete(minted.id));
  fanLocalProducer(state, roomId, producerPeerId, minted, originRelayId, logger);
  // T-B (REQ-RMS-043/044/046) — TREE hub-fan. The reverse-minted producer arrived FROM the child
  // edge `originRelayId` (already a URL), so re-forward it edge-scoped + hop-guarded through the
  // single fanToTreeNeighbors helper (DOWN to this node's OTHER children + UP to its tree parent),
  // REPLACING the flat-STAR interRelaySockets.keys() flood. The origin id is the IMMUTABLE origin
  // (fall back to minted.id ONLY when the announce truly had none — e.g. the rare double-race drain
  // path), NEVER the fresh per-hop hub mint id. Flag off (treeActive undefined) → the legacy flood.
  if (interRelay?.treeActive && interRelay.fanToTreeNeighbors) {
    // M-3 observability — this producer arrived FROM another relay (originRelayId), so a MISSING
    // originProducerId means a THREADING GAP (not a real local origin): the fallback to minted.id
    // (the fresh per-hop mint) mislabels the origin → per-room dedup degrades. WARN as an anomaly
    // (fires ~never once I-1 threads both the immediate + drain reverse paths).
    if (originProducerId === undefined) {
      logger.warn(
        { roomId, mintedId: minted.id, originRelayId },
        'T-B: reverse hub-fan missing originProducerId — threading gap, dedup may degrade',
      );
    }
    interRelay.fanToTreeNeighbors(
      roomId, room.router, minted, producerPeerId, originProducerId ?? minted.id, originRelayId, inboundHopTtl,
    );
    logger.info(
      { producerId: minted.id, kind: minted.kind, roomId, originRelayId, originProducerId: originProducerId ?? minted.id },
      'T-B: hub-fanned reverse-minted producer through fanToTreeNeighbors (tree active)',
    );
  } else if (interRelay?.onPrimaryProducer) {
    let cascadePeers = 0;
    for (const p of state.interRelaySockets.keys()) {
      if (p === originRelayId) continue;           // REQ-RMS-036 -- never echo back to origin
      interRelay.onPrimaryProducer(roomId, room.router, minted, p, producerPeerId);
      cascadePeers++;
    }
    logger.info(
      {
        producerId: minted.id,
        kind: minted.kind,
        roomId,
        originRelayId,
        cascadePeers,
      },
      'REQ-RMS-035: hub-fanned reverse-minted producer DOWN to non-origin standbys',
    );
  }
}

/**
 * REQ-RMS-037 — full re-announce of a room's local producers UP the standby link.
 * SUPERSEDED for the link-flap case by StandbyWarmPipeCoordinator.resendReverseAnnounces
 * (static-mesh-hardening D3): a flap must RE-DELIVER stored announce frames, not re-drive
 * this path (reverseConsumedIds would skip every already-consumed producer, so a producer
 * created DURING the down window would never re-announce). Kept as an ops/manual utility;
 * not wired to any production trigger. Guarded on role === 'standby' (a no-op on a primary);
 * reuses the onStandbyProducer hook — ownerPeerId = the original local publisher
 * (REQ-RMS-029/038 publisher binding).
 */
export function reannounceLocalProducersUp(
  state: SignalingServerState,
  roomId: string,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
): void {
  if (interRelay?.role !== 'standby') return;
  const room = state.rooms.get(roomId);
  if (!room) return;
  let count = 0;
  for (const [ownerPeerId, ownerPeer] of room.peers) {
    for (const producer of ownerPeer.producers) {
      interRelay.onStandbyProducer?.(roomId, room.router, producer, ownerPeerId);
      count++;
    }
  }
  if (count > 0) {
    logger.info({ roomId, count }, 'REQ-RMS-037: re-announced local producers UP on standby link reopen');
  }
}
