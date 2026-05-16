/**
 * WebSocket server for mediasoup client-relay signaling.
 *
 * Protocol: JSON messages over WebSocket for mediasoup transport negotiation.
 * Manages rooms, peers, transports, producers, and consumers.
 *
 * Requirements: RELAY-05
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import type { MediasoupManager } from './mediasoup-manager.js';
import type { MetricsTracker } from './metrics.js';
import {
  type RoomState,
  type PeerState,
  createWebRtcTransport,
  notifyNewProducer,
  createConsumer,
  removePeer,
  ensureRelayProbe,
} from './room-handler.js';
import { McuPipeline } from './mcu-pipeline.js';

// ── Protocol message types ──────────────────────────────────────────

interface JoinMessage {
  type: 'join';
  roomId: string;
  peerId: string;
  /** Room mode: 'sfu' (default) or 'mcu'. First joiner sets the mode. */
  mode?: 'sfu' | 'mcu';
}

interface CreateTransportMessage {
  type: 'createTransport';
  direction: 'send' | 'recv';
}

interface ConnectTransportMessage {
  type: 'connectTransport';
  transportId: string;
  dtlsParameters: msTypes.DtlsParameters;
}

interface ProduceMessage {
  type: 'produce';
  transportId: string;
  kind: msTypes.MediaKind;
  rtpParameters: msTypes.RtpParameters;
}

interface ConsumeMessage {
  type: 'consume';
  producerId: string;
  rtpCapabilities: msTypes.RtpCapabilities;
}

interface LeaveMessage {
  type: 'leave';
}

type SignalingMessage =
  | JoinMessage
  | CreateTransportMessage
  | ConnectTransportMessage
  | ProduceMessage
  | ConsumeMessage
  | LeaveMessage;

/** Send a JSON message to a WebSocket. */
function sendJson(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Create the mediasoup signaling WebSocket server.
 *
 * @returns The WebSocketServer instance and a function to get room count.
 */
export function createSignalingServer(
  manager: MediasoupManager,
  metrics: MetricsTracker,
  logger: Logger,
): { wss: WebSocketServer; getRoomCount: () => number } {
  const port = parseInt(process.env['WS_PORT'] ?? '4000', 10);
  const relayMode = (process.env['RELAY_MODE']?.toLowerCase() ?? 'sfu') as 'sfu' | 'mcu';

  const rooms = new Map<string, RoomState>();
  /** Track which room each WebSocket belongs to for cleanup. */
  const wsToRoom = new Map<WebSocket, { roomId: string; peerId: string }>();

  const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 });

  wss.on('connection', (ws: WebSocket) => {
    logger.debug('New WebSocket connection');

    ws.on('message', async (data) => {
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(data.toString()) as SignalingMessage;
      } catch {
        logger.warn('Invalid JSON received on relay signaling');
        return;
      }

      try {
        await handleMessage(ws, msg);
      } catch (err) {
        logger.error({ err, type: msg.type }, 'Error handling signaling message');
        sendJson(ws, { type: 'error', message: 'Internal server error' });
      }
    });

    ws.on('close', () => {
      handleDisconnect(ws);
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
    });
  });

  wss.on('listening', () => {
    logger.info({ port, relayMode }, 'Relay signaling server listening');
  });

  async function handleMessage(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    switch (msg.type) {
      case 'join': {
        await handleJoin(ws, msg);
        break;
      }

      case 'createTransport': {
        await handleCreateTransport(ws, msg);
        break;
      }

      case 'connectTransport': {
        await handleConnectTransport(ws, msg);
        break;
      }

      case 'produce': {
        await handleProduce(ws, msg);
        break;
      }

      case 'consume': {
        await handleConsume(ws, msg);
        break;
      }

      case 'leave': {
        handleDisconnect(ws);
        break;
      }

      default: {
        logger.warn({ type: (msg as { type: string }).type }, 'Unknown signaling message type');
      }
    }
  }

  async function handleJoin(ws: WebSocket, msg: JoinMessage): Promise<void> {
    const { roomId, peerId } = msg;

    // Get or create room — mode is per-room, set by first joiner (or defaults to env)
    let room = rooms.get(roomId);
    if (!room) {
      const roomMode = msg.mode ?? relayMode;
      const worker = manager.getNextWorker();
      const router = await manager.createRouter(worker);
      room = {
        roomId,
        router,
        mode: roomMode,
        peers: new Map(),
      };

      // Initialize MCU pipeline for MCU rooms
      if (roomMode === 'mcu') {
        room.mcuPipeline = new McuPipeline(router, logger);
        logger.info({ roomId }, 'MCU pipeline initialized for room');
      }

      rooms.set(roomId, room);
      logger.info({ roomId, mode: roomMode }, 'Room created');
    }

    // Create peer state
    const peer: PeerState = {
      peerId,
      ws,
      sendTransport: null,
      recvTransport: null,
      producers: [],
      consumers: [],
      samplerStops: new Map(),
    };
    room.peers.set(peerId, peer);
    wsToRoom.set(ws, { roomId, peerId });

    // Track session in metrics
    metrics.trackBytes(roomId, peerId, 0);

    // Send router RTP capabilities to client
    sendJson(ws, {
      type: 'routerRtpCapabilities',
      rtpCapabilities: room.router.rtpCapabilities,
      mode: room.mode,
    });

    // Notify newly joined peer about existing producers in the room
    for (const [existingPeerId, existingPeer] of room.peers) {
      if (existingPeerId === peerId) continue;
      for (const producer of existingPeer.producers) {
        sendJson(ws, {
          type: 'newProducer',
          peerId: existingPeerId,
          producerId: producer.id,
          kind: producer.kind,
        });
      }
    }

    logger.info(
      { roomId, peerId, peerCount: room.peers.size },
      'Peer joined room',
    );
  }

  async function handleCreateTransport(ws: WebSocket, msg: CreateTransportMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) {
      sendJson(ws, { type: 'error', message: 'Not in a room' });
      return;
    }

    const room = rooms.get(mapping.roomId);
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
    }

    // S23.1.A1: start a latency-probe sampler on this transport when
    // BENCH_LATENCY=1. Probe is null otherwise — zero-cost branch.
    const probe = ensureRelayProbe(logger);
    if (probe !== null) {
      const stop = probe.startSampler(transport, {
        roomId: mapping.roomId,
        peerId: mapping.peerId,
        transportId: transport.id,
      });
      peer.samplerStops.set(transport.id, stop);
    }

    sendJson(ws, {
      type: 'transportCreated',
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    });

    logger.debug(
      { transportId: transport.id, direction: msg.direction, peerId: mapping.peerId },
      'Transport created',
    );
  }

  async function handleConnectTransport(ws: WebSocket, msg: ConnectTransportMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
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

  async function handleProduce(ws: WebSocket, msg: ProduceMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
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

    sendJson(ws, {
      type: 'produced',
      producerId: producer.id,
    });

    // Notify all other peers about the new producer (SFU fan-out)
    await notifyNewProducer(room, mapping.peerId, producer, logger);

    logger.info(
      { producerId: producer.id, kind: msg.kind, peerId: mapping.peerId, roomId: mapping.roomId },
      'Producer created',
    );
  }

  async function handleConsume(ws: WebSocket, msg: ConsumeMessage): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
    const peer = room?.peers.get(mapping.peerId);
    if (!room || !peer) return;

    const consumer = await createConsumer(room, peer, msg.producerId, msg.rtpCapabilities, logger);
    if (!consumer) {
      sendJson(ws, { type: 'error', message: 'Cannot consume producer' });
      return;
    }

    sendJson(ws, {
      type: 'consumed',
      consumerId: consumer.id,
      producerId: msg.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
    });

    logger.debug(
      { consumerId: consumer.id, producerId: msg.producerId, peerId: mapping.peerId },
      'Consumer created for peer',
    );
  }

  async function handleDisconnect(ws: WebSocket): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const { roomId, peerId } = mapping;
    const room = rooms.get(roomId);

    if (room) {
      await removePeer(room, peerId, logger);
      metrics.clearSession(roomId, peerId);

      // Clean up empty rooms
      if (room.peers.size === 0) {
        // Close MCU pipeline if active
        if (room.mcuPipeline) {
          await room.mcuPipeline.close();
          logger.info({ roomId }, 'MCU pipeline closed for room');
        }
        room.router.close();
        rooms.delete(roomId);
        metrics.clearRoom(roomId);
        logger.info({ roomId }, 'Room closed (no peers remaining)');
      }
    }

    wsToRoom.delete(ws);
    logger.info({ roomId, peerId }, 'Peer disconnected from relay');
  }

  return {
    wss,
    getRoomCount: () => rooms.size,
  };
}
