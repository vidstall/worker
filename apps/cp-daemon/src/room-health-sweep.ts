/**
 * Room health sweep — closes the gap left by validator-driven liveness ejection
 * (`registration::execute_ejection`, added in the liveness_voting module).
 *
 * `execute_ejection` fully removes a dead relay node from its registry with
 * zero acknowledgment of any room still referencing it — a room's
 * `assigned_relays` can dangle forever with no on-chain signal. The gap this
 * module closes:
 *
 *   RELAY: `promote_relay` (see `relay-heartbeat-watcher.ts`, which already
 *   owns the "primary stale but a live standby is already assigned" case end
 *   to end) reads `relay_registry::borrow_info(old_primary)` to check
 *   staleness — this call ABORTS once `old_primary` is fully ejected, so a
 *   dead-and-gone primary can never be promoted via that path. This sweep
 *   handles the two cases `relay-heartbeat-watcher.ts` cannot:
 *     a) primary fully ejected + a live standby already assigned →
 *        `promote_relay_after_ejection` (room_manager.move).
 *     b) primary stale-or-ejected + NO live standby assigned at all →
 *        `authorize_spill_relay` to append a fresh live candidate; a LATER
 *        tick of either watcher then promotes it.
 *   (Residual cost: until this sweep heals case (a) or (b), relay-heartbeat-
 *   watcher's own promote_relay attempts against a fully-ejected primary
 *   will keep aborting on-chain every tick — the same accepted "wasted
 *   retry" cost pattern already tolerated elsewhere (E_ALREADY_VOTED spam).)
 *
 * (The standalone signaling node type's failover path -- `reassign_signaling`
 * -- was removed along with the node type itself.)
 *
 * Design: clones the `RevoteWatcher`/`RelayHeartbeatWatcher` seam pattern — all
 * chain reads go through {@link RoomHealthChainReader} so the decision logic is
 * unit-testable offline (no SuiClient / devInspect). The live implementation
 * (`room-health-chain-state-reader.ts`) wires a real reader at daemon startup.
 * `MAX_HEARTBEAT_EPOCHS` mirrors `room_manager.move:57` exactly — a threshold
 * below the Move floor would fire PTBs the chain aborts.
 *
 * Structured logging: every action emits pino JSON with
 *   { trace_id, module: 'room-health-sweep', action, context }
 */

import { randomUUID } from 'node:crypto';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import type { Logger } from '@dvconf/shared';

const MODULE = 'room-health-sweep';

/** MIRROR of Move `room_manager.move:57` `MAX_HEARTBEAT_EPOCHS: u64 = 3`. */
export const MOVE_MAX_HEARTBEAT_EPOCHS = 3n;

/** Env resolver for ROOM_HEALTH_MAX_HEARTBEAT_EPOCHS: >= the Move floor, clamp + warn below it. */
export function resolveMaxHeartbeatEpochs(raw: string | undefined, logger: Logger): bigint {
  if (raw === undefined) return MOVE_MAX_HEARTBEAT_EPOCHS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    logger.warn({ module: MODULE, context: { raw } }, 'ROOM_HEALTH_MAX_HEARTBEAT_EPOCHS malformed — using the Move floor (3)');
    return MOVE_MAX_HEARTBEAT_EPOCHS;
  }
  if (BigInt(parsed) < MOVE_MAX_HEARTBEAT_EPOCHS) {
    logger.warn(
      { module: MODULE, context: { raw, floor: MOVE_MAX_HEARTBEAT_EPOCHS.toString() } },
      'ROOM_HEALTH_MAX_HEARTBEAT_EPOCHS below the Move MAX_HEARTBEAT_EPOCHS floor — clamped',
    );
    return MOVE_MAX_HEARTBEAT_EPOCHS;
  }
  return BigInt(parsed);
}

/** Default poll cadence (ms) when no `pollIntervalMs` is provided. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

// ── RoomHealthChainReader ─────────────────────────────────────────────────────

export interface RoomAssignmentSnapshot {
  /** assigned_relays[0]=primary, [1..]=standby/spill. Empty if unassigned. */
  relays: string[];
}

/** A registry node's id + last_heartbeat, as read from a `get_active_*` getter. */
export interface RegistryNodeHeartbeat {
  minerId: string;
  lastHeartbeat: bigint;
}

/**
 * Read seam for on-chain room + registry state. Mirrors
 * {@link RelayChainStateReader} (`relay-heartbeat-watcher.ts`) / {@link ChainStateReader}
 * (`revote-watcher.ts`). No SuiClient dependency in the sweep class — tests
 * inject an in-memory fake.
 */
export interface RoomHealthChainReader {
  getCurrentEpoch(): Promise<bigint>;
  getActiveRoomIds(): Promise<string[]>;
  /** room_manager::get_room_assignment. */
  getRoomAssignment(roomId: string): Promise<RoomAssignmentSnapshot>;
  /** relay_registry::get_active_relays, projected to id + heartbeat. */
  getActiveRelayPool(): Promise<RegistryNodeHeartbeat[]>;
}

// ── Submitters ─────────────────────────────────────────────────────────────────

/** Submits `promote_relay_after_ejection`. Chain-free — the live factory wraps `executeWithRetry`. */
export type PromoteAfterEjectionSubmitter = (
  roomId: string,
  oldPrimary: string,
  newPrimary: string,
  traceId: string,
) => Promise<void>;

/** Submits `authorize_spill_relay` (CP-cap-gated append). */
export type SpillRelaySubmitter = (roomId: string, spillRelay: string, traceId: string) => Promise<void>;

export interface RoomHealthSubmitters {
  promoteAfterEjection: PromoteAfterEjectionSubmitter;
  spillRelay: SpillRelaySubmitter;
}

export interface RoomHealthSweepOptions {
  maxHeartbeatEpochs?: bigint;
  pollIntervalMs?: number;
}

export interface RoomHealthAction {
  roomId: string;
  kind: 'promote_relay_after_ejection' | 'authorize_spill_relay';
  oldNodeId: string | null;
  newNodeId: string;
}

/** Pick the freshest (highest last_heartbeat) live, non-excluded candidate from a pool. */
function pickCandidate(
  pool: RegistryNodeHeartbeat[],
  epoch: bigint,
  maxHeartbeatEpochs: bigint,
  exclude: Set<string>,
): string | undefined {
  let best: string | undefined;
  let bestHb = -1n;
  for (const { minerId, lastHeartbeat } of pool) {
    const id = normalizeSuiAddress(minerId);
    if (exclude.has(id)) continue;
    const gap = epoch > lastHeartbeat ? epoch - lastHeartbeat : 0n;
    if (gap > maxHeartbeatEpochs) continue; // exclude stale candidates too
    if (lastHeartbeat > bestHb) {
      bestHb = lastHeartbeat;
      best = id;
    }
  }
  return best;
}

// ── RoomHealthSweep ────────────────────────────────────────────────────────────

export class RoomHealthSweep {
  private readonly maxHeartbeatEpochs: bigint;
  private readonly pollIntervalMs: number;
  /** De-dup: one successful action per (kind, roomId, oldNodeId) key, for this watcher's lifetime. */
  private readonly actedKeys = new Set<string>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reader: RoomHealthChainReader,
    private readonly submitters: RoomHealthSubmitters,
    private readonly logger: Logger,
    options: RoomHealthSweepOptions = {},
  ) {
    this.maxHeartbeatEpochs = options.maxHeartbeatEpochs ?? MOVE_MAX_HEARTBEAT_EPOCHS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  start(): void {
    this.logger.info(
      { module: MODULE, context: { intervalMs: this.pollIntervalMs, maxHeartbeatEpochs: this.maxHeartbeatEpochs.toString() } },
      'Starting room health sweep loop',
    );
    const poll = async (): Promise<void> => {
      try {
        await this.scanOnce();
      } catch (err) {
        this.logger.error({ module: MODULE, context: { err } }, 'Room health sweep: poll cycle failed');
      }
    };
    void poll();
    this.intervalHandle = setInterval(() => void poll(), this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.logger.info({ module: MODULE }, 'Room health sweep loop stopped');
  }

  /** Core detection + healing logic — exposed for unit testing. */
  async scanOnce(): Promise<RoomHealthAction[]> {
    const traceId = randomUUID();
    const actions: RoomHealthAction[] = [];

    const [roomIds, epoch, relayPool] = await Promise.all([
      this.reader.getActiveRoomIds(),
      this.reader.getCurrentEpoch(),
      this.reader.getActiveRelayPool(),
    ]);

    const relayHbById = new Map(relayPool.map((r) => [normalizeSuiAddress(r.minerId), r.lastHeartbeat]));

    this.logger.info(
      { trace_id: traceId, module: MODULE, action: 'scan', context: { epoch: epoch.toString(), roomCount: roomIds.length } },
      'Room health sweep: scan cycle',
    );

    for (const roomId of roomIds) {
      const { relays } = await this.reader.getRoomAssignment(roomId);

      // ── RELAY ──
      if (relays.length > 0) {
        const primary = normalizeSuiAddress(relays[0]!);
        const primaryHb = relayHbById.get(primary);
        const primaryEjected = primaryHb === undefined;
        const primaryStale = primaryHb !== undefined && epoch - primaryHb > this.maxHeartbeatEpochs;

        if (primaryEjected || primaryStale) {
          const standbyIds = relays.slice(1).map((id) => normalizeSuiAddress(id));
          const liveStandby = standbyIds.find((id) => {
            const hb = relayHbById.get(id);
            return hb !== undefined && epoch - hb <= this.maxHeartbeatEpochs;
          });

          if (liveStandby && primaryEjected) {
            // Ejected case with a usable standby — relay-heartbeat-watcher's
            // promote_relay would abort here (borrow_info requires presence).
            const key = `promote_after_ejection::${roomId}::${primary}`;
            if (!this.actedKeys.has(key)) {
              const actionTraceId = randomUUID();
              try {
                await this.submitters.promoteAfterEjection(roomId, primary, liveStandby, actionTraceId);
                this.actedKeys.add(key);
                actions.push({ roomId, kind: 'promote_relay_after_ejection', oldNodeId: primary, newNodeId: liveStandby });
                this.logger.info(
                  { trace_id: actionTraceId, module: MODULE, action: 'promote_after_ejection_submitted', context: { roomId, oldPrimary: primary, newPrimary: liveStandby } },
                  'Room health sweep: promote_relay_after_ejection submitted',
                );
              } catch (err) {
                this.logger.warn(
                  { trace_id: actionTraceId, module: MODULE, context: { roomId, err } },
                  'Room health sweep: promote_relay_after_ejection failed',
                );
              }
            }
          } else if (!liveStandby) {
            // No usable standby at all (stale or ejected primary, nothing live
            // already assigned) — append a fresh candidate so a later tick of
            // either watcher can actually promote it.
            const exclude = new Set([primary, ...standbyIds]);
            const candidate = pickCandidate(relayPool, epoch, this.maxHeartbeatEpochs, exclude);
            if (candidate) {
              const key = `spill::${roomId}::${candidate}`;
              if (!this.actedKeys.has(key)) {
                const actionTraceId = randomUUID();
                try {
                  await this.submitters.spillRelay(roomId, candidate, actionTraceId);
                  this.actedKeys.add(key);
                  actions.push({ roomId, kind: 'authorize_spill_relay', oldNodeId: null, newNodeId: candidate });
                  this.logger.info(
                    { trace_id: actionTraceId, module: MODULE, action: 'spill_relay_submitted', context: { roomId, spillRelay: candidate } },
                    'Room health sweep: authorize_spill_relay submitted (no live standby)',
                  );
                } catch (err) {
                  this.logger.warn(
                    { trace_id: actionTraceId, module: MODULE, context: { roomId, err } },
                    'Room health sweep: authorize_spill_relay failed',
                  );
                }
              }
            } else {
              this.logger.warn(
                { module: MODULE, context: { roomId, primary } },
                'Room health sweep: relay assignment unhealthy but no live spill candidate available',
              );
            }
          }
          // else: liveStandby exists but primary is merely stale (not ejected) —
          // relay-heartbeat-watcher's promote_relay already owns this case.
        }
      }
    }

    return actions;
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/** Construct a `RoomHealthSweep` (starts poll loop). Mirrors `startRelayHeartbeatWatcher`. */
export function startRoomHealthSweep(
  reader: RoomHealthChainReader,
  submitters: RoomHealthSubmitters,
  logger: Logger,
  options: RoomHealthSweepOptions = {},
): RoomHealthSweep {
  const sweep = new RoomHealthSweep(reader, submitters, logger, options);
  sweep.start();
  return sweep;
}

// ── Live submitter factories (wired in cp-daemon index.ts) ────────────────────

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig } from '@dvconf/shared';

/**
 * Live `PromoteAfterEjectionSubmitter` — signs + submits `promote_relay_after_ejection`.
 * Arg order matches room_manager.move: (net_reg, manager, relay_reg, room_id, new_primary, ctx).
 */
export function makePromoteAfterEjectionSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  logger: Logger,
): PromoteAfterEjectionSubmitter {
  return async (roomId, oldPrimary, newPrimary, traceId) => {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          // promote_relay_after_ejection is defined in the room_manager_failover
          // satellite module (failover.move), not room_manager itself.
          target: `${config.packageId}::room_manager_failover::promote_relay_after_ejection`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.relayRegistryId),
            tx.pure.id(roomId),
            tx.pure.id(newPrimary),
          ],
        });
      },
      'promote-relay-after-ejection',
      logger,
    );
    logger.info(
      { trace_id: traceId, module: MODULE, action: 'promote_after_ejection_confirmed', context: { roomId, oldPrimary, newPrimary } },
      'Room health sweep: promote_relay_after_ejection confirmed on-chain',
    );
  };
}

/**
 * Live `SpillRelaySubmitter` — signs + submits `authorize_spill_relay`.
 * CP-cap-gated: requires this daemon's own registered `cpCapId`.
 */
export function makeSpillRelaySubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  logger: Logger,
): SpillRelaySubmitter {
  return async (roomId, spillRelay, traceId) => {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          // authorize_spill_relay is defined in the room_manager_reassignment
          // satellite module (reassignment.move), not room_manager itself.
          target: `${config.packageId}::room_manager_reassignment::authorize_spill_relay`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.cpRegistryId),
            tx.object(config.relayRegistryId),
            tx.object(cpCapId),
            tx.pure.id(roomId),
            tx.pure.id(spillRelay),
          ],
        });
      },
      'authorize-spill-relay',
      logger,
    );
    logger.info(
      { trace_id: traceId, module: MODULE, action: 'spill_relay_confirmed', context: { roomId, spillRelay } },
      'Room health sweep: authorize_spill_relay confirmed on-chain',
    );
  };
}
