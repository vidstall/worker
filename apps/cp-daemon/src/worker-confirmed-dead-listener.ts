/**
 * WorkerConfirmedDead listener -- reacts to room_health_alerts.move's fast,
 * room-scoped client-alert + validator-quorum confirmation (see
 * room_health_alerts.move's module doc) by driving a relay swap via
 * `promote_relay_via_health_alert`, bypassing `promote_relay`'s epoch-staleness
 * gate entirely (that gate can't fire for days on a real network -- see
 * relay-heartbeat-watcher.ts's own doc for why).
 *
 * Mirrors liveness-sweep.ts's `ejectionPoller` block: a single EventPoller on the
 * satellite `_events` module, filtering by event type, resolving what it needs
 * off-chain, then submitting one follow-up TX via `executeWithRetry`. Only relay
 * targets are actionable today -- cp/signaling targets have no "promote a
 * standby" concept in this codebase yet, so they're logged, not acted on.
 *
 * Relay-target branch (REQ-RMS-024): if the confirmed-dead target is assigned_relays[0]
 * (the primary), this drives `promote_relay_via_health_alert` as before (unchanged). If
 * it's found elsewhere in assigned_relays[1..] (a standby), this instead drives
 * `propose_relay_replacement` (relay_replacement.move) with a FRESH candidate picked via
 * `selectReplacementCandidate` -- promote_relay_via_health_alert only swaps slot 0 and
 * would silently no-op / misapply for a standby target.
 */
import { join } from 'node:path';
import type { SuiClient } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import {
  createLogger,
  executeWithRetry,
  EventPoller,
  type NetworkConfig,
  type Logger,
} from '@dvconf/shared';
import { LiveRelayChainStateReader } from './relay-chain-state-reader.js';
import { makeLiveReplacementCandidateSelector } from './relay-heartbeat-watcher.js';

const MODULE = 'worker-confirmed-dead-listener';

const cursorDir = (name: string): string => join(process.env.DATA_DIR ?? '.', '.cursors', name);

/** Move's constants::role_relay() -- mirrored here since this listener is TS-only. */
const ROLE_RELAY = 2;

interface WorkerConfirmedDeadPayload {
  room_id?: string;
  target_miner_id?: string;
  target_role?: number | string;
  client_alert_count?: string;
  validator_vote_count?: string;
}

export interface WorkerConfirmedDeadListenerOptions {
  client: SuiGraphQLClient;
  suiClient: SuiClient;
  config: NetworkConfig;
  signer: Ed25519Keypair;
  /** Required to submit `propose_relay_replacement` for a confirmed-dead STANDBY target. */
  cpCapId?: string;
  logger?: Logger;
  pollIntervalMs?: number;
}

export interface WorkerConfirmedDeadListenerHandle {
  stop: () => void;
}

/**
 * Submit `promote_relay_via_health_alert` for `roomId`, swapping the room's
 * primary to `newPrimary`. Returns true on genuine on-chain success.
 */
async function submitPromoteViaHealthAlert(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  alertBoxId: string,
  roomId: string,
  newPrimary: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        // promote_relay_via_health_alert is defined in the room_manager_failover
        // satellite module (failover.move), same as promote_relay.
        target: `${config.packageId}::room_manager_failover::promote_relay_via_health_alert`,
        arguments: [
          tx.object(config.networkRegistryId),  // &NetworkRegistry
          tx.object(config.roomManagerId),      // &mut RoomManager
          tx.object(config.relayRegistryId),    // &RelayRegistry
          tx.object(alertBoxId),                // &mut RoomHealthAlertBox
          tx.pure.id(roomId),                   // room_id: ID
          tx.pure.id(newPrimary),               // new_primary: ID
        ],
      });
    },
    'promote-relay-via-health-alert',
    logger,
  );
  return result !== null;
}

/**
 * Submit `propose_relay_replacement` for `roomId`, voting `candidateRelayId` in for the
 * confirmed-dead STANDBY `deadRelayId` (never index 0/primary -- that's
 * `submitPromoteViaHealthAlert`'s job). `submittedScore` is a fixed placeholder (this vote
 * only decides WHO replaces the dead standby, not room scoring). Returns true on genuine
 * on-chain success (which may just be recording this CP's vote, not necessarily finalizing
 * the swap -- quorum may need other CPs' votes too).
 */
async function submitReplacementViaHealthAlert(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  alertBoxId: string,
  cpCapId: string,
  roomId: string,
  deadRelayId: string,
  candidateRelayId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::room_manager_relay_replacement::propose_relay_replacement`,
        arguments: [
          tx.object(config.networkRegistryId),   // net_reg: &NetworkRegistry
          tx.object(config.roomManagerId),       // manager: &mut RoomManager
          tx.object(config.cpRegistryId),        // cp_reg: &mut ControlPlaneRegistry
          tx.object(config.relayRegistryId),     // relay_reg: &mut RelayRegistry
          tx.object(alertBoxId),                 // alert_box: &mut RoomHealthAlertBox
          tx.object(cpCapId),                    // cap: &ControlPlaneCap
          tx.pure.id(roomId),                    // room_id: ID
          tx.pure.id(deadRelayId),               // dead_relay_id: ID
          tx.pure.id(candidateRelayId),           // candidate_relay_id: ID
          tx.pure.u64(0),                         // submitted_score: u64 (placeholder)
        ],
      });
    },
    'propose-relay-replacement-via-health-alert',
    logger,
  );
  return result !== null;
}

/**
 * Start the `WorkerConfirmedDead` listener. No-ops (does not throw) if
 * `config.roomHealthAlertBoxId` is unset -- this feature is additive, and a
 * deployment that hasn't published/initialized room_health_alerts.move yet
 * should keep running without it. Returns a handle whose `stop()` clears the
 * underlying EventPoller.
 */
export function startWorkerConfirmedDeadListener(
  opts: WorkerConfirmedDeadListenerOptions,
): WorkerConfirmedDeadListenerHandle {
  const {
    client, suiClient, config, signer, cpCapId,
    logger = createLogger(MODULE),
    pollIntervalMs = 30_000,
  } = opts;

  if (!config.roomHealthAlertBoxId) {
    logger.info({ module: MODULE }, 'roomHealthAlertBoxId unset — WorkerConfirmedDead listener disabled');
    return { stop: () => {} };
  }
  const alertBoxId = config.roomHealthAlertBoxId;

  const relayReader = new LiveRelayChainStateReader(suiClient, config, logger.child({ module: MODULE }));
  const candidateSelector = makeLiveReplacementCandidateSelector(relayReader);
  let running = true;

  const poller = new EventPoller({
    client,
    // NOT config.originalPackageId -- room_health_alerts was added in a later
    // upgrade than the package's first-ever publish (same rationale as
    // liveness-sweep.ts's ejectionPoller).
    packageId: config.roomHealthAlertsOriginPackageId ?? config.originalPackageId ?? config.packageId,
    // NOT 'room_health_alerts' -- WorkerConfirmedDead is defined in the
    // companion room_health_alerts_events module (LOC-budget split).
    module: 'room_health_alerts_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('room-health-alerts-events.json'),
    logger: logger.child({ poller: 'room_health_alerts' }),
  });

  void poller.start(async (event) => {
    if (!running) return;
    if (!event.type?.endsWith('::WorkerConfirmedDead')) return;

    const parsed = event.parsedJson as WorkerConfirmedDeadPayload | undefined;
    const roomId = parsed?.room_id;
    const targetMinerId = parsed?.target_miner_id;
    const targetRole = parsed?.target_role !== undefined ? Number(parsed.target_role) : undefined;
    if (!roomId || !targetMinerId || targetRole === undefined) return;

    logger.info(
      { module: MODULE, roomId, targetMinerId, targetRole },
      'WorkerConfirmedDead observed',
    );

    if (targetRole !== ROLE_RELAY) {
      // No "promote a standby" concept for cp/signaling targets in this codebase
      // yet -- log-and-alert only (see module doc).
      logger.warn(
        { module: MODULE, roomId, targetMinerId, targetRole },
        'WorkerConfirmedDead for a non-relay role — no automated remediation for this role, human/ops attention needed',
      );
      return;
    }

    const assigned = await relayReader.getAssignedRelays(roomId);
    const normalizedTarget = normalizeSuiAddress(targetMinerId);
    const isPrimary = assigned.length > 0 && normalizeSuiAddress(assigned[0]!) === normalizedTarget;

    if (isPrimary) {
      const newPrimary = assigned
        .map((id) => normalizeSuiAddress(id))
        .find((id) => id !== normalizedTarget);
      if (!newPrimary) {
        logger.warn(
          { module: MODULE, roomId, targetMinerId, assigned },
          'WorkerConfirmedDead: no healthy standby relay found in assigned_relays — cannot promote',
        );
        return;
      }

      const ok = await submitPromoteViaHealthAlert(
        suiClient, signer, config, alertBoxId, roomId, newPrimary, logger,
      );
      if (ok) {
        logger.info({ module: MODULE, roomId, targetMinerId, newPrimary }, 'promote_relay_via_health_alert succeeded');
      } else {
        logger.warn({ module: MODULE, roomId, targetMinerId, newPrimary }, 'promote_relay_via_health_alert failed');
      }
      return;
    }

    // Standby target (found elsewhere in assigned_relays[1..], or already gone) — vote in a
    // FRESH candidate via propose_relay_replacement, not promote_relay_via_health_alert
    // (which only ever swaps slot 0).
    if (!cpCapId) {
      logger.warn(
        { module: MODULE, roomId, targetMinerId },
        'WorkerConfirmedDead for a standby target but no cpCapId configured — cannot vote a replacement',
      );
      return;
    }
    const candidateId = await candidateSelector(roomId, assigned);
    if (!candidateId) {
      logger.warn(
        { module: MODULE, roomId, targetMinerId, assigned },
        'WorkerConfirmedDead: no replacement candidate available for dead standby',
      );
      return;
    }

    const ok = await submitReplacementViaHealthAlert(
      suiClient, signer, config, alertBoxId, cpCapId, roomId, targetMinerId, candidateId, logger,
    );
    if (ok) {
      logger.info({ module: MODULE, roomId, targetMinerId, candidateId }, 'propose_relay_replacement (via health alert) succeeded');
    } else {
      logger.warn({ module: MODULE, roomId, targetMinerId, candidateId }, 'propose_relay_replacement (via health alert) failed');
    }
  });

  return {
    stop: () => {
      running = false;
      poller.stop();
    },
  };
}
