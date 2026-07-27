/**
 * P17 M2b-P8 (DOH-020/021/024) — the relay's F60 graceful-shutdown plan +
 * self-shutdown watcher assembly, extracted out of index.ts so the ordering
 * and wiring are unit-testable without booting the daemon.
 */

import type { SuiClient } from '@mysten/sui/client';
import type { NetworkConfig, Logger } from '@dvconf/shared';
import { readIsPaused, readCapMinerId } from '@dvconf/shared';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  type GracefulShutdownPlan,
  type GracefulShutdownConfig,
  type ShutdownReason,
} from '@dvconf/chain-event-listener';

/**
 * P17 M2b-P8 (DOH-021/024) — the relay's teardown closures, injected into
 * {@link buildRelayShutdownPlan}. Each maps a relay resource onto one of
 * runGracefulShutdown's ordered groups (drain → reactive → liveness LAST).
 */
export interface RelayShutdownDeps {
  logger: Logger;
  /** (1) Stop accepting new client sockets (P6 createSignalingServer accessor). */
  setAccepting: (accepting: boolean) => void;
  /** (2) drain — close client rooms (P6 accessor); inter-relay peers stay exempt. */
  closeRooms: () => void;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener pollers. */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the G3.2b inter-relay link + reconnect suppression. */
  stopStandbyLink: () => void;
  /** (3) reactive — the G3.2a relay-endpoint cache poller. */
  stopRelayEndpoints: () => Promise<void>;
  /** (3) reactive — the Step-7 room_manager business poller. */
  stopRoomPoller: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the relay live). */
  stopHeartbeat: () => void;
  /** (4) LAST — /api/probe state box. */
  closeRelayProbe: () => void;
  /** (4) LAST — the metrics HTTP server (/healthz + /api/probe + /metrics). */
  closeMetricsServer: () => void;
  /** (4) LAST — mediasoup Workers. */
  closeMediasoup: () => void;
  /** (4) LAST — the client WebSocket server (resolves when fully closed). */
  closeWss: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * P17 M2b-P8 (DOH-021/024) — assemble the relay's ordered graceful-shutdown plan,
 * encoding the two cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops in
 *         `stopReactive` (with the watcher + ChainEventListener + the G3.2b
 *         inter-relay link + the G3.2a endpoint poller + the room poller), NOT first.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz + /api/probe +
 *         mediasoup + wss) so the chain sees the relay LIVE through the whole drain
 *         (D-DOH-M2-F60-3 split-brain fix: a relay that stops heartbeating mid-drain
 *         is marked stale + permissionlessly promoted by its standby).
 * F1=Option A: the relay /healthz stays heartbeat-safe (always-2xx) — it is the
 * LAST thing torn down, never 503'd on a replay-degrade (P7 left it CORS-only).
 * Exported (not inline) so the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildRelayShutdownPlan(
  reason: string,
  deps: RelayShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: deps.setAccepting,
    drain: async () => {
      deps.closeRooms();
    },
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      deps.stopStandbyLink();
      await deps.stopRelayEndpoints();
      deps.stopRoomPoller();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      deps.closeRelayProbe();
      deps.closeMetricsServer();
      deps.closeMediasoup();
      await deps.closeWss();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * P17 M2b-P8 (DOH-020/024) — assemble + start the relay's F60 SelfShutdownWatcher.
 *
 * The relay is the only SLASHABLE daemon → arms = { slash, degraded, paused } (all).
 * `ownMinerId` = the cap's `miner_id` FIELD (the ID carried by
 * `RelaySlashed.relay_miner_id` + `NodeDegraded.miner_id`), read off-chain via
 * {@link readCapMinerId} — NOT the cap OBJECT id. The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * Exported so the arms + self-filter id + isPaused wiring is unit-testable.
 */
export async function startRelaySelfShutdownWatcher(args: {
  client: SuiClient;
  config: NetworkConfig;
  minerCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, minerCapId, listener, onSelfShutdown, logger } = args;
  const ownMinerId = await readCapMinerId(client, minerCapId, logger);
  if (ownMinerId === null) {
    logger.warn(
      { minerCapId },
      'startRelaySelfShutdownWatcher: could not resolve own miner_id — slash/degraded self-filter will not match (paused arm stays active)',
    );
  }
  const watcher = new SelfShutdownWatcher({
    listener,
    ownMinerId: ownMinerId ?? '',
    arms: { slash: true, degraded: true, paused: true },
    onSelfShutdown,
    logger,
    isPaused: () => readIsPaused(client, config.packageId, config.networkRegistryId, logger),
  });
  await watcher.start();
  return { watcher, stop: () => watcher.stop() };
}
