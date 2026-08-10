/**
 * mediasoup transport signaling: createTransport + connectTransport.
 *
 * Pure extraction from media-handler.ts. See that file's barrel re-export.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import { createWebRtcTransport } from '../room-handler.js';
import type { CreateTransportMessage, ConnectTransportMessage } from './messages.js';
import { sendJson } from './helpers.js';
import type { SignalingServerState, SignalingConfig, TurnContext } from './state.js';

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
