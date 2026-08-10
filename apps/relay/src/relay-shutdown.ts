/**
 * DVConf Relay Daemon — graceful-shutdown assembly.
 *
 * Pure extraction from index.ts's P17 M2b-P8 (DOH-020/021/024) F60 reactive
 * lifecycle block. The SelfShutdownWatcher self-terminates the relay on a
 * self-targeted on-chain RelaySlashed / NodeDegraded(level 2) or a network
 * pause; both it and a SIGTERM/SIGINT funnel through the SAME ordered
 * runGracefulShutdown (P5).
 */

import type { Logger, NetworkConfig } from '@dvconf/shared';
import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  runGracefulShutdown,
  readGracefulShutdownConfig,
} from '@dvconf/chain-event-listener';
import { buildRelayShutdownPlan, startRelaySelfShutdownWatcher } from './graceful-shutdown.js';
import { closeRelayProbe } from './room-handler.js';
import type { WebSocketServer } from 'ws';

export interface RelayShutdownWiringDeps {
  logger: Logger;
  client: SuiClient;
  graphqlClient: SuiGraphQLClient;
  config: NetworkConfig;
  minerCapId: string;
  setAccepting: (accepting: boolean) => void;
  closeRooms: () => void;
  stopHealthMonitor: () => void;
  standbyLinkManager: { shutdown: () => void };
  stopRelayEndpoints: () => Promise<void>;
  pipeLiveness: { stop: () => void };
  roomPoller: { stop: () => void };
  stopHeartbeat: () => void;
  metricsServer: { close: () => void };
  manager: { close: () => void };
  wss: WebSocketServer;
}

/**
 * Wires the SelfShutdownWatcher + ChainEventListener + SIGTERM/SIGINT
 * handlers, all funneling into the same ordered `runGracefulShutdown` plan.
 * Relay = the only slashable daemon → arms { slash, degraded, paused }.
 */
export async function setupRelayShutdown(deps: RelayShutdownWiringDeps): Promise<void> {
  const {
    logger,
    client,
    graphqlClient,
    config,
    minerCapId,
    setAccepting,
    closeRooms,
    stopHealthMonitor,
    standbyLinkManager,
    stopRelayEndpoints,
    pipeLiveness,
    roomPoller,
    stopHeartbeat,
    metricsServer,
    manager,
    wss,
  } = deps;

  const gracefulCfg = readGracefulShutdownConfig();
  const chainListener = new ChainEventListener({
    client: graphqlClient,
    packageId: config.originalPackageId ?? config.packageId,
    logger: logger.child({ component: 'self-shutdown-listener' }),
  });
  let selfShutdownWatcher: SelfShutdownWatcher | undefined;

  const runRelayShutdown = (reason: string): void => {
    void runGracefulShutdown(
      buildRelayShutdownPlan(reason, {
        logger,
        setAccepting,
        closeRooms,
        stopHealthMonitor, // C-A: relocated from FIRST into stopReactive
        stopWatcher: () => selfShutdownWatcher?.stop(),
        stopChainListener: () => chainListener.stop(),
        stopStandbyLink: () => standbyLinkManager.shutdown(),
        stopRelayEndpoints: () => stopRelayEndpoints(),
        stopRoomPoller: () => {
          pipeLiveness.stop(); // F1: stop the probe-liveness poll alongside the room poller
          roomPoller.stop();
        },
        stopHeartbeat, // C-B: relocated from EARLY into the LAST group
        closeRelayProbe,
        closeMetricsServer: () => metricsServer.close(),
        closeMediasoup: () => manager.close(),
        closeWss: () =>
          new Promise<void>((resolve) =>
            wss.close(() => {
              logger.info('Relay daemon closed');
              resolve();
            }),
          ),
        exit: (code) => process.exit(code),
        config: gracefulCfg,
      }),
    );
  };

  ({ watcher: selfShutdownWatcher } = await startRelaySelfShutdownWatcher({
    client,
    config,
    minerCapId,
    listener: chainListener,
    onSelfShutdown: (reason) => {
      logger.error({ reason }, 'self-shutdown triggered — initiating graceful shutdown');
      runRelayShutdown(reason);
    },
    logger,
  }));

  process.on('SIGTERM', () => runRelayShutdown('SIGTERM'));
  process.on('SIGINT', () => runRelayShutdown('SIGINT'));
}
