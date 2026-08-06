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

  /**
   * All currently-active (registered) relay miner ids — the candidate pool for standby
   * replacement (relay_replacement.move). Optional: back-compat for fakes/tests that only
   * exercise the primary-promotion path and never inject a `candidateSelector`.
   */
  getActiveRelayIds?(): Promise<string[]>;
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

/**
 * Submits a single `propose_relay_replacement` PTB (relay_replacement.move) — this CP's vote
 * for `candidateRelayId` to replace a dead STANDBY (`deadRelayId`, never index 0/primary — that
 * stays `PromoteSubmitter`'s job). Injected so the watcher logic stays chain-free; may finalize
 * the swap immediately (if this vote reaches CP-quorum) or simply record a vote.
 */
export type ReplacementSubmitter = (
  roomId: string,
  deadRelayId: string,
  candidateRelayId: string,
  traceId: string,
) => Promise<void>;

/**
 * Picks a fresh candidate to vote in for a dead standby, excluding every relay already
 * assigned to the room (primary + all standbys). Returns null if no eligible candidate exists
 * (e.g. capacity-gated out, or the whole registered pool is already assigned). Injected so the
 * watcher stays chain-free — the live wiring composes this from `selectReplacementCandidate`
 * (admission-capacity.ts) over a fresh capacity read.
 */
export type ReplacementCandidateSelector = (
  roomId: string,
  assignedRelayIds: string[],
) => Promise<string | null>;

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
  /**
   * De-dup for standby replacement votes: keys `${roomId}::${deadRelayId}`. Separate namespace
   * from `promotedRooms` — a room can have an in-flight primary promotion AND a standby
   * replacement vote outstanding at the same time, they never collide.
   */
  private readonly proposedReplacements = new Set<string>();

  constructor(
    private readonly reader: RelayChainStateReader,
    private readonly submitter: PromoteSubmitter,
    private readonly logger: Logger,
    options: RelayHeartbeatWatcherOptions = {},
    private readonly replacementSubmitter?: ReplacementSubmitter,
    private readonly candidateSelector?: ReplacementCandidateSelector,
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
   *   3. STANDBY check (if a `replacementSubmitter`/`candidateSelector` pair was injected):
   *      for every assigned relay OTHER than the primary whose heartbeat gap exceeds
   *      maxHeartbeatEpochs and hasn't already had a replacement proposed this watcher
   *      lifetime, pick a candidate and submit `propose_relay_replacement` — de-duped per
   *      (roomId, deadRelayId), independent of the primary check below (a standby can die
   *      while the primary stays healthy, or vice versa).
   *   4. PRIMARY check: if the primary's heartbeat gap > maxHeartbeatEpochs, pick the
   *      FRESHEST live standby (smallest gap, tie-break = earliest slot) excluding the
   *      current primary, and submit a promote PTB — de-duped per (roomId, oldPrimary).
   *   5. If the primary is stale but ALL standbys are also stale → log warn, skip.
   *
   * Returns the list of rooms that received a new promotion this scan (standby
   * replacements are reported via the injected submitter's own logging, not this array).
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
        continue; // single-relay or unassigned room — nothing to promote/replace
      }
      const primaryId = assignedRaw[0]!;

      // REQ-RMS-024 — duplicate-aware id set: promote_relay REPLACES slot 0 but leaves
      // the promoted relay in its old slot ([A,B,C] -> [C,B,C], room_manager.move:886-888).
      const uniqueRelays = [...new Set(assignedRaw)];

      const heartbeats = await this.reader.getRelayLastHeartbeats(roomId);
      const hbMap = new Map(heartbeats.map((h) => [h.relayId, h.lastHeartbeat]));
      const gapOf = (id: string): bigint => {
        const hb = hbMap.get(id) ?? 0n;
        return epoch > hb ? epoch - hb : 0n;
      };

      // ── Standby staleness (relay_replacement.move) — independent of the primary check
      // below: a standby can be dead while the primary stays healthy. Separate dedup
      // namespace so it never interferes with primary-promotion dedup. ──
      if (this.replacementSubmitter && this.candidateSelector) {
        for (const standbyId of uniqueRelays) {
          if (standbyId === primaryId) continue;
          if (gapOf(standbyId) <= this.maxHeartbeatEpochs) continue;

          const replacementKey = `${roomId}::${standbyId}`;
          if (this.proposedReplacements.has(replacementKey)) continue;

          const candidateId = await this.candidateSelector(roomId, uniqueRelays);
          if (!candidateId) {
            this.logger.warn(
              { module: MODULE, context: { roomId, deadRelayId: standbyId } },
              'Relay heartbeat watcher: standby stale but no replacement candidate available',
            );
            continue;
          }

          const replacementTraceId = randomUUID();
          this.logger.info(
            {
              trace_id: replacementTraceId,
              module: MODULE,
              action: 'replacement_submit',
              context: { roomId, deadRelayId: standbyId, candidateRelayId: candidateId, gap: gapOf(standbyId).toString() },
            },
            'Relay heartbeat watcher: submitting propose_relay_replacement PTB',
          );

          try {
            await this.replacementSubmitter(roomId, standbyId, candidateId, replacementTraceId);
            this.proposedReplacements.add(replacementKey);
            this.logger.info(
              {
                trace_id: replacementTraceId,
                module: MODULE,
                action: 'replacement_submitted',
                context: { roomId, deadRelayId: standbyId, candidateRelayId: candidateId },
              },
              'Relay heartbeat watcher: propose_relay_replacement PTB submitted',
            );
          } catch (err) {
            this.logger.warn(
              { trace_id: replacementTraceId, module: MODULE, context: { roomId, err } },
              'Relay heartbeat watcher: propose_relay_replacement PTB failed',
            );
          }
        }
      }

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
  replacementSubmitter?: ReplacementSubmitter,
  candidateSelector?: ReplacementCandidateSelector,
): RelayHeartbeatWatcher {
  const watcher = new RelayHeartbeatWatcher(reader, submitter, logger, options, replacementSubmitter, candidateSelector);
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
import { selectReplacementCandidate, type RelayCapacity } from './admission-capacity.js';

/**
 * Build a real {@link ReplacementCandidateSelector} from a reader exposing
 * `getActiveRelayIds()`. Candidate pool = every currently-active relay minus whatever's
 * already assigned to the room; no live capacity/RTT feed is wired at this call site
 * (a vote-in decision, unlike bootstrap placement), so every candidate is treated as
 * uniformly eligible -- `selectReplacementCandidate`'s capacity/health gates still apply
 * defensively (e.g. a canary-flagged relay is skipped) if the reader is later extended to
 * populate those fields.
 */
export function makeLiveReplacementCandidateSelector(
  reader: Pick<RelayChainStateReader, 'getActiveRelayIds'>,
): ReplacementCandidateSelector {
  return async (_roomId, assignedRelayIds) => {
    const activeIds = (await reader.getActiveRelayIds?.()) ?? [];
    const capacities: RelayCapacity[] = activeIds.map((minerId) => ({
      minerId,
      attestedLoadPaths: 0,
      cWorker: Number.POSITIVE_INFINITY,
      rtt: 0n,
    }));
    const chosen = selectReplacementCandidate(capacities, assignedRelayIds, 0);
    return chosen?.minerId ?? null;
  };
}

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

/**
 * Build a real {@link ReplacementSubmitter} that signs + submits
 * `propose_relay_replacement` PTBs (relay_replacement.move) via `executeWithRetry`.
 * CP-cap-gated: requires this daemon's own registered `cpCapId`. `submittedScore` is a
 * fixed placeholder (this vote only decides WHO replaces the dead standby, not room
 * scoring) — mirrors the fixed score used by other post-bootstrap CP-quorum votes.
 */
export function makeReplacementSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  logger: Logger,
): ReplacementSubmitter {
  return async (roomId, deadRelayId, candidateRelayId, traceId) => {
    const alertBoxId = config.roomHealthAlertBoxId;
    if (!alertBoxId) {
      logger.warn(
        { trace_id: traceId, module: MODULE, context: { roomId } },
        'Relay heartbeat watcher: roomHealthAlertBoxId not configured — cannot submit propose_relay_replacement',
      );
      return;
    }
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          target: `${config.packageId}::room_manager_relay_replacement::propose_relay_replacement`,
          arguments: [
            tx.object(config.networkRegistryId),  // net_reg: &NetworkRegistry
            tx.object(config.roomManagerId),      // manager: &mut RoomManager
            tx.object(config.cpRegistryId),       // cp_reg: &mut ControlPlaneRegistry
            tx.object(config.relayRegistryId),    // relay_reg: &mut RelayRegistry
            tx.object(alertBoxId),                // alert_box: &mut RoomHealthAlertBox
            tx.object(cpCapId),                   // cap: &ControlPlaneCap
            tx.pure.id(roomId),                   // room_id: ID
            tx.pure.id(deadRelayId),               // dead_relay_id: ID
            tx.pure.id(candidateRelayId),          // candidate_relay_id: ID
            tx.pure.u64(0),                        // submitted_score: u64 (placeholder, not room-scoring)
          ],
        });
      },
      'propose-relay-replacement',
      logger,
    );
    logger.info(
      {
        trace_id: traceId,
        module: MODULE,
        action: 'replacement_confirmed',
        context: { roomId, deadRelayId, candidateRelayId },
      },
      'Relay heartbeat watcher: propose_relay_replacement confirmed on-chain',
    );
  };
}
