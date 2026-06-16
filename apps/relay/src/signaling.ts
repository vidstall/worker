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
import {
  type InterRelayProducerRegistry,
  type InterRelaySocketLike,
  isPipeProducerAnnounce,
  isValidInterRelayToken,
  INTER_RELAY_SUBPROTOCOL,
} from './inter-relay.js';
import type { RelayRole } from './relay-role-manager.js';

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
  /**
   * Optional. On the PRIMARY a client supplies the producerId it learned via a
   * `newProducer` notification. On the STANDBY (G1 reconciliation) the client
   * sends `{ type:'consume', rtpCapabilities }` WITHOUT a producerId and the
   * standby resolves the piped producer from room context (the inter-relay
   * announce registry). See dev-fe client-consume contract reconciliation.
   */
  producerId?: string;
  rtpCapabilities: msTypes.RtpCapabilities;
}

interface LeaveMessage {
  type: 'leave';
}

/**
 * W5 M1 (REQ-MCS-002) — client requests the relay apply a per-consumer simulcast
 * layer preference. `setPreferredLayers` is a SERVER-SIDE mediasoup call
 * (CONTRACTS.md C0): the client NEVER calls it, it only sends this request and
 * the relay looks up the stored Consumer by `consumerId` and applies it.
 */
interface SetConsumerLayersMessage {
  type: 'setConsumerLayers';
  /** mediasoup Consumer.id, as returned to the client in the `consumed` reply. */
  consumerId: string;
  /** Spatial layer 0|1|2 (CONTRACTS.md C1: 0=low/thumbnail, 2=high/active-speaker). */
  spatialLayer: number;
  /**
   * Temporal layer 0|1|2 (VP8 L1T3). Optional-semantics: omit → relay keeps the
   * current temporal layer (passes only { spatialLayer } to setPreferredLayers).
   */
  temporalLayer?: number;
}

/**
 * Inbound inter-relay producer-announce frame (G1). Received by the STANDBY
 * relay on the same WS server, distinguished from client frames by `type`.
 * Shape matches PipeProducerAnnounce in inter-relay.ts.
 */
interface PipeProducerMessage {
  type: 'pipe-producer';
  roomId: string;
  producerId: string;
  kind: msTypes.MediaKind;
}

type SignalingMessage =
  | JoinMessage
  | CreateTransportMessage
  | ConnectTransportMessage
  | ProduceMessage
  | ConsumeMessage
  | SetConsumerLayersMessage
  | LeaveMessage
  | PipeProducerMessage;

/**
 * S30.C — Optional TURN credential injection. When provided, the signaling
 * server calls `buildIceServers(peerId)` during createTransport and inlines
 * the result into the `transportCreated` response so mediasoup-client can
 * add TURN relay candidates. Returning null skips for that transport; the
 * server logs and degrades gracefully on errors (no TURN, baseline path).
 */
export interface TurnContext {
  buildIceServers(
    peerId: string,
  ): Promise<
    Array<{ urls: string | string[]; username?: string; credential?: string }> | null
  >;
}

/**
 * G1 inter-relay coordination context. When provided, the signaling server:
 *  - PRIMARY: after handleProduce, calls `announceProducer(roomId, producer)`
 *    to push a `pipe-producer` frame to the paired standby.
 *  - STANDBY: records inbound `pipe-producer` frames into `registry`, and
 *    resolves a client `consume` that omits producerId from room context.
 *
 * Injected by index.ts (the wiring layer) — kept optional + decoupled so the
 * baseline single-relay signaling path is unchanged (mirrors TurnContext).
 *
 * LIVE two-relay verification DEFERRED to bench (Phase 5.3).
 */
export interface InterRelayContext {
  /** This relay's role for the rooms it serves. */
  role: RelayRole;
  /** Standby-side registry of producers announced by the primary. */
  registry: InterRelayProducerRegistry;
  /**
   * Primary-side: push a producer announce to the paired standby.
   * The wiring layer holds the inter-relay WS link to the standby endpoint.
   */
  announceProducer(roomId: string, producer: Pick<msTypes.Producer, 'id' | 'kind'>): void;
  /**
   * G3.2b PRIMARY-side: the server accepted a TAGGED inter-relay peer (the
   * standby dialing in over the authenticated link). The wiring layer stores it
   * as the live `interRelayLink.socket` the announce sender transmits over;
   * `null` is passed when that peer disconnects (single-box detach). Optional —
   * absent on the in-process bench (which sets the socket directly).
   */
  attachPeerSocket?(socket: InterRelaySocketLike | null): void;
  /**
   * G3.2b STANDBY-side: fired ONCE on the first peer join for a room this relay
   * is standby for (room creation). The wiring layer builds the room's
   * RoomTopology + calls StandbyWarmPipeCoordinator.ensure() so the paused warm
   * pipe runs in the LIVE signaling path (M1 built ensureWarmPipe but never ran
   * it in production). Optional.
   */
  onStandbyRoomReady?(roomId: string, router: msTypes.Router): void;
}

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
  turnContext?: TurnContext,
  interRelay?: InterRelayContext,
): {
  wss: WebSocketServer;
  getRoomCount: () => number;
  setAccepting: (accepting: boolean) => void;
  closeRooms: () => void;
} {
  const port = parseInt(process.env['WS_PORT'] ?? '4000', 10);
  const relayMode = (process.env['RELAY_MODE']?.toLowerCase() ?? 'sfu') as 'sfu' | 'mcu';

  const rooms = new Map<string, RoomState>();
  /** Track which room each WebSocket belongs to for cleanup. */
  const wsToRoom = new Map<WebSocket, { roomId: string; peerId: string }>();
  /** Per-room async lock for the "get or create" critical section in
   *  handleJoin. Without serialization, two peers arriving in the same
   *  Node tick both observe rooms.get(roomId) === undefined, both await
   *  manager.createRouter, both write rooms.set — second wins, the loser's
   *  Router is orphan and newProducer pushes never cross peers. Real fix
   *  for CI-18; replaces the 250 ms inter-join delay workaround in
   *  scripts/bench/mediasoup-client-harness.ts. */
  const roomCreationLocks = new Map<string, Promise<void>>();

  // F60 graceful shutdown (DOH-021): while draining we stop accepting NEW client
  // upgrades (setAccepting(false)). Inter-relay standby peers stay exempt so the
  // G3.2b warm-pipe link is not severed. Default true → normal operation unchanged.
  let accepting = true;

  // G3.2b: cross-daemon inter-relay auth. INTER_RELAY_TOKEN (when set) tags the
  // standby's inbound link; tagged peers are attached as the announce socket and
  // are the only sockets allowed to inject pipe-producer frames server-side.
  // Unset (single-host / in-process bench) → the gate is open (unchanged path).
  const interRelayToken = process.env['INTER_RELAY_TOKEN'] ?? '';
  const interRelayPeers = new WeakSet<WebSocket>();
  let attachedInterRelaySocket: WebSocket | null = null;

  const wss = new WebSocketServer({
    port,
    maxPayload: 64 * 1024,
    // Select the inter-relay subprotocol when a peer advertises it (a normal
    // client offers none → handleProtocols is not invoked). Identity signal
    // alongside the Bearer token; not the auth itself.
    handleProtocols: (protocols) =>
      protocols.has(INTER_RELAY_SUBPROTOCOL) ? INTER_RELAY_SUBPROTOCOL : false,
  });

  wss.on('connection', (ws: WebSocket, req) => {
    // G3.2b: identify inter-relay peers by their Bearer token (timingSafeEqual).
    // Computed once and reused for both the F60 stop-accept gate and the tagging
    // below. A client connects with NO Authorization header → untagged.
    const isInterRelay =
      interRelayToken !== '' &&
      isValidInterRelayToken(req.headers['authorization'], interRelayToken);

    // F60 stop-accept (DOH-021): once draining, refuse NEW client upgrades with
    // 1001 (going-away). Inter-relay peers are EXEMPT — closing a standby dial-in
    // would sever the G3.2b warm-pipe announce link (relay-overlap failover).
    // In normal operation (accepting === true) no client is ever rejected — the
    // client gate stays at dispatch, not the handshake.
    if (!accepting && !isInterRelay) {
      ws.close(1001);
      return;
    }

    // G3.2b: tag inter-relay peers → attach as the announce socket. Untagged
    // clients fall through; their server-side pipe-producer frames are dropped at
    // the dispatch gate.
    if (isInterRelay) {
      interRelayPeers.add(ws);
      if (attachedInterRelaySocket !== null) {
        // Single-box announce socket (per-room keying is the carry-forward): a
        // second tagged peer DISPLACES the first — announces now flow to the new
        // socket. Warn so a reconnect flap or an unexpected extra standby is
        // observable rather than silently re-pointing the announce stream.
        logger.warn('G3.2b: inter-relay peer re-attached, displacing the prior announce socket');
      }
      attachedInterRelaySocket = ws;
      interRelay?.attachPeerSocket?.(ws);
      logger.info('G3.2b: inter-relay peer connected + attached (tagged)');
    }

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
      // G3.2b: detach the inter-relay announce socket when this tagged peer goes
      // away (single-box; only if it is still the attached one).
      if (attachedInterRelaySocket === ws) {
        attachedInterRelaySocket = null;
        interRelay?.attachPeerSocket?.(null);
      }
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

      case 'pipe-producer': {
        handlePipeProducerAnnounce(msg, ws);
        break;
      }

      case 'setConsumerLayers': {
        await handleSetConsumerLayers(ws, msg);
        break;
      }

      default: {
        logger.warn({ type: (msg as { type: string }).type }, 'Unknown signaling message type');
      }
    }
  }

  /**
   * G1 STANDBY side — record an inbound inter-relay producer announce.
   * The primary pushes these so the standby can resolve the real producerId
   * for its warm pipe + for client consume requests that omit producerId.
   */
  function handlePipeProducerAnnounce(msg: PipeProducerMessage, ws: WebSocket): void {
    if (!interRelay) {
      logger.debug('Received pipe-producer announce but no InterRelayContext — ignoring');
      return;
    }
    // G3.2b dispatch gate: with INTER_RELAY_TOKEN set, only a tagged inter-relay
    // peer may inject a server-side announce (an unauthed client cannot poison
    // the standby registry — the original threat). Token unset → gate open.
    if (interRelayToken !== '' && !interRelayPeers.has(ws)) {
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
  }

  async function handleJoin(ws: WebSocket, msg: JoinMessage): Promise<void> {
    const { roomId, peerId } = msg;

    // CI-18 real fix: serialize room creation per-room. If another join is
    // already in flight for this roomId, await its completion before reading
    // rooms.get(roomId). Without this, parallel joins each create their own
    // Router and end up in separate rooms.
    const pending = roomCreationLocks.get(roomId);
    if (pending) await pending;

    let room = rooms.get(roomId);
    if (!room) {
      let release!: () => void;
      const creation = new Promise<void>((resolve) => {
        release = resolve;
      });
      roomCreationLocks.set(roomId, creation);
      try {
        // Re-check inside the lock — a concurrent waiter that completed
        // between our await above and our set here may have already created
        // the room.
        room = rooms.get(roomId);
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

          // G3.2b: on the first peer join for a room this relay is STANDBY for,
          // hand the room's router to the wiring layer so it builds the
          // RoomTopology + opens the paused warm pipe (StandbyWarmPipeCoordinator
          // .ensure) — running M1's ensureWarmPipe in the LIVE signaling path.
          // Fired once per room (inside the creation block); the primary never
          // warm-pipes to itself.
          if (interRelay?.role === 'standby') {
            interRelay.onStandbyRoomReady?.(roomId, room.router);
          }
        }
      } finally {
        release();
        roomCreationLocks.delete(roomId);
      }
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

    // G1 PRIMARY side — announce this producer to the paired standby so it can
    // resolve the real producerId for its warm pipe + client consume requests.
    // Only the primary announces (the standby is the consumer of announces).
    if (interRelay && interRelay.role === 'primary') {
      interRelay.announceProducer(mapping.roomId, producer);
      logger.info(
        { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId },
        'Inter-relay: announced producer to standby (primary)',
      );
    }

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

    const consumer = await createConsumer(room, peer, producerId, msg.rtpCapabilities, logger);
    if (!consumer) {
      sendJson(ws, { type: 'error', message: 'Cannot consume producer' });
      return;
    }

    sendJson(ws, {
      type: 'consumed',
      consumerId: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
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
   */
  async function handleSetConsumerLayers(
    ws: WebSocket,
    msg: SetConsumerLayersMessage,
  ): Promise<void> {
    const mapping = wsToRoom.get(ws);
    if (!mapping) return;

    const room = rooms.get(mapping.roomId);
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
        // G1: drop the inter-relay announce records for this room (standby side).
        interRelay?.registry.clear(roomId);
        logger.info({ roomId }, 'Room closed (no peers remaining)');
      }
    }

    wsToRoom.delete(ws);
    logger.info({ roomId, peerId }, 'Peer disconnected from relay');
  }

  /**
   * F60 (DOH-021): flip the stop-accept gate. `setAccepting(false)` makes the
   * connection handler refuse NEW non-inter-relay upgrades (1001). Synchronous;
   * P8 calls it first in the graceful-shutdown sequence (runGracefulShutdown).
   */
  function setAccepting(next: boolean): void {
    accepting = next;
  }

  /**
   * F60 (DOH-021): force-close the remaining CLIENT peer sockets. Iterates
   * `wsToRoom.keys()` (only peers that have joined a room; inter-relay peers
   * never `join` → auto-exempt) and closes each with 1001. The existing
   * `ws.on('close')` → `handleDisconnect` does the room teardown — no double-free.
   */
  function closeRooms(): void {
    for (const ws of wsToRoom.keys()) {
      ws.close(1001);
    }
  }

  return {
    wss,
    getRoomCount: () => rooms.size,
    setAccepting,
    closeRooms,
  };
}
