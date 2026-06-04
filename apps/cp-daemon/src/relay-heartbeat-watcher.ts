/**
 * Relay heartbeat watcher — M1 Phase 3.1 (REQ-RO-009).
 *
 * Periodically scans on-chain `relay_registry.info_last_heartbeat` for each
 * room's assigned relays. When the primary relay's heartbeat age exceeds
 * `maxHeartbeatEpochs` AND the standby relay is still fresh, submits a
 * `promote_relay` PTB via the injected `PromoteSubmitter`.
 *
 * Design: clones the `RevoteWatcher` seam pattern from `revote-watcher.ts`
 * (F47 Phase 4.1, RV-013). All chain reads go through `RelayChainStateReader`
 * so the decision logic is unit-testable offline (no SuiClient / devInspect).
 * The live implementation wires a real chain reader at daemon startup.
 *
 * De-dup guard: once a promotion for a given room has been submitted in this
 * watcher's lifetime, it is tracked in `promotedRooms` (Set). Subsequent
 * `scanOnce()` calls skip that room until the watcher is recreated (mirrors
 * the `revote_eligible_since` cooldown mirror in `RevoteWatcher`).
 *
 * If BOTH the primary AND standby relay are stale (both heartbeats dead), the
 * watcher logs a WARNING and skips promotion — there is no valid candidate for
 * the `new_primary` slot. The chain-level `promote_relay` entry's own precondition
 * would also reject this case, but we skip it here to avoid wasting gas.
 *
 * Structured logging: every action emits pino JSON with
 *   { trace_id, module: 'relay-heartbeat-watcher', action, context }
 * No raw `console.*` in production paths.
 *
 * Implements REQ-RO-009.
 */

import { randomUUID } from 'node:crypto';
import type { Logger } from '@dvconf/shared';

const MODULE = 'relay-heartbeat-watcher';

/** Default maximum epoch gap before a relay is considered to have missed heartbeats. */
export const DEFAULT_MAX_HEARTBEAT_EPOCHS = 3n;

/** Default poll cadence (ms) when no `pollIntervalMs` is provided. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ── RelayChainStateReader (CONTRACTS C3) ─────────────────────────────────────

/**
 * Read seam for on-chain relay state.
 * Mirrors the {@link ChainStateReader} pattern in `revote-watcher.ts:83`.
 * No SuiClient dependency in the watcher class — tests inject an in-memory fake.
 *
 * As-built anchor: relay_registry.info_last_heartbeat() getter at
 * relay_registry.move:310.
 */
export interface RelayChainStateReader {
  /** Current Sui epoch number. */
  getCurrentEpoch(): Promise<bigint>;

  /**
   * Per-relay last_heartbeat for all relays assigned to a room.
   * Reads relay_registry.info_last_heartbeat() per relay ID.
   * Returns empty array if room has no assigned relays.
   */
  getRelayLastHeartbeats(
    roomId: string,
  ): Promise<Array<{ relayId: string; lastHeartbeat: bigint }>>;

  /**
   * Returns assigned_relays vector for the room.
   * assigned_relays[0] = primary, [1] = standby (room_manager.move:55).
   * Returns empty array if room is unassigned.
   */
  getAssignedRelays(roomId: string): Promise<string[]>;

  /**
   * Returns all active room IDs this watcher should scan.
   * Equivalent to RevoteWatcher's getActiveMiners() scope-query.
   */
  getActiveRoomIds(): Promise<string[]>;
}

// ── PromoteSubmitter (CONTRACTS C3) ──────────────────────────────────────────

/**
 * Submits a single `promote_relay` PTB. Injected so the watcher logic stays
 * chain-free. The live submitter wraps `executeWithRetry` with a Move call
 * matching the D-RO-1 signature:
 *   promote_relay(net_reg, manager, relay_reg, room_id, new_primary, ctx)
 */
export type PromoteSubmitter = (
  roomId: string,
  oldPrimary: string,
  newPrimary: string,
  traceId: string,
) => Promise<void>;

// ── Options ───────────────────────────────────────────────────────────────────

export interface RelayHeartbeatWatcherOptions {
  /**
   * Epochs after which a relay is considered missing a heartbeat.
   * Default: 3n (≈ 9s at 3s/epoch on localnet).
   */
  maxHeartbeatEpochs?: bigint;
  /** Poll interval in ms. Caller converts from epoch duration. */
  pollIntervalMs?: number;
}

// ── Promotion result type ─────────────────────────────────────────────────────

export interface RelayPromotion {
  roomId: string;
  oldPrimary: string;
  newPrimary: string;
}

// ── RelayHeartbeatWatcher ─────────────────────────────────────────────────────

/**
 * Scans relay heartbeats and submits `promote_relay` PTBs when stale.
 *
 * All chain reads go through the {@link RelayChainStateReader} seam — no
 * SuiClient inside. The `PromoteSubmitter` handles the actual chain TX.
 */
export class RelayHeartbeatWatcher {
  private readonly maxHeartbeatEpochs: bigint;
  private readonly pollIntervalMs: number;
  /** De-dup: rooms for which a promotion has already been submitted. */
  private readonly promotedRooms = new Set<string>();

  constructor(
    private readonly reader: RelayChainStateReader,
    private readonly submitter: PromoteSubmitter,
    private readonly logger: Logger,
    options: RelayHeartbeatWatcherOptions = {},
  ) {
    this.maxHeartbeatEpochs = options.maxHeartbeatEpochs ?? DEFAULT_MAX_HEARTBEAT_EPOCHS;
    // C2: honor a custom pollIntervalMs so the watcher can detect within the
    // ~9s 3-epoch window on localnet AND the Phase 5.3 bench can tune cadence.
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  /** The resolved poll cadence (ms). Honors options.pollIntervalMs (C2). */
  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  /** Start the periodic poll loop. */
  start(): void {
    const intervalMs = this.pollIntervalMs;
    this.logger.info(
      { module: MODULE, context: { intervalMs, maxHeartbeatEpochs: this.maxHeartbeatEpochs.toString() } },
      'Starting relay heartbeat watch loop',
    );
    const poll = async (): Promise<void> => {
      try {
        await this.scanOnce();
      } catch (err) {
        this.logger.error({ module: MODULE, context: { err } }, 'Relay heartbeat watcher: poll cycle failed');
      }
    };
    void poll();
    this.intervalHandle = setInterval(() => void poll(), intervalMs);
  }

  /** Stop the periodic poll loop. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.info({ module: MODULE }, 'Relay heartbeat watch loop stopped');
  }

  /**
   * Core detection logic — exposed for unit testing.
   *
   * For each active room:
   *   1. Read current epoch.
   *   2. Read assigned_relays[0]=primary, [1]=standby.
   *   3. If primary heartbeat gap > maxHeartbeatEpochs AND standby is fresh
   *      AND room not already promoted → submit PTB, de-dup guard.
   *   4. If BOTH stale → log warn, skip.
   *
   * Returns the list of rooms that received a new promotion this scan.
   */
  async scanOnce(): Promise<RelayPromotion[]> {
    const traceId = randomUUID();
    const promotions: RelayPromotion[] = [];

    const roomIds = await this.reader.getActiveRoomIds();
    const epoch = await this.reader.getCurrentEpoch();

    this.logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'scan',
        context: { epoch: epoch.toString(), roomCount: roomIds.length },
      },
      'Relay heartbeat watcher: scan cycle',
    );

    for (const roomId of roomIds) {
      // Skip rooms already promoted in this watcher's lifetime (de-dup guard)
      if (this.promotedRooms.has(roomId)) {
        this.logger.debug(
          { trace_id: traceId, module: MODULE, context: { roomId } },
          'Relay heartbeat watcher: room already promoted — skipping',
        );
        continue;
      }

      const assignedRelays = await this.reader.getAssignedRelays(roomId);
      if (assignedRelays.length < 2) {
        // Single-relay or unassigned room — nothing to promote
        continue;
      }

      const primaryId = assignedRelays[0]!;
      const standbyId = assignedRelays[1]!;

      const heartbeats = await this.reader.getRelayLastHeartbeats(roomId);
      const hbMap = new Map(heartbeats.map((h) => [h.relayId, h.lastHeartbeat]));

      const primaryHb = hbMap.get(primaryId) ?? 0n;
      const standbyHb = hbMap.get(standbyId) ?? 0n;

      const primaryGap = epoch > primaryHb ? epoch - primaryHb : 0n;
      const standbyGap = epoch > standbyHb ? epoch - standbyHb : 0n;

      const primaryStale = primaryGap > this.maxHeartbeatEpochs;
      const standbyStale = standbyGap > this.maxHeartbeatEpochs;

      if (!primaryStale) {
        // Primary is fresh — no promotion needed
        continue;
      }

      if (standbyStale) {
        // Both dead — no valid new primary
        this.logger.warn(
          {
            module: MODULE,
            context: { roomId, primaryId, standbyId, primaryGap: primaryGap.toString(), standbyGap: standbyGap.toString() },
          },
          'Relay heartbeat watcher: both primary and standby stale — cannot promote',
        );
        continue;
      }

      // Primary stale, standby fresh → promote
      const promotionTraceId = randomUUID();
      this.logger.info(
        {
          trace_id: promotionTraceId,
          module: MODULE,
          action: 'promote_submit',
          context: {
            roomId,
            oldPrimary: primaryId,
            newPrimary: standbyId,
            primaryGap: primaryGap.toString(),
            epoch: epoch.toString(),
          },
        },
        'Relay heartbeat watcher: submitting promote_relay PTB',
      );

      try {
        await this.submitter(roomId, primaryId, standbyId, promotionTraceId);
        this.promotedRooms.add(roomId);
        promotions.push({ roomId, oldPrimary: primaryId, newPrimary: standbyId });
        this.logger.info(
          {
            trace_id: promotionTraceId,
            module: MODULE,
            action: 'promote_submitted',
            context: { roomId, oldPrimary: primaryId, newPrimary: standbyId },
          },
          'Relay heartbeat watcher: promote_relay PTB submitted',
        );
      } catch (err) {
        this.logger.warn(
          { trace_id: promotionTraceId, module: MODULE, context: { roomId, err } },
          'Relay heartbeat watcher: promote_relay PTB failed',
        );
      }
    }

    return promotions;
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/**
 * Construct a `RelayHeartbeatWatcher` (starts poll loop).
 * Mirrors `startRevoteWatcher` from `revote-watcher.ts`.
 *
 * @returns the watcher instance (call `.stop()` on SIGTERM).
 */
export function startRelayHeartbeatWatcher(
  reader: RelayChainStateReader,
  submitter: PromoteSubmitter,
  logger: Logger,
  options: RelayHeartbeatWatcherOptions = {},
): RelayHeartbeatWatcher {
  const watcher = new RelayHeartbeatWatcher(reader, submitter, logger, options);
  watcher.start();
  return watcher;
}

// ── Live PromoteSubmitter factory (wired in cp-daemon index.ts) ───────────────

/**
 * Build a real {@link PromoteSubmitter} that signs + submits `promote_relay`
 * PTBs via `executeWithRetry`. Arg order matches D-RO-1 decision:
 *   promote_relay(net_reg, manager, relay_reg, room_id, new_primary, ctx)
 *
 * NOTE: room_id and new_primary are passed as pure IDs; old_primary is
 * included in the trace log but NOT as a PTB arg (the on-chain entry
 * derives it from `assigned_relays[0]`).
 */
import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig } from '@dvconf/shared';

export function makePromoteSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): PromoteSubmitter {
  return async (roomId, oldPrimary, newPrimary, traceId) => {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager::promote_relay`,
          arguments: [
            tx.object(config.networkRegistryId), // net_reg: &NetworkRegistry
            tx.object(config.roomManagerId),      // manager: &mut RoomManager
            tx.object(config.relayRegistryId),    // relay_reg: &RelayRegistry
            tx.pure.id(roomId),                   // room_id: ID
            tx.pure.id(newPrimary),               // new_primary: ID
          ],
        });
      },
      'promote-relay',
      logger,
    );
    logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'promote_confirmed',
        context: { roomId, oldPrimary, newPrimary },
      },
      'Relay heartbeat watcher: promote_relay confirmed on-chain',
    );
  };
}
