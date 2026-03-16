/**
 * DVConf Signaling Server
 *
 * Minimal WebSocket server for WebRTC ICE candidate and SDP exchange.
 * Routes messages between peers in the same room.
 *
 * Chain-aware: registers in SignalingRegistry, sends heartbeat + load updates.
 * Requirements: SIG-01, SIG-02
 */

import 'dotenv/config';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  SIGNALING_SESSION_REWARD,
} from '@dvconf/shared';
import { RoomManager, getSessionsRouted } from './rooms.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';

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
  (async () => {
    // Load chain configuration
    const config = loadNetworkConfig();
    const client = createSuiClient(config.rpcUrl);
    const signer = loadKeypair('SIGNALING_KEYPAIR');

    const endpointUrl = process.env['ENDPOINT_URL'] ?? `ws://127.0.0.1:${PORT}`;
    const region = process.env['REGION'] ?? 'local';

    const address = signer.toSuiAddress();
    logger.info(
      { address, rpcUrl: config.rpcUrl, packageId: config.packageId, endpointUrl, region },
      'Signaling daemon starting',
    );

    // Step 1: Auto-register on-chain
    const { minerCapId } = await ensureRegistered(client, signer, config, endpointUrl, region, logger);

    // Step 2: Start WebSocket server
    const wss = createServer();

    // Step 3: Start heartbeat loop (30s default)
    const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
    const stopHeartbeat = startHeartbeat(
      client,
      signer,
      config,
      minerCapId,
      roomManager,
      heartbeatIntervalMs,
      logger,
    );

    logger.info(
      { heartbeatIntervalMs, minerCapId, port: PORT },
      'Signaling daemon started — chain-aware mode',
    );

    // Step 4: Periodic reward eligibility logging (economic tracking)
    // Reports sessions routed for off-chain reward eligibility tracking.
    // On-chain reward claims are deferred to Phase 14+.
    //
    // Signaling slashing criteria (enforcement deferred to Phase 14+):
    //   - Dropping connections mid-session
    //   - Offline during assigned sessions
    //   - Failing to relay ICE/SDP messages between peers
    const rewardLogHandle = setInterval(() => {
      const routed = getSessionsRouted();
      if (routed > 0) {
        logger.info(
          {
            sessionsRouted: routed,
            rewardEligibility: routed * SIGNALING_SESSION_REWARD,
            rewardPerSession: SIGNALING_SESSION_REWARD,
          },
          `Sessions routed: ${routed} (reward eligibility: ${routed * SIGNALING_SESSION_REWARD})`,
        );
      }
    }, heartbeatIntervalMs);

    // Graceful shutdown with heartbeat cleanup
    const chainShutdown = () => {
      logger.info('Shutting down signaling daemon...');
      clearInterval(rewardLogHandle);
      stopHeartbeat();
      shutdown(wss);
    };

    process.on('SIGTERM', chainShutdown);
    process.on('SIGINT', chainShutdown);
  })().catch((err) => {
    logger.fatal({ err }, 'Signaling daemon crashed during startup');
    process.exit(1);
  });
}
