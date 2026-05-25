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
  type Logger,
} from '@dvconf/shared';
import { RoomManager, getSessionsRouted } from './rooms.js';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import {
  createSignalingLatencyProbe,
  type SignalingLatencyProbe,
} from './latency-probe.js';
import {
  ensureBenchHttpServer,
  closeBenchHttpServer,
} from './bench-endpoint.js';

const logger = createLogger('signaling');
const roomManager = new RoomManager();

let cachedProbe: SignalingLatencyProbe | null = null;
let probeInitialized = false;

/**
 * Module-singleton accessor for the signaling latency probe (S23.1.A2).
 * Off-by-default: returns null unless `BENCH_LATENCY=1`. Mirrors cp-daemon +
 * relay `latency-probe.ts` singleton pattern.
 */
function ensureSignalingProbe(log: Logger): SignalingLatencyProbe | null {
  if (probeInitialized) return cachedProbe;
  probeInitialized = true;
  cachedProbe = createSignalingLatencyProbe(
    process.env['SIGNALING_INSTANCE'] ?? 'signaling-default',
    log,
  );
  return cachedProbe;
}

function closeSignalingProbe(): void {
  if (cachedProbe !== null) {
    cachedProbe.close();
    cachedProbe = null;
    probeInitialized = false;
  }
}

const PORT = parseInt(process.env['SIGNALING_PORT'] ?? '8080', 10);

/**
 * Inbound message types from clients.
 *
 * Phase 3.2 (REQ-ADM-004): the `token`, `signature`, and `nonce` fields are
 * optional on the wire schema so this extension stays backwards-compatible
 * with the Stage 1-2 unauthenticated test harness. Stage 4 will gate the
 * mainline `join` switch case behind `auth.ts::AuthHook.verifyJoin` which
 * REQUIRES the three new fields per CONTRACTS.md § 4.5.
 *
 * `token` is the Sui object ID STRING of the RoomCapability (NOT a BCS blob,
 * per D-010-C). `signature` is base64-encoded raw ed25519 over the canonical
 * BCS payload `{ roomId, peerPubkey, nonce }`. `nonce` is a monotonic
 * per-peer counter; Phase 3.4 will enforce strict-greater.
 */
interface JoinMessage {
  type: 'join';
  roomId: string;
  /** Sui object ID of the RoomCapability (Phase 3.2 — D-010-C). Optional during transition. */
  token?: string;
  /** Base64 ed25519 signature over BCS({roomId, peerPubkey, nonce}). */
  signature?: string;
  /** Monotonic per-peer counter (u64 fits in JS Number for thesis scale). */
  nonce?: number;
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

// ── Rate limiting ───────────────────────────────────────────────────

const MAX_CONNECTIONS_PER_IP = 10;
const ipConnectionCount = new Map<string, number>();

const MAX_MESSAGES_PER_SECOND = 100;

export function createServer(port: number = PORT): WebSocketServer {
  const wss = new WebSocketServer({ port, maxPayload: 64 * 1024 });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress ?? 'unknown';

    // Per-IP connection rate limiting
    const currentCount = ipConnectionCount.get(ip) ?? 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      logger.warn({ ip }, 'Connection rejected: too many connections from IP');
      ws.close(4029, 'Too many connections');
      return;
    }
    ipConnectionCount.set(ip, currentCount + 1);

    // Per-connection message rate limiting state
    const messageTimestamps: number[] = [];

    const peerId = randomUUID();
    peerSockets.set(peerId, ws);

    // Send the assigned peer ID to the client
    ws.send(JSON.stringify({ type: 'welcome', peerId }));

    // S23.1.A2: attach bench-ping/bench-pong latency probe when BENCH_LATENCY=1.
    // The probe is null otherwise — zero-cost branch.
    const probe = ensureSignalingProbe(logger);
    const detachProbe = probe !== null ? probe.attach(ws, peerId) : null;

    logger.info({ peerId, ip }, 'Peer connected');

    ws.on('message', (data) => {
      // Message rate limit: max MAX_MESSAGES_PER_SECOND per second per connection
      const now = Date.now();
      const windowStart = now - 1000;
      // Remove timestamps older than 1 second
      while (messageTimestamps.length > 0 && messageTimestamps[0]! < windowStart) {
        messageTimestamps.shift();
      }
      if (messageTimestamps.length >= MAX_MESSAGES_PER_SECOND) {
        logger.warn({ peerId, ip }, 'Connection closed: message rate limit exceeded');
        ws.close(4029, 'Rate limit exceeded');
        return;
      }
      messageTimestamps.push(now);
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
      // Stop bench-ping probe before clearing peer state (S23.1.A2)
      if (detachProbe !== null) detachProbe();
      roomManager.leave(ws);
      peerSockets.delete(peerId);
      // Decrement IP connection count
      const count = ipConnectionCount.get(ip) ?? 1;
      if (count <= 1) {
        ipConnectionCount.delete(ip);
      } else {
        ipConnectionCount.set(ip, count - 1);
      }
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

    // S23.2.C2: optional /bench/event HTTP receiver for external clients
    // (Node mediasoup-client harness + future browser RTCStats collector).
    // Off-by-default — only listens when BENCH_LATENCY=1.
    const benchHandle = ensureBenchHttpServer(logger);
    if (benchHandle !== null) {
      const benchPort = parseInt(process.env['BENCH_PORT'] ?? '8081', 10);
      benchHandle.server.listen(benchPort, () => {
        logger.info(
          { benchPort, path: '/bench/event' },
          'Bench HTTP endpoint listening',
        );
      });
    }

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
      closeSignalingProbe();
      closeBenchHttpServer();
      shutdown(wss);
    };

    process.on('SIGTERM', chainShutdown);
    process.on('SIGINT', chainShutdown);
  })().catch((err) => {
    logger.fatal({ err }, 'Signaling daemon crashed during startup');
    process.exit(1);
  });
}
