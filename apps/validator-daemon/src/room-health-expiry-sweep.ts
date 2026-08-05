/**
 * Room health-alert expiry sweep — the REAL ~10-minute enforcement for
 * room_health_alerts.move's dual-threshold campaigns (see that module's doc:
 * `expire_stale_campaign` itself is only a coarse EPOCH-boundary GC crank, not
 * a literal timer — Sui's TxContext has no per-transaction wall-clock).
 *
 * This sweep tracks each (room, target) campaign's first-observed wall-clock
 * time from `WorkerDownReported`'s event `timestampMs` (Sui attaches this to
 * every event natively, same mechanism cp-daemon's room-expiry-sweep.ts uses
 * for RoomCreated/RoomAssigned). Once real elapsed time exceeds
 * `expiryMs` (default 10 minutes) for a campaign that hasn't resolved
 * (`WorkerConfirmedDead` never observed for it), this sweep calls
 * `expire_stale_campaign` — a permissionless, safe-to-call-speculatively crank
 * that no-ops if the campaign already resolved or was already GC'd (mirrors
 * `recheck_quorum` / `execute_ejection`'s "anyone can call, no-op if the
 * precondition isn't met" shape).
 *
 * Deliberately its own EventPoller (separate cursor file) from
 * room-health-vote-watcher.ts, even though both watch the same
 * `room_health_alerts_events` module — keeps the two concerns (voting vs.
 * expiry bookkeeping) independently testable and independently restartable,
 * same modularity room-expiry-sweep.ts (room-lifecycle GC) already has
 * relative to the rest of cp-daemon.
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

const MOD = 'room-health-expiry-sweep';

const cursorDir = (name: string): string => join(process.env.DATA_DIR ?? '.', '.cursors', name);

export const DEFAULT_CAMPAIGN_EXPIRY_MS = 10 * 60_000; // 10 minutes — the spec's actual window
export const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

function key(roomId: string, targetMinerId: string): string {
  return `${roomId}:${normalizeSuiAddress(targetMinerId)}`;
}

/** Submit `room_health_alerts::expire_stale_campaign`. */
async function submitExpireStaleCampaign(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  alertBoxId: string,
  roomId: string,
  targetMinerId: string,
  logger: Logger,
): Promise<boolean> {
  const result = await executeWithRetry(
    client,
    signer,
    (tx: Transaction) => {
      tx.moveCall({
        target: `${config.packageId}::room_health_alerts::expire_stale_campaign`,
        arguments: [tx.object(alertBoxId), tx.pure.id(roomId), tx.pure.id(targetMinerId)],
      });
    },
    'expire-stale-campaign',
    logger,
  );
  return result !== null;
}

export interface RoomHealthExpirySweepOptions {
  client: SuiClient;
  graphqlClient: SuiGraphQLClient;
  config: NetworkConfig;
  signer: Ed25519Keypair;
  logger?: Logger;
  pollIntervalMs?: number;
  /** Real wall-clock ms after first WorkerDownReported before expiring an unresolved campaign. Default 10 min. */
  expiryMs?: number;
  /** Sweep tick cadence. Default 30s. */
  sweepIntervalMs?: number;
}

export interface RoomHealthExpirySweepHandle {
  stop: () => void;
}

/**
 * Start the room health-alert expiry sweep. No-ops (does not throw) if
 * `config.roomHealthAlertBoxId` is unset — same additive-feature posture as
 * room-health-vote-watcher.ts.
 */
export function startRoomHealthExpirySweep(opts: RoomHealthExpirySweepOptions): RoomHealthExpirySweepHandle {
  const {
    client, graphqlClient, config, signer,
    logger = createLogger(MOD),
    pollIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
    expiryMs = DEFAULT_CAMPAIGN_EXPIRY_MS,
    sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  } = opts;

  if (!config.roomHealthAlertBoxId) {
    logger.info({ module: MOD }, 'roomHealthAlertBoxId unset — room health expiry sweep disabled');
    return { stop: () => {} };
  }
  const alertBoxId = config.roomHealthAlertBoxId;

  let running = true;
  const firstSeenMs = new Map<string, { roomId: string; targetMinerId: string; atMs: number }>();
  // One expire attempt per campaign occurrence — expire_stale_campaign is a no-op crank, so a
  // second call after a fresh WorkerDownReported for the same (room, target) is legitimate and
  // re-tracked (see the WorkerDownReported handler below re-seeding after this delete).
  const expired = new Set<string>();

  const poller = new EventPoller({
    client: graphqlClient,
    packageId: config.roomHealthAlertsOriginPackageId ?? config.originalPackageId ?? config.packageId,
    module: 'room_health_alerts_events',
    pollingIntervalMs: pollIntervalMs,
    cursorPath: cursorDir('room-health-expiry-sweep-events.json'),
    logger: logger.child({ poller: 'room_health_alerts' }),
  });

  void poller.start(async (event) => {
    if (!running) return;

    if (event.type?.endsWith('::WorkerConfirmedDead')) {
      const parsed = event.parsedJson as { room_id?: string; target_miner_id?: string } | undefined;
      if (parsed?.room_id && parsed.target_miner_id) {
        const k = key(parsed.room_id, parsed.target_miner_id);
        firstSeenMs.delete(k);
        expired.delete(k);
      }
      return;
    }

    if (!event.type?.endsWith('::WorkerDownReported')) return;
    const parsed = event.parsedJson as { room_id?: string; target_miner_id?: string } | undefined;
    const roomId = parsed?.room_id;
    const targetMinerId = parsed?.target_miner_id;
    if (!roomId || !targetMinerId) return;

    const k = key(roomId, targetMinerId);
    if (firstSeenMs.has(k)) return; // already tracking this campaign's first-seen time

    const atMs = event.timestampMs ? Number(event.timestampMs) : Date.now();
    firstSeenMs.set(k, { roomId, targetMinerId, atMs });
    expired.delete(k); // a fresh campaign for a previously-expired target — re-track
  });

  async function sweepTick(): Promise<void> {
    if (!running) return;
    const now = Date.now();
    for (const [k, entry] of firstSeenMs) {
      if (expired.has(k)) continue;
      if (now - entry.atMs < expiryMs) continue;

      logger.info(
        { module: MOD, roomId: entry.roomId, targetMinerId: entry.targetMinerId, elapsedMs: now - entry.atMs },
        'room health campaign exceeded the real expiry window — cranking expire_stale_campaign',
      );
      expired.add(k);
      const ok = await submitExpireStaleCampaign(
        client, signer, config, alertBoxId, entry.roomId, entry.targetMinerId, logger,
      );
      if (!ok) {
        logger.warn(
          { module: MOD, roomId: entry.roomId, targetMinerId: entry.targetMinerId },
          'expire_stale_campaign submission failed',
        );
      }
      firstSeenMs.delete(k);
    }
  }

  const timer = setInterval(() => void sweepTick(), sweepIntervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(timer);
      poller.stop();
    },
  };
}
