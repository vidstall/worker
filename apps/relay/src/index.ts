/**
 * DVConf Relay Daemon
 *
 * mediasoup-based SFU/MCU relay node for decentralized video conferencing.
 * Registers on-chain in RelayRegistry, runs mediasoup Workers,
 * accepts client WebSocket connections for mediasoup signaling,
 * and reports load via heartbeat.
 *
 * Chain-aware: registers in RelayRegistry, sends heartbeat + load updates.
 * Requirements: RELAY-05
 */

import 'dotenv/config';
import {
  createSuiClient,
  loadNetworkConfig,
  loadKeypair,
  createLogger,
  EventPoller,
} from '@dvconf/shared';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createMediasoupManager } from './mediasoup-manager.js';
import { createSignalingServer, type TurnContext } from './signaling.js';
import { MetricsTracker } from './metrics.js';
import { startMetricsServer } from './metrics-server.js';
import { closeRelayProbe } from './room-handler.js';
import { deriveCoturnUrl } from './coturn-url.js';
import { fetchTurnCredential } from './turn-fetcher.js';

const logger = createLogger('relay-daemon');

const WS_PORT = parseInt(process.env['WS_PORT'] ?? '4000', 10);

// Only start the server when run directly (not imported in tests)
const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isMainModule) {
  (async () => {
    // Load chain configuration
    const config = loadNetworkConfig();
    const client = createSuiClient(config.rpcUrl);
    const signer = loadKeypair('PRIVATE_KEY');

    const endpointUrl = process.env['RELAY_ENDPOINT_URL'] ?? `ws://127.0.0.1:${WS_PORT}`;
    const region = process.env['REGION'] ?? 'local';
    const relayMode = process.env['RELAY_MODE'] ?? 'sfu';

    const address = signer.toSuiAddress();
    logger.info(
      { address, rpcUrl: config.rpcUrl, packageId: config.packageId, endpointUrl, region, relayMode },
      'Relay daemon starting',
    );

    // Step 1: Auto-register on-chain
    const { minerCapId } = await ensureRegistered(client, signer, config, endpointUrl, region, logger);

    // Step 2: Create mediasoup Workers
    const manager = await createMediasoupManager(logger);

    // Step 3: Create metrics tracker
    const metrics = new MetricsTracker();

    // Step 4: Start WebSocket signaling server.
    // S30.C: build optional TurnContext when ENABLE_TURN_DELIVERY=1 +
    // CP_DAEMON_RPC_URL + TURN_RPC_TOKEN are set. The signaling layer
    // delegates the credential fetch per createTransport so it stays
    // decoupled from the cp-daemon RPC plumbing.
    const turnContext: TurnContext | undefined =
      process.env['ENABLE_TURN_DELIVERY'] === '1' &&
      process.env['CP_DAEMON_RPC_URL'] &&
      process.env['TURN_RPC_TOKEN']
        ? (() => {
            const coturnUrl = deriveCoturnUrl(endpointUrl);
            if (!coturnUrl) {
              logger.warn(
                { endpointUrl },
                'ENABLE_TURN_DELIVERY=1 but endpointUrl unparseable; TURN disabled',
              );
              return undefined;
            }
            const cpRpcUrl = process.env['CP_DAEMON_RPC_URL']!;
            const token = process.env['TURN_RPC_TOKEN']!;
            const stunUrl = process.env['STUN_URL'] ?? 'stun:stun.l.google.com:19302';
            const myMinerId = signer.toSuiAddress();
            logger.info(
              { coturnUrl, cpRpcUrl, stunUrl },
              'TURN delivery enabled; relay will inline iceServers in transportCreated',
            );
            return {
              buildIceServers: async (peerId: string) => {
                const cred = await fetchTurnCredential({
                  cpRpcUrl,
                  token,
                  targetMinerId: myMinerId,
                  userId: peerId,
                });
                if (cred === null) return null;
                return [
                  { urls: stunUrl },
                  {
                    urls: [coturnUrl],
                    username: cred.username,
                    credential: cred.password,
                  },
                ];
              },
            };
          })()
        : undefined;

    const { wss, getRoomCount } = createSignalingServer(
      manager,
      metrics,
      logger,
      turnContext,
    );

    // Step 5: Start metrics HTTP server (default port 4001)
    const metricsServer = startMetricsServer(metrics, logger);

    // Step 6: Start heartbeat loop (30s default)
    const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
    const stopHeartbeat = startHeartbeat(
      client,
      signer,
      config,
      minerCapId,
      metrics,
      getRoomCount,
      heartbeatIntervalMs,
      logger,
    );

    // Step 7: Poll room_manager events for MCU room assignments
    const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);
    const myMinerId = signer.toSuiAddress();
    const roomPoller = new EventPoller({
      client,
      packageId: config.packageId,
      module: 'room_manager',
      pollingIntervalMs: pollIntervalMs,
      cursorPath: '.cursors/room_manager.json',
      logger: logger.child({ poller: 'room_manager' }),
    });
    roomPoller.start(async (event) => {
      const eventName = event.type.split('::').pop() ?? '';
      if (eventName === 'RoomAssigned') {
        const data = event.parsedJson as Record<string, unknown>;
        const relayIds = data['relay_ids'] as string[] | undefined;
        const relayMode = data['relay_mode'] as number | undefined;
        if (relayIds && relayIds.includes(myMinerId)) {
          if (relayMode === 1) {
            logger.info(
              { roomId: data['room_id'], relayMode },
              'MCU pipeline initialized for room — composite output mode',
            );
          } else {
            logger.info(
              { roomId: data['room_id'], relayMode },
              'SFU room assigned — individual stream forwarding',
            );
          }
        }
      }
    });

    const metricsPort = parseInt(process.env['METRICS_PORT'] ?? '4001', 10);
    logger.info(
      {
        heartbeatIntervalMs,
        minerCapId,
        port: WS_PORT,
        metricsPort,
        workers: manager.workers.length,
        mode: relayMode,
      },
      'Relay daemon started — chain-aware mode',
    );

    // Graceful shutdown with worker cleanup
    const chainShutdown = () => {
      logger.info('Shutting down relay daemon...');
      stopHeartbeat();
      closeRelayProbe();
      metricsServer.close();
      manager.close();
      wss.close(() => {
        logger.info('Relay daemon closed');
        process.exit(0);
      });
      // Force exit after 5s if graceful close hangs
      setTimeout(() => process.exit(1), 5000);
    };

    process.on('SIGTERM', chainShutdown);
    process.on('SIGINT', chainShutdown);
  })().catch((err) => {
    logger.fatal({ err }, 'Relay daemon crashed during startup');
    process.exit(1);
  });
}
