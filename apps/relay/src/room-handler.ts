/**
 * Per-room SFU/MCU logic for mediasoup relay.
 *
 * SFU mode: When a new producer is created, iterate all other peers in the
 * room and create Consumers for them. Notify via 'newProducer' message.
 *
 * MCU mode: For thesis simplicity, MCU works the same as SFU (each client
 * gets individual streams). The mode field is communicated to the client
 * for adaptive UI.
 *
 * TODO: Full MCU mixing (via ffmpeg/GStreamer pipe to a PipeTransport) is
 * deferred to post-thesis. Currently MCU mode behaves identically to SFU.
 *
 * Requirements: RELAY-05
 */

import type { types as msTypes } from 'mediasoup';
import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';

export interface RoomState {
  roomId: string;
  router: msTypes.Router;
  mode: 'sfu' | 'mcu';
  peers: Map<string, PeerState>;
}

export interface PeerState {
  peerId: string;
  ws: WebSocket;
  sendTransport: msTypes.WebRtcTransport | null;
  recvTransport: msTypes.WebRtcTransport | null;
  producers: msTypes.Producer[];
  consumers: msTypes.Consumer[];
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
 * When a new producer is created in a room, create consumers for all
 * other peers so they can receive the new stream.
 */
export async function notifyNewProducer(
  room: RoomState,
  producerPeerId: string,
  producer: msTypes.Producer,
  logger: Logger,
): Promise<void> {
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
 * @param producerId - The ID of the producer to consume (not the full Producer object,
 *                     since the consumer peer only needs the ID for router.canConsume
 *                     and transport.consume).
 */
export async function createConsumer(
  room: RoomState,
  consumerPeer: PeerState,
  producerId: string,
  rtpCapabilities: msTypes.RtpCapabilities,
  logger: Logger,
): Promise<msTypes.Consumer | null> {
  // Check if the router can consume this producer for the given peer
  if (!room.router.canConsume({ producerId, rtpCapabilities })) {
    logger.warn(
      { producerId, peerId: consumerPeer.peerId },
      'Router cannot consume producer for this peer',
    );
    return null;
  }

  if (!consumerPeer.recvTransport) {
    logger.warn({ peerId: consumerPeer.peerId }, 'Peer has no recv transport for consuming');
    return null;
  }

  const consumer = await consumerPeer.recvTransport.consume({
    producerId,
    rtpCapabilities,
    paused: false,
  });

  consumerPeer.consumers.push(consumer);

  logger.debug(
    { consumerId: consumer.id, producerId, peerId: consumerPeer.peerId },
    'Consumer created',
  );

  return consumer;
}

/**
 * Remove a peer from a room — close all transports, producers, consumers.
 */
export function removePeer(room: RoomState, peerId: string, logger: Logger): void {
  const peer = room.peers.get(peerId);
  if (!peer) return;

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
