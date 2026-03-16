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
} from '@dvconf/shared';
import { ensureRegistered } from './auto-register.js';
import { startHeartbeat } from './heartbeat.js';
import { createMediasoupManager } from './mediasoup-manager.js';
import { createSignalingServer } from './signaling.js';
import { MetricsTracker } from './metrics.js';
import { startMetricsServer } from './metrics-server.js';

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

    // Step 4: Start WebSocket signaling server
    const { wss, getRoomCount } = createSignalingServer(manager, metrics, logger);

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
