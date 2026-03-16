/**
 * CP Daemon — Control Plane daemon entry point.
 *
 * Subscribes to relay/room events, runs relay scoring, sends heartbeat to ControlPlaneRegistry.
 * Uses @dvconf/shared for all chain interactions (DAEMON-12) with exponential backoff (DAEMON-07).
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
import { createEventHandler } from './event-handler.js';

const logger = createLogger('cp-daemon');

async function main(): Promise<void> {
  // Load configuration
  const config = loadNetworkConfig();
  const client = createSuiClient(config.rpcUrl);
  const signer = loadKeypair('CP_KEYPAIR');

  const address = signer.toSuiAddress();
  logger.info(
    { address, rpcUrl: config.rpcUrl, packageId: config.packageId },
    'CP daemon starting',
  );

  // Auto-register if CP_CAP_ID not in env
  const { cpCapId } = await ensureRegistered(client, signer, config, logger);

  // Start heartbeat loop
  const heartbeatIntervalMs = parseInt(process.env['HEARTBEAT_INTERVAL_MS'] ?? '30000', 10);
  const stopHeartbeat = startHeartbeat(
    client,
    signer,
    config,
    cpCapId,
    heartbeatIntervalMs,
    logger,
  );

  // Set up event handler with TX context for room assignment
  const { handler } = createEventHandler(logger, undefined, {
    client,
    signer,
    config,
    cpCapId,
  });

  // Poll relay_registry events
  const pollIntervalMs = parseInt(process.env['POLL_INTERVAL_MS'] ?? '5000', 10);

  const relayPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'relay_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/relay_registry.json',
    logger: logger.child({ poller: 'relay_registry' }),
  });

  const cpPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'control_plane_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/control_plane_registry.json',
    logger: logger.child({ poller: 'control_plane_registry' }),
  });

  const roomPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'room_manager',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/room_manager.json',
    logger: logger.child({ poller: 'room_manager' }),
  });

  const signalingPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'signaling_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/signaling_registry.json',
    logger: logger.child({ poller: 'signaling_registry' }),
  });

  const economicPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'economic_layer',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/economic_layer.json',
    logger: logger.child({ poller: 'economic_layer' }),
  });

  // Start all pollers
  await Promise.all([
    relayPoller.start(handler),
    cpPoller.start(handler),
    roomPoller.start(handler),
    signalingPoller.start(handler),
    economicPoller.start(handler),
  ]);

  logger.info(
    { heartbeatIntervalMs, pollIntervalMs },
    `CP daemon started — heartbeat every ${heartbeatIntervalMs}ms, polling events every ${pollIntervalMs}ms`,
  );

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('Shutting down CP daemon...');
    stopHeartbeat();
    relayPoller.stop();
    cpPoller.stop();
    roomPoller.stop();
    signalingPoller.stop();
    economicPoller.stop();
    logger.info('CP daemon shut down cleanly');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'CP daemon crashed');
  process.exit(1);
});
