/**
 * mediasoup consumer-layer/pause/resume controls + the per-room
 * AudioLevelObserver attach.
 *
 * Pure extraction from media-handler.ts. See that file's barrel re-export.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import { type RoomState } from '../room-handler.js';
import type {
  SetConsumerLayersMessage,
  PauseConsumerMessage,
  ResumeConsumerMessage,
} from './messages.js';
import { sendJson } from './helpers.js';
import type { SignalingServerState, SignalingConfig } from './state.js';

/**
 * W5 M1 (REQ-MCS-002) — apply a client-requested simulcast layer preference.
 *
 * `consumer.setPreferredLayers(...)` is a SERVER-SIDE mediasoup call
 * (CONTRACTS.md C0): the client only *requests* it over the wire; the relay
 * looks up the stored Consumer on the peer (`peer.consumers`, pushed in
 * createConsumer at room-handler.ts:189) by `consumerId` and applies it.
 *
 * Omit-semantics (C2.1): when `temporalLayer` is absent the relay passes only
 * `{ spatialLayer }`, keeping the consumer's current temporal layer. An unknown
 * `consumerId` is logged and ignored — it must not throw / crash the WS loop.
 *
 * W5 M2 P5 — RELAY BLIND-FORWARD INVARIANT (REQ-MCS-011): layer-select coexists
 * with E2EE. SFrame keeps layer + KID metadata in the CLEARTEXT RTP/SFrame
 * header (RFC 9605 §4.4.3, CONTRACTS.md §2), so this server-side
 * `setPreferredLayers` switches simulcast spatial layers over CIPHERTEXT
 * payloads WITHOUT decoding them — the relay reads only the header. No payload
 * decode/decrypt path exists here (proven by the relay-blind invariant test).
 */
export async function handleSetConsumerLayers(
  state: SignalingServerState,
  ws: WebSocket,
  msg: SetConsumerLayersMessage,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) return;

  const consumer = peer.consumers.find((c) => c.id === msg.consumerId);
  if (!consumer) {
    logger.warn(
      { consumerId: msg.consumerId, peerId: mapping.peerId, roomId: mapping.roomId },
      'setConsumerLayers for unknown consumerId — ignoring',
    );
    return;
  }

  const preferredLayers =
    msg.temporalLayer === undefined
      ? { spatialLayer: msg.spatialLayer }
      : { spatialLayer: msg.spatialLayer, temporalLayer: msg.temporalLayer };

  await consumer.setPreferredLayers(preferredLayers);

  logger.debug(
    {
      consumerId: msg.consumerId,
      peerId: mapping.peerId,
      spatialLayer: msg.spatialLayer,
      temporalLayer: msg.temporalLayer,
    },
    'Applied setPreferredLayers for consumer',
  );
}

/**
 * W5 M1 P6 (REQ-MCS-004): pause a consumer so the peer's off-page tile
 * forwards RTCP only (~0 media bytes). Unknown consumerId → warn + ignore
 * (mirrors setConsumerLayers unknown-id handling). CONTRACTS.md C2.2.
 */
export async function handlePauseConsumer(
  state: SignalingServerState,
  ws: WebSocket,
  msg: PauseConsumerMessage,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) return;

  const consumer = peer.consumers.find((c) => c.id === msg.consumerId);
  if (!consumer) {
    logger.warn(
      { consumerId: msg.consumerId, peerId: mapping.peerId, roomId: mapping.roomId },
      'pauseConsumer for unknown consumerId — ignoring',
    );
    return;
  }

  await consumer.pause();

  logger.debug(
    { consumerId: msg.consumerId, peerId: mapping.peerId },
    'Paused consumer (off-page tile)',
  );
}

/**
 * W5 M1 P6 (REQ-MCS-004): resume a consumer so the peer's on-page tile
 * restarts RTP. Unknown consumerId → warn + ignore (mirrors setConsumerLayers
 * unknown-id handling). CONTRACTS.md C2.3.
 */
export async function handleResumeConsumer(
  state: SignalingServerState,
  ws: WebSocket,
  msg: ResumeConsumerMessage,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) return;

  const consumer = peer.consumers.find((c) => c.id === msg.consumerId);
  if (!consumer) {
    logger.warn(
      { consumerId: msg.consumerId, peerId: mapping.peerId, roomId: mapping.roomId },
      'resumeConsumer for unknown consumerId — ignoring',
    );
    return;
  }

  await consumer.resume();

  logger.debug(
    { consumerId: msg.consumerId, peerId: mapping.peerId },
    'Resumed consumer (on-page tile)',
  );
}

/**
 * W5 M1 P5 (REQ-MCS-003): create one AudioLevelObserver for the room's router
 * and wire its `volumes` event to an `activeSpeaker` broadcast. maxEntries:1 →
 * only the dominant speaker is reported. Best-effort: any failure is logged and
 * leaves `room.audioLevelObserver` undefined (the produce-side addProducer + the
 * broadcast are both guarded on its presence).
 */
export async function attachAudioLevelObserver(
  room: RoomState,
  config: SignalingConfig,
  logger: Logger,
): Promise<void> {
  try {
    // REQ-RMS-012: when last-N is enabled (AUDIO_LASTN_K > 0) the observer tracks
    // the k loudest; otherwise it keeps the shipped maxEntries:1 active-speaker
    // behavior (REQ-MCS-003). maxEntries must be >= 1.
    const maxEntries = config.audioLastNK > 0 ? config.audioLastNK : 1;
    const observer = await room.router.createAudioLevelObserver({
      maxEntries,
      threshold: config.audioObserverThresholdDb,
      interval: config.audioObserverIntervalMs,
    });
    room.audioLevelObserver = observer;
    if (config.audioLastNK > 0) {
      // Initialize the top-k set so notifyNewProducer's last-N gate is live for
      // this room (undefined => disabled). Populated on each 'volumes' event.
      room.audioTopK = new Set<string>();
    }

    observer.on('volumes', (volumes) => {
      const dominant = volumes[0];
      // REQ-RMS-012 — refresh the top-k loudest producer-id set from this
      // 'volumes' snapshot (volumes are ordered loudest-first by mediasoup).
      if (room.audioTopK !== undefined) {
        room.audioTopK = new Set(volumes.map((v) => v.producer.id));
      }
      if (!dominant) return;
      const dominantProducerId = dominant.producer.id;

      // Map producerId → peerId via the room's peer→producers structure.
      let speakerPeerId: string | undefined;
      for (const [peerId, peer] of room.peers) {
        if (peer.producers.some((p) => p.id === dominantProducerId)) {
          speakerPeerId = peerId;
          break;
        }
      }
      if (!speakerPeerId) {
        logger.debug(
          { roomId: room.roomId, producerId: dominantProducerId },
          'activeSpeaker: dominant producerId not mapped to a peer — skipping broadcast',
        );
        return;
      }

      // Broadcast to ALL peers in the room (existing fan-out idiom).
      for (const [, peer] of room.peers) {
        sendJson(peer.ws, { type: 'activeSpeaker', peerId: speakerPeerId });
      }
      logger.debug(
        { roomId: room.roomId, peerId: speakerPeerId },
        'activeSpeaker broadcast',
      );
    });

    observer.on('silence', () => {
      logger.debug({ roomId: room.roomId }, 'activeSpeaker: room silent');
    });

    logger.info(
      {
        roomId: room.roomId,
        intervalMs: config.audioObserverIntervalMs,
        thresholdDb: config.audioObserverThresholdDb,
      },
      'AudioLevelObserver attached',
    );
  } catch (err) {
    logger.warn(
      { roomId: room.roomId, err: (err as Error).message },
      'AudioLevelObserver attach failed — active-speaker disabled for this room',
    );
  }
}
