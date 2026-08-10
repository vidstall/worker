/**
 * mediasoup consume signaling: handleConsume.
 *
 * Pure extraction from media-handler.ts. See that file's barrel re-export.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import { createConsumer, ensureRelayProbe } from '../room-handler.js';
import type { ConsumeMessage } from './messages.js';
import { sendJson } from './helpers.js';
import type { SignalingServerState, InterRelayContext } from './state.js';

export async function handleConsume(
  state: SignalingServerState,
  ws: WebSocket,
  msg: ConsumeMessage,
  interRelay: InterRelayContext | undefined,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) return;

  // G1 client-consume reconciliation. dev-fe's client sends
  // `{ type:'consume', rtpCapabilities }` to the STANDBY relay WITHOUT a
  // producerId, expecting the standby to resolve the piped producer from room
  // context. We resolve from the inter-relay announce registry. On the PRIMARY
  // (or when the client did supply a producerId) the explicit producerId is used.
  let producerId = msg.producerId;
  if (!producerId && interRelay) {
    const announced = interRelay.registry.resolve(mapping.roomId);
    if (announced) {
      producerId = announced.producerId;
      logger.debug(
        { roomId: mapping.roomId, producerId, peerId: mapping.peerId },
        'Inter-relay: resolved piped producer from room context for client consume (standby)',
      );
    }
  }

  if (!producerId) {
    // No producerId supplied and none announced yet — standby not ready.
    sendJson(ws, { type: 'error', message: 'No producer available for room yet' });
    logger.warn(
      { roomId: mapping.roomId, peerId: mapping.peerId },
      'Consume request without producerId and no announced producer — standby not ready',
    );
    return;
  }

  // REQ-RMS-029 — resolve the ORIGINAL publisher by the FINAL producerId (the one
  // passed to createConsumer), not resolve(roomId). resolve(roomId) reads only the
  // DEFAULT bucket and misses a cross-relay MESH announce (bucketed per peerRelayId),
  // so the consume RESPONSE used to omit producerPeerId on the mesh. The producerId-
  // keyed lookup scans every per-peer bucket and returns THIS producer's own publisher,
  // so multi-publisher attribution via the response holds on the mesh path. The `??
  // undefined` normalizes the registry's `null` miss → so the gate below treats a
  // LOCAL consume (no registry entry) as "not cross-relay" rather than NPE-ing on null.
  const reg =
    interRelay?.registry.resolveByProducerId(mapping.roomId, producerId) ?? undefined;

  // REQ-RMS-038 E2EE fail-closed (C1, cross-relay scope): a CROSS-RELAY producer
  // (a registry entry EXISTS) whose ORIGINAL publisher id is MISSING must NOT be
  // consumed in an E2EE room — without the publisher binding the client can't
  // attribute/decrypt the SFrame. Fail closed BEFORE createConsumer to avoid a
  // dangling consumer. A same-relay LOCAL consume has NO registry entry (reg ===
  // undefined) ⇒ unaffected (M2/M3 non-regression).
  const e2ee = state.roomConfigs.get(mapping.roomId)?.e2ee ?? false;
  if (e2ee && reg !== undefined && reg.producerPeerId === undefined) {
    sendJson(ws, {
      type: 'error',
      reason: 'e2ee-missing-producer-peer-id',
      message: 'E2EE room: cross-relay producer missing publisher id',
      producerId,
    });
    logger.warn(
      { roomId: mapping.roomId, producerId, peerId: mapping.peerId },
      'REQ-RMS-038 fail-closed: E2EE cross-relay consume missing publisher id — refusing',
    );
    return;
  }

  const consumer = await createConsumer(room, peer, producerId, msg.rtpCapabilities, logger);
  if (!consumer) {
    sendJson(ws, { type: 'error', message: 'Cannot consume producer' });
    return;
  }

  // #26-rtt-followup: L_relay_fwd sampler on the relay→client Consumer. RTCP RR
  // roundTripTime lives on the RTP stream (NOT the bare transport), so the
  // sampler must attach here, once a Consumer exists. BENCH_LATENCY off →
  // probe null → zero-cost branch.
  const probe = ensureRelayProbe(logger);
  if (probe !== null) {
    const stop = probe.startSampler(consumer, {
      roomId: mapping.roomId,
      peerId: mapping.peerId,
      transportId: peer.recvTransport?.id,
      consumerId: consumer.id,
    });
    peer.samplerStops.set(consumer.id, stop);
    consumer.on('@close', () => {
      stop();
      peer.samplerStops.delete(consumer.id);
    });
  }

  const announcedPeer = reg?.producerPeerId;

  sendJson(ws, {
    type: 'consumed',
    consumerId: consumer.id,
    producerId,
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    ...(announcedPeer !== undefined ? { producerPeerId: announcedPeer } : {}),
  });

  logger.debug(
    { consumerId: consumer.id, producerId, peerId: mapping.peerId },
    'Consumer created for peer',
  );
}
