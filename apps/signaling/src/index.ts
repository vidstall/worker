/**
 * DVConf Signaling Server
 *
 * Minimal WebSocket server for WebRTC ICE candidate and SDP exchange.
 * Routes messages between peers in the same room.
 *
 * DAEMON-02: This server has ZERO chain dependencies.
 * It does NOT import any Sui SDK or chain-related module.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createLogger } from '@dvconf/shared';
import { RoomManager } from './rooms.js';

const logger = createLogger('signaling');
const roomManager = new RoomManager();

const PORT = parseInt(process.env['SIGNALING_PORT'] ?? '8080', 10);

/** Inbound message types from clients. */
interface JoinMessage {
  type: 'join';
  roomId: string;
}

interface OfferMessage {
  type: 'offer';
  sdp: unknown;
  targetPeerId: string;
}

interface AnswerMessage {
  type: 'answer';
  sdp: unknown;
  targetPeerId: string;
}

interface IceCandidateMessage {
  type: 'ice-candidate';
  candidate: unknown;
  targetPeerId: string;
}

interface LeaveMessage {
  type: 'leave';
}

type SignalingMessage =
  | JoinMessage
  | OfferMessage
  | AnswerMessage
  | IceCandidateMessage
  | LeaveMessage;

/** Map peerId -> WebSocket for targeted message delivery. */
const peerSockets = new Map<string, WebSocket>();

export function createServer(port: number = PORT): WebSocketServer {
  const wss = new WebSocketServer({ port });

  wss.on('connection', (ws) => {
    const peerId = randomUUID();
    peerSockets.set(peerId, ws);

    // Send the assigned peer ID to the client
    ws.send(JSON.stringify({ type: 'welcome', peerId }));

    logger.info({ peerId }, 'Peer connected');

    ws.on('message', (data) => {
      let msg: SignalingMessage;
      try {
        msg = JSON.parse(data.toString()) as SignalingMessage;
      } catch {
        logger.warn({ peerId }, 'Invalid JSON received');
        return;
      }

      switch (msg.type) {
        case 'join': {
          roomManager.join(msg.roomId, ws, peerId);
          logger.info(
            { peerId, roomId: msg.roomId, roomSize: roomManager.getRoomSize(msg.roomId) },
            'Peer joined room',
          );
          break;
        }

        case 'offer':
        case 'answer': {
          const target = peerSockets.get(msg.targetPeerId);
          if (target && target.readyState === WebSocket.OPEN) {
            target.send(
              JSON.stringify({
                type: msg.type,
                sdp: msg.sdp,
                fromPeerId: peerId,
              }),
            );
          }
          break;
        }

        case 'ice-candidate': {
          const target = peerSockets.get(msg.targetPeerId);
          if (target && target.readyState === WebSocket.OPEN) {
            // Do NOT log ICE candidate contents (may contain private IPs)
            target.send(
              JSON.stringify({
                type: 'ice-candidate',
                candidate: msg.candidate,
                fromPeerId: peerId,
              }),
            );
          }
          break;
        }

        case 'leave': {
          roomManager.leave(ws);
          logger.info({ peerId }, 'Peer left room');
          break;
        }

        default: {
          logger.warn({ peerId, type: (msg as { type: string }).type }, 'Unknown message type');
        }
      }
    });

    ws.on('close', () => {
      roomManager.leave(ws);
      peerSockets.delete(peerId);
      logger.info({ peerId }, 'Peer disconnected');
    });

    ws.on('error', (err) => {
      logger.error({ peerId, err }, 'WebSocket error');
    });
  });

  wss.on('listening', () => {
    logger.info({ port }, 'Signaling server listening');
  });

  return wss;
}

// ── Graceful shutdown ───────────────────────────────────────────────

function shutdown(wss: WebSocketServer) {
  logger.info('Shutting down signaling server');
  wss.close(() => {
    logger.info('Signaling server closed');
    process.exit(0);
  });
  // Force exit after 5s if graceful close hangs
  setTimeout(() => process.exit(1), 5000);
}

// Only start the server when run directly (not imported in tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  const wss = createServer();
  process.on('SIGTERM', () => shutdown(wss));
  process.on('SIGINT', () => shutdown(wss));
}
