/**
 * CP Daemon — watcher/sweep wiring.
 *
 * Pure extraction from index.ts's main(): role-voting, the F47 re-vote
 * watcher, the RO-009 relay-heartbeat (Layer C) watcher, the
 * WorkerConfirmedDead fast-failover listener, the room-health sweep, and the
 * room-expiry sweep. All share the same live SuiChainStateReader (`reader`,
 * ALSO reused later by the cap-token issuer's Leg 7c discovery reads — see
 * cp-issuers-wiring.ts) and the live epoch duration (`sysState`).
 */

import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, NetworkConfig } from '@dvconf/shared';
import { startRoleVoting } from './role-voter.js';
import { startRevoteWatcher, makeMarkSubmitter, resolveScanIntervalEpochs } from './revote-watcher.js';
import { SuiChainStateReader } from './sui-chain-state-reader.js';
import {
  startRoomHealthSweep,
  makePromoteAfterEjectionSubmitter,
  makeSpillRelaySubmitter,
  resolveMaxHeartbeatEpochs as resolveRoomHealthMaxHeartbeatEpochs,
} from './room-health-sweep.js';
import { LiveRoomHealthChainStateReader } from './room-health-chain-state-reader.js';
import {
  startRoomExpirySweep,
  makeCloseExpiredRoomSubmitter,
  resolvePendingExpiryMs,
  resolveReadyExpiryMs,
  type RoomLifecycleTimestamps,
} from './room-expiry-sweep.js';
import { LiveRoomExpiryChainStateReader } from './room-expiry-chain-state-reader.js';
import {
  startRelayHeartbeatWatcher,
  makePromoteSubmitter,
  makeReplacementSubmitter,
  makeLiveReplacementCandidateSelector,
  resolveMaxHeartbeatEpochs,
} from './relay-heartbeat-watcher.js';
import { LiveRelayChainStateReader } from './relay-chain-state-reader.js';
import { startWorkerConfirmedDeadListener } from './worker-confirmed-dead-listener.js';

export interface CpWatchersParams {
  client: SuiClient;
  graphqlClient: SuiGraphQLClient;
  signer: Ed25519Keypair;
  config: NetworkConfig;
  cpCapId: string;
  logger: Logger;
  /** Same RoomLifecycleMetricsSink the room-expiry sweep reports to (built in index.ts alongside the Prometheus registry). */
  roomLifecycleMetricsSink: {
    setRoomsActive: (count: number) => void;
    observeRoomDurationSeconds: (seconds: number) => void;
  };
}

export interface CpWatchers {
  /** Reused by cp-issuers-wiring.ts's cap-token issuer (Leg 7c discovery reads) — one instance. */
  reader: SuiChainStateReader;
  roleVotingIntervalMs: number;
  /** Shared with cp-pollers-wiring.ts's trackedHandler (recordRoomLifecycleTimestamp writes here). */
  roomTimestamps: Map<string, RoomLifecycleTimestamps>;
  stopRoleVoting: () => void;
  stopRevoteWatcher: () => void;
  stopRelayHeartbeatWatcher: () => void;
  stopWorkerConfirmedDeadListener: () => void;
  stopRoomHealthSweep: () => void;
  stopRoomExpirySweep: () => void;
}

export async function buildCpWatchers(params: CpWatchersParams): Promise<CpWatchers> {
  const { client, graphqlClient, signer, config, cpCapId, logger, roomLifecycleMetricsSink } = params;

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

  // F47 RV-013 (Phase 4.0) — re-vote watcher, now wired with the live
  // SuiChainStateReader. The watcher scans on-chain state every `scanEpochs`
  // epochs and submits permissionless `mark_revote_eligible_*` TXs (idle +
  // composition-shift); every mark re-validates on-chain, so the daemon is
  // advisory. Cadence resolves from REVOTE_SCAN_INTERVAL_EPOCHS via
  // resolveScanIntervalEpochs(); the epoch→ms conversion happens here where the
  // live epoch duration is known.
  const reader = new SuiChainStateReader(client, config, logger);
  const scanEpochs = resolveScanIntervalEpochs();
  // epoch→ms: prefer an explicit ms override (demo/localnet set a small value),
  // else derive from the live epoch duration. No hardcode.
  const sysState = await client.getLatestSuiSystemState();
  const revoteIntervalMs = parseInt(
    process.env['REVOTE_SCAN_INTERVAL_MS'] ?? String(scanEpochs * Number(sysState.epochDurationMs)),
    10,
  );
  const stopRevoteWatcher = startRevoteWatcher(
    reader,
    makeMarkSubmitter(client, signer, config, logger),
    logger,
    revoteIntervalMs,
  );
  logger.info({ module: 'cp-daemon', scanEpochs, revoteIntervalMs }, 'revote watcher started');

  // M1 Phase 3.1 (REQ-RO-009) — RelayHeartbeatWatcher (Layer C, chain-authoritative).
  // Mirrors the revote-watcher wiring above: a LiveRelayChainStateReader over the
  // devInspect seam feeds the watcher, which submits permissionless `promote_relay`
  // PTBs (via makePromoteSubmitter) when a primary's heartbeat is stale > 3 epochs
  // and the standby is fresh. The chain re-asserts staleness (E_RELAY_NOT_STALE) so
  // the daemon is advisory. Cadence: RELAY_HEARTBEAT_SCAN_INTERVAL_MS (default = the
  // live epoch duration, so detection lands within the ~3-epoch threshold window;
  // C2: this poll cadence is now honored, NOT hardcoded). Phase 5.3 bench tunes it.
  const relayReader = new LiveRelayChainStateReader(client, config, logger);
  const relayHeartbeatScanMs = parseInt(
    process.env['RELAY_HEARTBEAT_SCAN_INTERVAL_MS'] ?? String(Number(sysState.epochDurationMs)),
    10,
  );
  const relayHeartbeatWatcher = startRelayHeartbeatWatcher(
    relayReader,
    makePromoteSubmitter(client, signer, config, logger),
    logger,
    {
      pollIntervalMs: relayHeartbeatScanMs,
      // REQ-RMS-024 (D2) — env-tunable threshold, clamped to the Move MAX_HEARTBEAT_EPOCHS
      // floor: a value below it would fire promote_relay PTBs the chain aborts (E_RELAY_NOT_STALE).
      maxHeartbeatEpochs: resolveMaxHeartbeatEpochs(process.env['RELAY_MAX_HEARTBEAT_EPOCHS'], logger),
    },
    // Standby-death vote-in (relay_replacement.move) — same watcher, same cadence, a
    // separate dedup namespace from the primary-promotion path above.
    makeReplacementSubmitter(client, signer, config, cpCapId, logger),
    makeLiveReplacementCandidateSelector(relayReader),
  );
  const stopRelayHeartbeatWatcher = (): void => relayHeartbeatWatcher.stop();
  logger.info(
    { module: 'cp-daemon', relayHeartbeatScanMs },
    'relay heartbeat watcher started (Layer C)',
  );

  // Fast, room-scoped alternative failover path (see room_health_alerts.move):
  // reacts to WorkerConfirmedDead (client-alert + room-health-validator quorum,
  // enforced off the chain's epoch clock) rather than relay-heartbeat-watcher's
  // epoch-gated staleness check above. No-ops if roomHealthAlertBoxId is unset.
  const workerConfirmedDeadListener = startWorkerConfirmedDeadListener({
    client: graphqlClient,
    suiClient: client,
    config,
    signer,
    cpCapId,
    logger,
  });
  const stopWorkerConfirmedDeadListener = (): void => workerConfirmedDeadListener.stop();
  logger.info({ module: 'cp-daemon' }, 'WorkerConfirmedDead listener started');

  // Room health sweep — closes the gap where a validator-quorum liveness
  // ejection (registration::execute_ejection) removes a relay node from its
  // registry without ever touching RoomManager, leaving a room's assignment
  // dangling forever. Complements relay-heartbeat-watcher (which owns the
  // "primary stale, live standby already assigned" case): this sweep handles
  // the "primary fully ejected" and "no live standby at all" relay gaps.
  const roomHealthReader = new LiveRoomHealthChainStateReader(client, config, logger);
  const roomHealthScanMs = parseInt(
    process.env['ROOM_HEALTH_SCAN_INTERVAL_MS'] ?? String(Number(sysState.epochDurationMs)),
    10,
  );
  const roomHealthSweep = startRoomHealthSweep(
    roomHealthReader,
    {
      promoteAfterEjection: makePromoteAfterEjectionSubmitter(client, signer, config, logger),
      spillRelay: makeSpillRelaySubmitter(client, signer, config, cpCapId, logger),
    },
    logger,
    {
      pollIntervalMs: roomHealthScanMs,
      maxHeartbeatEpochs: resolveRoomHealthMaxHeartbeatEpochs(process.env['ROOM_HEALTH_MAX_HEARTBEAT_EPOCHS'], logger),
    },
  );
  const stopRoomHealthSweep = (): void => roomHealthSweep.stop();
  logger.info({ module: 'cp-daemon', roomHealthScanMs }, 'room health sweep started');

  // Room expiry sweep — auto-closes rooms stuck PENDING (never assigned a
  // relay/CP) past 15 minutes, or READY/ACTIVE (assigned but never manually
  // closed by their creator) past 1 hour. The chain has no Clock; elapsed
  // wall-clock time is judged entirely here from RoomCreated/RoomAssigned
  // event timestamps (see room-expiry-sweep.ts's module doc). `roomTimestamps`
  // is fed passively by `trackedHandler` (cp-pollers-wiring.ts), off the same
  // event stream the pollers already consume — declared here (ahead of its
  // first read) so both the reader and the handler close over the same map
  // instance.
  const roomTimestamps = new Map<string, RoomLifecycleTimestamps>();
  const roomExpiryReader = new LiveRoomExpiryChainStateReader(client, config, roomTimestamps, logger);
  const roomExpiryScanMs = parseInt(process.env['ROOM_EXPIRY_SCAN_INTERVAL_MS'] ?? '60000', 10);
  const roomExpirySweep = startRoomExpirySweep(
    roomExpiryReader,
    makeCloseExpiredRoomSubmitter(client, signer, config, cpCapId, logger),
    logger,
    {
      pollIntervalMs: roomExpiryScanMs,
      pendingExpiryMs: resolvePendingExpiryMs(process.env['ROOM_EXPIRY_PENDING_MS'], logger),
      readyExpiryMs: resolveReadyExpiryMs(process.env['ROOM_EXPIRY_READY_MS'], logger),
    },
    roomLifecycleMetricsSink,
  );
  const stopRoomExpirySweep = (): void => roomExpirySweep.stop();
  logger.info({ module: 'cp-daemon', roomExpiryScanMs }, 'room expiry sweep started');

  return {
    reader,
    roleVotingIntervalMs,
    roomTimestamps,
    stopRoleVoting,
    stopRevoteWatcher,
    stopRelayHeartbeatWatcher,
    stopWorkerConfirmedDeadListener,
    stopRoomHealthSweep,
    stopRoomExpirySweep,
  };
}
