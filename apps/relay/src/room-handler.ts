/**
 * Per-room SFU/MCU logic for mediasoup relay.
 *
 * SFU mode: When a new producer is created, iterate all other peers in the
 * room and create Consumers for them. Notify via 'newProducer' message.
 *
 * MCU mode: Streams are piped to McuPipeline (ffmpeg xstack compositing).
 * Each client consumes a single composite Producer instead of N-1 individual streams.
 * On ffmpeg crash, the room falls back to SFU behavior automatically.
 *
 * Requirements: RELAY-05, MCU-02, MCU-03, MCU-04
 */

import type { types as msTypes } from 'mediasoup';
import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import { McuPipeline } from './mcu-pipeline.js';
import { createRelayLatencyProbe, type RelayLatencyProbe } from './latency-probe.js';

export interface RoomState {
  roomId: string;
  router: msTypes.Router;
  mode: 'sfu' | 'mcu';
  peers: Map<string, PeerState>;
  mcuPipeline?: McuPipeline;
  /**
   * W5 M1 P5 (REQ-MCS-003): one AudioLevelObserver per router, attached at room
   * creation. Its `volumes` event yields the dominant audio producerId, which the
   * relay maps → peerId and broadcasts as `activeSpeaker`. Optional: undefined in
   * MCU rooms / when observer creation is unavailable (guarded everywhere).
   */
  audioLevelObserver?: msTypes.AudioLevelObserver;
  /**
   * REQ-RMS-012 — server-side audio last-N. The producerIds of the top-k LOUDEST
   * audio producers, maintained by the AudioLevelObserver(maxEntries:k) wiring in
   * signaling.ts. notifyNewProducer fans an AUDIO producer to peers ONLY when its
   * id is in this set (video is always fanned out). Undefined => last-N disabled
   * (back-compat: audio fans out unconditionally, the pre-M3 behavior).
   */
  audioTopK?: Set<string>;
}

export interface PeerState {
  peerId: string;
  ws: WebSocket;
  /**
   * W5 M2 P1.0 (REQ-MCS-013): the peer's in-browser ed25519 SESSION public key
   * (base64, 32-byte), captured at admission. This Map of `{ peerId →
   * sessionPubkey }` (across `room.peers`) IS the roster the coordinator seals
   * K_room to (P1/P3). Dropped automatically when the peer leaves (removePeer
   * deletes the PeerState) → the roster shrinks (rekey trigger for P3). PUBLIC
   * key only — never key material.
   */
  sessionPubkey?: string;
  sendTransport: msTypes.WebRtcTransport | null;
  recvTransport: msTypes.WebRtcTransport | null;
  producers: msTypes.Producer[];
  consumers: msTypes.Consumer[];
  /**
   * Per-stream latency-probe sampler stop fns (S23.1.A1 + `#26-followup`,
   * BENCH_LATENCY=1 only). Keyed by `transport.id` or `consumer.id`; called from
   * `removePeer` before the transports/consumers close (the guaranteed backstop
   * for the per-consumer `@close` handler). Empty Map when `BENCH_LATENCY` is
   * unset (probe singleton returns null).
   */
  samplerStops: Map<string, () => void>;
}

let cachedProbe: RelayLatencyProbe | null = null;
let probeInitialized = false;

/**
 * Module-singleton accessor for the relay latency probe. Off-by-default —
 * returns `null` unless `BENCH_LATENCY=1`. Follows the cp-daemon
 * `latency-probe.ts` pattern (`ensureWriter` + `closeCpScoreProbe`).
 */
export function ensureRelayProbe(logger: Logger): RelayLatencyProbe | null {
  if (probeInitialized) return cachedProbe;
  probeInitialized = true;
  cachedProbe = createRelayLatencyProbe(
    process.env['RELAY_INSTANCE'] ?? 'relay-default',
    logger,
  );
  return cachedProbe;
}

/** Close the probe writer at daemon shutdown. Idempotent. */
export function closeRelayProbe(): void {
  if (cachedProbe !== null) {
    cachedProbe.close();
    cachedProbe = null;
    probeInitialized = false;
  }
}

/** Send a JSON message to a WebSocket peer. */
function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Create a WebRTC transport on the given router.
 */
export async function createWebRtcTransport(
  router: msTypes.Router,
  logger: Logger,
): Promise<msTypes.WebRtcTransport> {
  const announcedIp = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';

  const transport = await router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp }],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  logger.debug({ transportId: transport.id }, 'WebRTC transport created');

  return transport;
}

/**
 * When a new producer is created in a room, route based on mode:
 * - SFU: fan-out notifications to all other peers (unchanged)
 * - MCU: pipe the stream into McuPipeline for composite mixing
 */
export async function notifyNewProducer(
  room: RoomState,
  producerPeerId: string,
  producer: msTypes.Producer,
  logger: Logger,
): Promise<void> {
  // MCU mode: add stream to pipeline (unless fallen back to SFU)
  if (room.mode === 'mcu' && room.mcuPipeline && !room.mcuPipeline.sfuFallback) {
    await room.mcuPipeline.addStream(producerPeerId, producer);
    logger.info(
      { roomId: room.roomId, peerId: producerPeerId, producerId: producer.id },
      'MCU: stream added to pipeline',
    );
    return;
  }

  // SFU mode (or MCU fallback): fan-out to all peers.
  // REQ-RMS-012 — server-side audio last-N: an AUDIO producer is fanned out only
  // when it is among the top-k loudest (room.audioTopK), bounding the O(N^2) audio
  // fan-out. Video is always fanned out. Undefined audioTopK => last-N disabled.
  if (producer.kind === 'audio' && room.audioTopK !== undefined && !room.audioTopK.has(producer.id)) {
    logger.debug(
      { roomId: room.roomId, producerPeerId, producerId: producer.id, topK: room.audioTopK.size },
      'Audio producer not in top-k loudest — last-N suppresses fan-out',
    );
    return;
  }

  for (const [peerId, peer] of room.peers) {
    // Skip the producer's own peer
    if (peerId === producerPeerId) continue;

    // Notify the peer about the new producer
    sendJson(peer.ws, {
      type: 'newProducer',
      peerId: producerPeerId,
      producerId: producer.id,
      kind: producer.kind,
    });

    logger.debug(
      { roomId: room.roomId, producerPeerId, consumerPeerId: peerId, producerId: producer.id },
      'Notified peer of new producer',
    );
  }
}

/**
 * Create a consumer for a specific peer to receive a producer's stream.
 *
 * MCU mode: the consumer receives the composite output Producer from McuPipeline
 * (ignoring the passed producerId in favor of the pipeline's outputProducer).
 *
 * SFU mode: standard individual producer consumption (unchanged).
 *
 * @param producerId - The ID of the producer to consume. In MCU mode this is
 *                     overridden by the pipeline's composite output producer.
 */
export async function createConsumer(
  room: RoomState,
  consumerPeer: PeerState,
  producerId: string,
  rtpCapabilities: msTypes.RtpCapabilities,
  logger: Logger,
): Promise<msTypes.Consumer | null> {
  // MCU mode: consume the composite output producer (unless fallen back)
  let targetProducerId = producerId;
  if (room.mode === 'mcu' && room.mcuPipeline && !room.mcuPipeline.sfuFallback) {
    const compositeProducer = room.mcuPipeline.outputProducer;
    if (compositeProducer) {
      targetProducerId = compositeProducer.id;
    } else {
      logger.warn({ roomId: room.roomId }, 'MCU: no composite producer available yet');
      return null;
    }
  }

  // Check if the router can consume this producer for the given peer
  if (!room.router.canConsume({ producerId: targetProducerId, rtpCapabilities })) {
    logger.warn(
      { producerId: targetProducerId, peerId: consumerPeer.peerId },
      'Router cannot consume producer for this peer',
    );
    return null;
  }

  if (!consumerPeer.recvTransport) {
    logger.warn({ peerId: consumerPeer.peerId }, 'Peer has no recv transport for consuming');
    return null;
  }

  // ── W5 M2 P5 — RELAY BLIND-FORWARD INVARIANT (REQ-MCS-011) ──────────────────
  // This `recvTransport.consume(...)` is the SFU forward path. When the room is
  // E2EE (SFrame, RFC 9605), the producer's RTP payload is `cleartext SFrame
  // header (Config byte | KID | CTR — CONTRACTS.md §2) || ciphertext || auth tag`.
  // The relay forwards that payload BYTE-FOR-BYTE: mediasoup rewrites only RTP
  // *header* fields (SSRC/seq/ts) for routing, NEVER the payload body. It reads
  // ONLY the cleartext RTP/SFrame header for routing + M1 simulcast layer-select
  // (`setPreferredLayers`, REQ-MCS-002 — RFC 9605 §4.4.3 keeps layer + KID
  // metadata key-independent), and MUST NOT decode/decrypt the payload. There is
  // structurally NO decode path here: mediasoup has no SFrame/insertable-streams
  // support, so the ciphertext is opaque to it. Enforced by the invariant test
  // `__tests__/integration/relay-blind-forward.integration.test.ts`.
  // SCOPE — SFU PATH ONLY: this invariant is the SFU forward path (`room.mode ===
  // 'sfu'`). MCU mode intentionally DOES decode/composite VP8 via ffmpeg
  // (`mcu-pipeline.ts`) — that is content-agnostic mixing by design and OUT of
  // REQ-MCS-011 scope (an E2EE room never enters MCU mode without an explicit
  // user opt-out of E2EE — P7 consent gate, D-M2-6). "No decode path" is a
  // claim about THIS SFU forward, not the relay binary as a whole.
  // SCOPE (D-M2-8): the relay's blindness is STRUCTURAL (no decode path); the
  // validator-blindness in M2 is ECONOMIC/OPERATIONAL (it holds the key). This is
  // NOT a cryptographic "relay/validator cannot decrypt" claim (Path C → M3).
  // ── REQ-RMS-011 / REQ-RMS-010 — CASCADE HOP carry ───────────────────────────
  // This same blind-forward + layer-select invariant holds across EACH added
  // cascade pipe hop (tier-2 pipeToRouter / tier-3 inter-relay pipe). A piped
  // producer arrives downstream with its FULL simulcast ladder; this createConsumer
  // runs UNCHANGED on a piped producer, and setPreferredLayers layer-selects this
  // relay's own viewers locally — control does NOT compose layers at the hop. The
  // SFrame ciphertext stays byte-identical across every hop (header-only rewrites),
  // proven by multi-hop-byte-identity.integration.test.ts (REQ-RMS-020).
  const consumer = await consumerPeer.recvTransport.consume({
    producerId: targetProducerId,
    rtpCapabilities,
    paused: false,
  });

  consumerPeer.consumers.push(consumer);

  logger.debug(
    { consumerId: consumer.id, producerId: targetProducerId, peerId: consumerPeer.peerId, mode: room.mode },
    'Consumer created',
  );

  return consumer;
}

/**
 * Remove a peer from a room — close all transports, producers, consumers.
 * MCU mode: also removes stream from pipeline and triggers recompose.
 */
export async function removePeer(room: RoomState, peerId: string, logger: Logger): Promise<void> {
  const peer = room.peers.get(peerId);
  if (!peer) return;

  // MCU mode: remove stream from pipeline (triggers recompose)
  if (room.mode === 'mcu' && room.mcuPipeline && !room.mcuPipeline.sfuFallback) {
    await room.mcuPipeline.removeStream(peerId);
  }

  // Stop any active latency-probe samplers before closing transports
  // (S23.1.A1) to avoid getStats() on a closed transport.
  for (const stop of peer.samplerStops.values()) {
    stop();
  }
  peer.samplerStops.clear();

  // Close all consumers
  for (const consumer of peer.consumers) {
    consumer.close();
  }

  // Close all producers
  for (const producer of peer.producers) {
    producer.close();
  }

  // Close transports
  if (peer.sendTransport) {
    peer.sendTransport.close();
  }
  if (peer.recvTransport) {
    peer.recvTransport.close();
  }

  room.peers.delete(peerId);

  logger.info(
    { roomId: room.roomId, peerId, remainingPeers: room.peers.size },
    'Peer removed from room',
  );
}
