/**
 * CP Daemon — Control Plane daemon entry point.
 *
 * Subscribes to relay/room/validator/signaling/voting events, runs relay + validator
 * scoring, sends heartbeat to ControlPlaneRegistry, and participates in role voting.
 *
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
import { startRoleVoting } from './role-voter.js';
import { startTurnIssuer } from './turn-issuer.js';
import { startTurnRpc } from './turn-rpc.js';
// F62 Phase 3.1 — cap-token-issuer module surface. Production keystore + peer-CP
// discovery wiring is Phase 3.4 scope; this import keeps the symbol reachable +
// surfaces type-side coupling now so cross-module TS checks include it.
import './cap-token-issuer.js';

export { CapTokenIssuer } from './cap-token-issuer.js';
export type {
  CapTokenIssuerOpts,
  CpKeystore,
  SubmitFn as CapTokenSubmitFn,
  RoomAssignedEvent,
  RoleChangedEvent,
  RoleAssignedEvent,
  RelaySlashedEvent,
  SecretRotatedEvent,
} from './cap-token-issuer.js';

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

  // Start role voting loop (VOTE-06)
  const roleVotingIntervalMs = parseInt(process.env['ROLE_VOTING_INTERVAL_MS'] ?? '30000', 10);
  const stopRoleVoting = startRoleVoting(
    client,
    signer,
    config,
    cpCapId,
    logger,
    roleVotingIntervalMs,
  );

  // Bootstrap TURN issuer (S30.B Option A — ADR-0005 hybrid 24h+on-slash rotation)
  const turnRotationIntervalMs = parseInt(
    process.env['TURN_ROTATION_INTERVAL_MS'] ?? '86400000',
    10,
  );
  const { issuer: turnIssuer, stop: stopTurnIssuer } = await startTurnIssuer({
    client,
    signer,
    packageId: config.packageId,
    networkRegistryId: config.networkRegistryId,
    cpCapId,
    logger,
    rotateIntervalMs: turnRotationIntervalMs,
  });

  // S30.C: Optional TURN RPC HTTP server. Enabled iff TURN_RPC_TOKEN is set.
  // Relay daemon fetches credentials via POST /turn/issue during client room-join.
  const turnRpcToken = process.env['TURN_RPC_TOKEN'];
  const stopTurnRpc = turnRpcToken
    ? (
        await startTurnRpc({
          issuer: turnIssuer,
          port: parseInt(process.env['TURN_RPC_PORT'] ?? '8090', 10),
          token: turnRpcToken,
          logger,
        })
      ).stop
    : null;

  // Set up event handler with TX context for room assignment + TURN kill-switch
  const { handler, relayState, signalingState, validatorState } = createEventHandler(logger, undefined, {
    client,
    signer,
    config,
    cpCapId,
    turnIssuer,
  });

  // Bootstrap: replay historical relay/signaling/validator events so state maps are populated
  // before real-time polling starts (prevents race where relay registers before CP poller runs)
  for (const mod of ['relay_registry', 'signaling_registry', 'validator_registry', 'registration'] as const) {
    try {
      const events = await client.queryEvents({
        query: { MoveEventModule: { package: config.packageId, module: mod } },
        limit: 100,
      });
      for (const ev of events.data) {
        await handler(ev);
      }
      logger.info({ module: mod, count: events.data.length }, 'Bootstrap: replayed historical events');
    } catch (err) {
      logger.warn({ module: mod, err }, 'Bootstrap: failed to query historical events');
    }
  }
  logger.info(
    { relays: relayState.size, signaling: signalingState.size, validators: validatorState.size },
    'Bootstrap complete — state maps populated',
  );

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

  const validatorPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'validator_registry',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/validator_registry.json',
    logger: logger.child({ poller: 'validator_registry' }),
  });

  const roleVotingPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'role_voting',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/role_voting.json',
    logger: logger.child({ poller: 'role_voting' }),
  });

  const registrationPoller = new EventPoller({
    client,
    packageId: config.packageId,
    module: 'registration',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: '.cursors/registration.json',
    logger: logger.child({ poller: 'registration' }),
  });

  // Start all pollers
  await Promise.all([
    relayPoller.start(handler),
    cpPoller.start(handler),
    roomPoller.start(handler),
    signalingPoller.start(handler),
    economicPoller.start(handler),
    validatorPoller.start(handler),
    roleVotingPoller.start(handler),
    registrationPoller.start(handler),
  ]);

  logger.info(
    { heartbeatIntervalMs, pollIntervalMs, roleVotingIntervalMs, turnRotationIntervalMs },
    `CP daemon started — heartbeat every ${heartbeatIntervalMs}ms, polling events every ${pollIntervalMs}ms, role voting every ${roleVotingIntervalMs}ms, TURN secret rotating every ${turnRotationIntervalMs}ms`,
  );

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info('Shutting down CP daemon...');
    stopHeartbeat();
    stopRoleVoting();
    stopTurnIssuer();
    if (stopTurnRpc) {
      void stopTurnRpc();
    }
    relayPoller.stop();
    cpPoller.stop();
    roomPoller.stop();
    signalingPoller.stop();
    economicPoller.stop();
    validatorPoller.stop();
    roleVotingPoller.stop();
    registrationPoller.stop();
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
