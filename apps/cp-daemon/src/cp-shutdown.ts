/**
 * CP Daemon — F60 graceful shutdown assembly.
 *
 * Pure extraction from index.ts (P17 M2b-P10, DOH-021/023/024).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { Logger, NetworkConfig } from '@dvconf/shared';
import { readIsPaused } from '@dvconf/shared';
import {
  ChainEventListener,
  SelfShutdownWatcher,
  type GracefulShutdownPlan,
  type GracefulShutdownConfig,
  type ShutdownReason,
} from '@dvconf/chain-event-listener';

/**
 * The cp-daemon's teardown closures, injected into {@link buildCpShutdownPlan}.
 * The cp-daemon is poller-only (no WS accept, nothing to drain) → `setAccepting`
 * and `drain` are NO-OPs; the substance is the ordered reactive → liveness-LAST
 * groups over the heartbeat + role-voting + the two watchers + the TURN/cap-token
 * issuers + the 8 EventPollers.
 */
export interface CpShutdownDeps {
  logger: Logger;
  /** (3) reactive — the M2a HealthMonitor chain-submit loop (C-A: stops HERE). */
  stopHealthMonitor: () => void;
  /** (3) reactive — the SelfShutdownWatcher pause poll. */
  stopWatcher: () => void;
  /** (3) reactive — the SelfShutdownWatcher's ChainEventListener (pause-arm only). */
  stopChainListener: () => Promise<void>;
  /** (3) reactive — the VOTE-06 role-voting loop. */
  stopRoleVoting: () => void;
  /** (3) reactive — the F47 re-vote watcher. */
  stopRevoteWatcher: () => void;
  /** (3) reactive — the RO-009 relay-heartbeat (Layer C) watcher. */
  stopRelayHeartbeatWatcher: () => void;
  /** (3) reactive — the WorkerConfirmedDead listener (room_health_alerts fast-failover path). */
  stopWorkerConfirmedDeadListener: () => void;
  /** (3) reactive — the room-health sweep (post-ejection relay reassignment). */
  stopRoomHealthSweep: () => void;
  /** (3) reactive — the room-expiry sweep (auto-close stale PENDING/READY rooms). */
  stopRoomExpirySweep: () => void;
  /** (3) reactive — the TURN issuer rotation loop. */
  stopTurnIssuer: () => void;
  /** (3) reactive — the F62 cap-token issuer epoch refresher. */
  stopCapTokenIssuer: () => void;
  /** (3) reactive — the optional TURN RPC HTTP server (null when TURN_RPC_TOKEN unset). */
  stopTurnRpc?: () => void;
  /** (3) reactive — the 8 control-plane EventPollers. */
  stopPollers: () => void;
  /** (4) LAST — heartbeat (C-B: moved here so the chain sees the daemon live). */
  stopHeartbeat: () => void;
  /** (4) LAST — the /healthz liveness server. */
  closeHealthz: () => Promise<void>;
  /**
   * (4) LAST — the optional Leg-7d /quorum/claims live carrier (null when QUORUM_CLAIMS_ENABLED
   * unset). Registered in the LAST group (mirror the healthz/turn-rpc liveness teardown) so the
   * loopback transport stays up through reactive teardown. Optional → the hermetic default never
   * provides it (no server was started).
   */
  closeQuorumClaimsServer?: () => Promise<void>;
  exit: (code: number) => never;
  config: GracefulShutdownConfig;
}

/**
 * Assemble the cp-daemon's ordered graceful-shutdown plan, encoding the two
 * cross-cutting composition rules:
 *   C-A — the M2a HealthMonitor is a chain-SUBMITTING reactive loop → it stops
 *         FIRST in `stopReactive` (with the watcher + ChainEventListener + the
 *         role-voting / re-vote / relay-heartbeat watchers + the TURN/cap-token
 *         issuers + the 9 pollers), NOT before the drain.
 *   C-B — heartbeat-stop moves to the LAST group (with /healthz) so the chain sees
 *         the cp LIVE through teardown (D-DOH-M2-F60-3 split-brain fix).
 * `setAccepting` + `drain` are NO-OPs (cp is poller-only). Exported (not inline) so
 * the order is unit-testable (graceful-shutdown-wiring.test.ts).
 */
export function buildCpShutdownPlan(
  reason: string,
  deps: CpShutdownDeps,
): GracefulShutdownPlan {
  return {
    reason,
    logger: deps.logger,
    setAccepting: () => {}, // NO-OP — cp has no connection accept
    drain: async () => {}, // NO-OP — poller-only, nothing in-flight
    stopReactive: async () => {
      deps.stopHealthMonitor(); // C-A
      deps.stopWatcher();
      await deps.stopChainListener();
      deps.stopRoleVoting();
      deps.stopRevoteWatcher();
      deps.stopRelayHeartbeatWatcher();
      deps.stopWorkerConfirmedDeadListener();
      deps.stopRoomHealthSweep();
      deps.stopRoomExpirySweep();
      deps.stopTurnIssuer();
      deps.stopCapTokenIssuer();
      deps.stopTurnRpc?.();
      deps.stopPollers();
    },
    stopHeartbeatAndHealthz: async () => {
      deps.stopHeartbeat(); // C-B → LAST
      await deps.closeHealthz();
      // Leg 7d — the live /quorum/claims carrier tears down in the LAST group (loopback transport
      // stays up through reactive teardown). Optional: absent in the hermetic default (no server).
      await deps.closeQuorumClaimsServer?.();
    },
    exit: deps.exit,
    drainTimeoutMs: deps.config.drainTimeoutMs,
    forceKillTimeoutMs: deps.config.forceKillTimeoutMs,
  };
}

/**
 * Assemble + start the cp-daemon's F60 SelfShutdownWatcher.
 *
 * The cp-daemon is NOT slashable (D-F60-4) and CP self-degradation is out of scope
 * (CP failover deferred to advisor gate 5) → arms = { paused } ONLY: it subscribes
 * NEITHER economic_layer NOR node_health, so only the `is_paused()` poll is armed.
 * Because both id-filtered arms are off, `ownMinerId` is unused → we pass `''` and
 * SKIP the {@link readCapMinerId} RPC (unlike validator-daemon, which arms
 * `degraded` and needs the self-filter id). The `paused` arm reads
 * `network_registry::is_paused` via {@link readIsPaused} (devInspect, fail-open).
 * The existing cp event-handler `RelaySlashed` arm (the TURN kill-switch for OTHER
 * relays) is UNTOUCHED — distinct from this self-targeted terminal trigger.
 * Exported so the arms + skipped-RPC wiring is unit-testable.
 */
export async function startCpSelfShutdownWatcher(args: {
  client: SuiClient;
  config: NetworkConfig;
  cpCapId: string;
  listener: ChainEventListener;
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
}): Promise<{ watcher: SelfShutdownWatcher; stop: () => void }> {
  const { client, config, listener, onSelfShutdown, logger: log } = args;
  const watcher = new SelfShutdownWatcher({
    listener,
    ownMinerId: '', // unused — both id-filtered arms (slash/degraded) are off
    arms: { slash: false, degraded: false, paused: true },
    onSelfShutdown,
    logger: log,
    isPaused: () => readIsPaused(client, config.packageId, config.networkRegistryId, log),
  });
  await watcher.start();
  return { watcher, stop: () => watcher.stop() };
}
