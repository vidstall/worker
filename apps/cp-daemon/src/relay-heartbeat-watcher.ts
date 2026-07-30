/**
 * Relay heartbeat watcher — M1 Phase 3.1 (REQ-RO-009).
 *
 * Periodically scans on-chain `relay_registry.info_last_heartbeat` for each
 * room's assigned relays. When the primary relay's heartbeat age exceeds
 * `maxHeartbeatEpochs` AND at least one standby relay is still fresh, submits a
 * `promote_relay` PTB (for the freshest live standby) via the injected
 * `PromoteSubmitter`. Generalized to N>=3 assigned relays (REQ-RMS-024).
 *
 * Design: clones the `RevoteWatcher` seam pattern from `revote-watcher.ts`
 * (F47 Phase 4.1, RV-013). All chain reads go through `RelayChainStateReader`
 * so the decision logic is unit-testable offline (no SuiClient / devInspect).
 * The live implementation wires a real chain reader at daemon startup.
 *
 * De-dup guard: once a promotion for a given (room, old-primary) has been
 * submitted in this watcher's lifetime, it is tracked in `promotedRooms` (Set,
 * keyed `${roomId}::${oldPrimary}`). Subsequent `scanOnce()` calls skip that
 * (room, old-primary) pair — but a SECOND failover (the promoted relay later
 * dies, making a NEW old-primary) is a distinct key and still fires (REQ-RMS-024).
 * Mirrors the `revote_eligible_since` cooldown mirror in `RevoteWatcher`.
 *
 * If the primary is stale AND ALL standby relays are also stale (no fresh
 * candidate), the watcher logs a WARNING and skips promotion — there is no valid
 * candidate for the `new_primary` slot. The chain-level `promote_relay` entry's own
 * precondition would also reject this case, but we skip it here to avoid wasting gas.
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

/**
 * REQ-RMS-024 — MIRROR of Move `room_manager.move:57` `MAX_HEARTBEAT_EPOCHS: u64 = 3`.
 * promote_relay asserts `current_epoch - last_hb > MAX_HEARTBEAT_EPOCHS` (`:884`,
 * E_RELAY_NOT_STALE=564): a watcher threshold BELOW this fires PTBs the chain aborts.
 * If the Move constant ever changes, update this mirror in the same review.
 */
export const MOVE_MAX_HEARTBEAT_EPOCHS = 3n;

/** Env resolver for RELAY_MAX_HEARTBEAT_EPOCHS: >= the Move floor, clamp + warn below it. */
export function resolveMaxHeartbeatEpochs(raw: string | undefined, logger: Logger): bigint {
  if (raw === undefined) return MOVE_MAX_HEARTBEAT_EPOCHS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    logger.warn({ module: MODULE, context: { raw } }, 'RELAY_MAX_HEARTBEAT_EPOCHS malformed — using the Move floor (3)');
    return MOVE_MAX_HEARTBEAT_EPOCHS;
  }
  if (BigInt(parsed) < MOVE_MAX_HEARTBEAT_EPOCHS) {
    logger.warn(
      { module: MODULE, context: { raw, floor: MOVE_MAX_HEARTBEAT_EPOCHS.toString() } },
      'RELAY_MAX_HEARTBEAT_EPOCHS below the Move MAX_HEARTBEAT_EPOCHS floor — clamped (promote_relay would abort E_RELAY_NOT_STALE)',
    );
    return MOVE_MAX_HEARTBEAT_EPOCHS;
  }
  return BigInt(parsed);
}

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
   * assigned_relays[0] = primary, [1..] = standbys (room_manager.move:55).
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
  /**
   * De-dup: keys `${roomId}::${oldPrimary}` for which a promotion has already been
   * submitted (REQ-RMS-024 — per-(room, oldPrimary), so a SECOND failover after the new
   * primary later dies can still fire). Field name kept to avoid external-reference churn.
   */
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
   * For each active room (REQ-RMS-024 — generalized from the 2-relay model to N>=3):
   *   1. Read current epoch.
   *   2. Read assigned_relays; [0]=primary. De-dup relay ids (promote_relay leaves the
   *      promoted relay in its old slot, so the vector can carry a duplicate).
   *   3. If the primary's heartbeat gap > maxHeartbeatEpochs, pick the FRESHEST live
   *      standby (smallest gap, tie-break = earliest slot) excluding the current primary,
   *      and submit a promote PTB — de-duped per (roomId, oldPrimary).
   *   4. If the primary is stale but ALL standbys are also stale → log warn, skip.
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
      const assignedRaw = await this.reader.getAssignedRelays(roomId);
      if (assignedRaw.length < 2) {
        continue; // single-relay or unassigned room — nothing to promote
      }
      const primaryId = assignedRaw[0]!;

      // REQ-RMS-024 — dedup is per-(roomId, oldPrimary): a SECOND failover (the new
      // primary later dies) must fire; only re-promoting away from the SAME dead primary
      // is suppressed.
      const dedupKey = `${roomId}::${primaryId}`;
      if (this.promotedRooms.has(dedupKey)) {
        this.logger.debug(
          { trace_id: traceId, module: MODULE, context: { roomId, primaryId } },
          'Relay heartbeat watcher: this (room, primary) already promoted — skipping',
        );
        continue;
      }

      // REQ-RMS-024 — duplicate-aware id set: promote_relay REPLACES slot 0 but leaves
      // the promoted relay in its old slot ([A,B,C] -> [C,B,C], room_manager.move:886-888).
      const uniqueRelays = [...new Set(assignedRaw)];

      const heartbeats = await this.reader.getRelayLastHeartbeats(roomId);
      const hbMap = new Map(heartbeats.map((h) => [h.relayId, h.lastHeartbeat]));
      const gapOf = (id: string): bigint => {
        const hb = hbMap.get(id) ?? 0n;
        return epoch > hb ? epoch - hb : 0n;
      };

      if (gapOf(primaryId) <= this.maxHeartbeatEpochs) {
        continue; // primary fresh — no promotion needed
      }

      // Fresh candidates = unique standbys, never the current primary; freshest (smallest
      // gap) wins, deterministic tie-break = earliest position in the deduped vector.
      const candidates = uniqueRelays
        .filter((id) => id !== primaryId)
        .map((id, idx) => ({ id, idx, gap: gapOf(id) }))
        .filter((c) => c.gap <= this.maxHeartbeatEpochs)
        .sort((a, b) => (a.gap < b.gap ? -1 : a.gap > b.gap ? 1 : a.idx - b.idx));

      if (candidates.length === 0) {
        this.logger.warn(
          { module: MODULE, context: { roomId, primaryId, relayCount: uniqueRelays.length, primaryGap: gapOf(primaryId).toString() } },
          'Relay heartbeat watcher: primary stale but ALL standbys stale — cannot promote',
        );
        continue;
      }
      const newPrimaryId = candidates[0]!.id;

      // Primary stale — promote the freshest live standby (REQ-RMS-024).
      const promotionTraceId = randomUUID();
      this.logger.info(
        {
          trace_id: promotionTraceId,
          module: MODULE,
          action: 'promote_submit',
          context: {
            roomId,
            oldPrimary: primaryId,
            newPrimary: newPrimaryId,
            // REQ-RMS-024 — freshness ranking (freshest first) behind the pick; the live-run
            // runbook asserts this ordering appears in the watcher log.
            candidates: candidates.map((c) => ({ id: c.id, gap: c.gap.toString() })),
            primaryGap: gapOf(primaryId).toString(),
            epoch: epoch.toString(),
          },
        },
        'Relay heartbeat watcher: submitting promote_relay PTB',
      );

      try {
        await this.submitter(roomId, primaryId, newPrimaryId, promotionTraceId);
        this.promotedRooms.add(dedupKey);
        promotions.push({ roomId, oldPrimary: primaryId, newPrimary: newPrimaryId });
        this.logger.info(
          {
            trace_id: promotionTraceId,
            module: MODULE,
            action: 'promote_submitted',
            context: { roomId, oldPrimary: primaryId, newPrimary: newPrimaryId },
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
          // promote_relay is defined in the room_manager_failover satellite
          // module (failover.move), not room_manager itself.
          target: `${config.packageId}::room_manager_failover::promote_relay`,
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
