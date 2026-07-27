/**
 * mediasoup transport/producer/consumer signaling: createTransport,
 * connectTransport, produce, consume, setConsumerLayers, pauseConsumer,
 * resumeConsumer, and the per-room AudioLevelObserver attach.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import {
  type RoomState,
  createWebRtcTransport,
  notifyNewProducer,
  createConsumer,
  ensureRelayProbe,
} from '../room-handler.js';
import { shouldRecordPath } from '../inter-relay-socket-map.js';
import type { SpillTrigger } from '../spill-trigger.js';
import type {
  CreateTransportMessage,
  ConnectTransportMessage,
  ProduceMessage,
  ConsumeMessage,
  SetConsumerLayersMessage,
  PauseConsumerMessage,
  ResumeConsumerMessage,
} from './messages.js';
import { sendJson } from './helpers.js';
import type { SignalingServerState, SignalingConfig, TurnContext, InterRelayContext } from './state.js';

export async function handleCreateTransport(
  state: SignalingServerState,
  ws: WebSocket,
  msg: CreateTransportMessage,
  turnContext: TurnContext | undefined,
  config: SignalingConfig,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) {
    sendJson(ws, { type: 'error', message: 'Not in a room' });
    return;
  }

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) {
    sendJson(ws, { type: 'error', message: 'Room or peer not found' });
    return;
  }

  const transport = await createWebRtcTransport(room.router, logger);

  if (msg.direction === 'send') {
    peer.sendTransport = transport;
  } else {
    peer.recvTransport = transport;
    // W5 M1 P7 (REQ-MCS-005): apply the BWE backstop cap on the receive transport
    // ONLY (the consuming side). Server-internal — not a wire message (CONTRACTS.md C0).
    // Guard: skip when cap is 0 (opt-out) or NaN (invalid env value).
    if (config.maxIncomingBitrate > 0) {
      await transport.setMaxIncomingBitrate(config.maxIncomingBitrate);
      logger.debug(
        { transportId: transport.id, maxIncomingBitrate: config.maxIncomingBitrate, peerId: mapping.peerId },
        'recv transport BWE backstop cap applied',
      );
    }
  }

  let iceServers:
    | Array<{ urls: string | string[]; username?: string; credential?: string }>
    | undefined;
  if (turnContext) {
    try {
      const built = await turnContext.buildIceServers(mapping.peerId);
      if (built !== null) iceServers = built;
    } catch (err) {
      logger.warn(
        { err, peerId: mapping.peerId },
        'TURN credential fetch failed; sending transportCreated without iceServers',
      );
    }
  }

  sendJson(ws, {
    type: 'transportCreated',
    id: transport.id,
    iceParameters: transport.iceParameters,
    iceCandidates: transport.iceCandidates,
    dtlsParameters: transport.dtlsParameters,
    ...(iceServers ? { iceServers } : {}),
  });

  logger.debug(
    { transportId: transport.id, direction: msg.direction, peerId: mapping.peerId },
    'Transport created',
  );
}

export async function handleConnectTransport(
  state: SignalingServerState,
  ws: WebSocket,
  msg: ConnectTransportMessage,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer) return;

  // Find the transport by ID
  const transport =
    peer.sendTransport?.id === msg.transportId
      ? peer.sendTransport
      : peer.recvTransport?.id === msg.transportId
        ? peer.recvTransport
        : null;

  if (!transport) {
    sendJson(ws, { type: 'error', message: 'Transport not found' });
    return;
  }

  await transport.connect({ dtlsParameters: msg.dtlsParameters });

  logger.debug(
    { transportId: msg.transportId, peerId: mapping.peerId },
    'Transport connected',
  );
}

export async function handleProduce(
  state: SignalingServerState,
  ws: WebSocket,
  msg: ProduceMessage,
  interRelay: InterRelayContext | undefined,
  spillTrigger: SpillTrigger | undefined,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer || !peer.sendTransport) {
    sendJson(ws, { type: 'error', message: 'No send transport' });
    return;
  }

  const producer = await peer.sendTransport.produce({
    kind: msg.kind,
    rtpParameters: msg.rtpParameters,
  });

  peer.producers.push(producer);

  // W5 M1 P5 (REQ-MCS-003): register AUDIO producers with the room's
  // AudioLevelObserver so it can surface the dominant speaker. Guarded on the
  // observer existing (undefined when attach failed / MCU). mediasoup auto-
  // detaches a producer from the observer when the producer closes (removePeer
  // → producer.close()), so no explicit removeProducer is required here; we
  // defensively removeProducer on the close event regardless.
  if (msg.kind === 'audio' && room.audioLevelObserver) {
    try {
      await room.audioLevelObserver.addProducer({ producerId: producer.id });
      producer.on('@close', () => {
        room.audioLevelObserver
          ?.removeProducer({ producerId: producer.id })
          .catch(() => {
            /* observer/producer already gone — auto-detached; ignore */
          });
      });
    } catch (err) {
      logger.warn(
        { roomId: mapping.roomId, producerId: producer.id, err: (err as Error).message },
        'AudioLevelObserver.addProducer failed — speaker detection skips this producer',
      );
    }
  }

  sendJson(ws, {
    type: 'produced',
    producerId: producer.id,
  });

  // Notify all other peers about the new producer (SFU fan-out)
  await notifyNewProducer(room, mapping.peerId, producer, logger);

  // REQ-RMS-006/008: record a forward path on the self-observed spill trigger so a
  // room that crosses the worker-path threshold fires a one-shot spill REQUEST.
  // Gated by the TESTED shouldRecordPath(spillTrigger) — true only when the trigger
  // was wired (RMS_C_WORKER_PATHS set), so the M1 single-room path (no trigger) is
  // byte-unchanged. A produce success is one new forward path for the room.
  if (shouldRecordPath(spillTrigger)) {
    spillTrigger!.recordPath(mapping.roomId);
  }

  // F1 (CONSISTENCY-FIX HIGH#2, REQ-RO-001/002) PRIMARY side — DRIVE the
  // PrimaryPipeCoordinator at the produce event (the ONLY place a real
  // producerId exists). It mints+connects the primary pipe, pipes the producer,
  // and announces the PIPED consumer id (NOT producer.id) via its own announcer
  // dep. This REPLACES the old direct announceProducer(producer.id) — keeping
  // both would double-announce (producer.id + the piped id). When onPrimaryProducer
  // is absent (in-process bench / no coordinator), fall back to the legacy direct
  // announce so the bench path is unaffected.
  if (interRelay?.treeActive && interRelay.fanToTreeNeighbors) {
    // UNIFORM (§3.3, T-B T7 follow-up — concern #1/#2) — ANY own local produce fans through the
    // single edge-scoped + hop-guarded helper to ALL tree neighbors (UP to parent + DOWN to
    // children), driven by TREE position (pos), INDEPENDENT of chain role. Closes two gaps the old
    // role-branched wiring left: (#1) an INTERNAL node's own produce now reaches its OWN subtree —
    // it was UP-only, and the root's reverse hub-fan EXCLUDES the origin edge, so R1's children never
    // saw R1's media; (#2) a tree ROOT that is a chain-STANDBY (I1: tree root = sorted-min id may
    // diverge from chain slot-0 after promote_relay / unsorted relay_ids) now fans DOWN correctly
    // instead of announcing UP to a non-existent parent. fanToTreeNeighbors reads pos → root
    // (parent=null) fans DOWN only; internal fans UP+DOWN; leaf (children=∅) fans UP only. Local-
    // origin produce → receiveEdgeUrl = null (fan ALL neighbors) + inboundHopTtl = undefined → the
    // helper SEEDS the budget from pos.diameter; originProducerId = this producer's id (an OWN
    // produce IS the origin). onPrimaryProducer/onStandbyProducer are daemon-level bindings (NOT
    // role-gated), so a chain-standby internal node drives BOTH legs = the intended dual-role
    // (§3.1/§3.2). Flag OFF → treeActive undefined → the two role branches below are byte-for-byte
    // the shipped path.
    interRelay.fanToTreeNeighbors(
      mapping.roomId, room.router, producer, mapping.peerId, producer.id, null, undefined,
    );
    logger.info(
      { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId, producerPeerId: mapping.peerId },
      'T-B: routed OWN-produce fan through fanToTreeNeighbors — uniform, tree-position-driven (tree active)',
    );
  } else if (interRelay && interRelay.role === 'primary') {
    if (interRelay.onPrimaryProducer) {
      // REQ-RMS-028 (L1.3-b, Bridge A) — N-1 mesh fanout. Fan onPrimaryProducer
      // to every attached inter-relay peer (interRelaySockets.keys()), each on
      // its own per-peer pipe leg. interRelaySockets is a PER-DAEMON map (keyed
      // by peerRelayId, populated when ANY tagged inter-relay peer connects), NOT
      // per-room. Under the single-room demo scope (RMS-live LOCAL) every attached
      // peer IS a cascade standby of this room, so this equals "this room's
      // standbys". MULTI-ROOM CARRY-FORWARD: a per-(room,peer) filter is needed
      // before multi-room — a peer that is a standby of room Y but not room X
      // would otherwise get an undrained pendingProducers entry per produce. With
      // NO cascade peer attached the keys are empty → ONE legacy 3-arg call (the
      // default single-standby leg, byte-identical to the pre-mesh path — the
      // primary-produce-drive test deletes INTER_RELAY_TOKEN, leaving an empty
      // map, and expects exactly that single 3-arg call).
      const peerIds = state.interRelaySockets.keys();
      if (peerIds.length === 0) {
        interRelay.onPrimaryProducer(mapping.roomId, room.router, producer);
      } else {
        for (const p of peerIds) {
          // REQ-RMS-029: thread the ORIGINAL publishing peer (mapping.peerId) on the
          // CASCADE leg so the coordinator drain records it on the announce (the
          // cross-relay consume then binds to the real publisher, not the relayId).
          interRelay.onPrimaryProducer(mapping.roomId, room.router, producer, p, mapping.peerId);
        }
      }
      logger.info(
        {
          producerId: producer.id,
          kind: producer.kind,
          roomId: mapping.roomId,
          producerPeerId: mapping.peerId,
          cascadePeers: peerIds.length,
        },
        'Inter-relay: drove PrimaryPipeCoordinator at produce (primary) — announces PIPED id',
      );
    } else {
      // Legacy in-process bench path (no coordinator wired): direct announce.
      interRelay.announceProducer(mapping.roomId, producer, mapping.peerId);
      logger.info(
        { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId },
        'Inter-relay: announced producer to standby (primary, legacy direct)',
      );
    }
  } else if (interRelay && interRelay.role === 'standby') {
    // REQ-RMS-034 (part-3 reverse leg) — announce this standby's LOCAL-client
    // producer UP to the primary. notifyNewProducer (above) already local-fanned it
    // to this standby's own clients; this adds the reverse hop so the primary mints
    // a hub copy and fans it everywhere (full bidirectional mesh, hub-via-primary).
    // Fires ONLY for a real local-client produce (handleProduce); a piped/minted
    // producer is created via produceLocalFromPipe and NEVER reaches handleProduce
    // — so this can never re-announce a hub-minted stream (loop-safe, REQ-RMS-036;
    // regression guard: inter-relay-warmpipe.test.ts RED-RB-2). producerPeerId
    // = the ORIGINAL local publisher (mapping.peerId) for stream/E2EE fidelity.
    // Gated on the hook being present (mirrors the primary onPrimaryProducer block):
    // until A4 wires it (and on the in-process bench) the hook is absent — without the
    // guard the "drove..." log would over-claim a reverse hop that never happened.
    // NOTE (T-B T7 follow-up): under the tree the OWN-produce fan is handled UNIFORMLY above
    // (treeActive branch → fanToTreeNeighbors, tree-position-driven). This role==='standby' branch
    // is therefore reached ONLY flag-off → it stays byte-for-byte the shipped UP-only announce.
    if (interRelay.onStandbyProducer) {
      interRelay.onStandbyProducer(mapping.roomId, room.router, producer, mapping.peerId);
      logger.info(
        { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId, producerPeerId: mapping.peerId },
        'Inter-relay: drove reverse consume-onto-pipe at produce (standby) — announces UP to primary',
      );
    }
  }

  logger.info(
    { producerId: producer.id, kind: msg.kind, peerId: mapping.peerId, roomId: mapping.roomId },
    'Producer created',
  );
}

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
