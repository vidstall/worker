/**
 * Room expiry sweep — auto-closes rooms nobody is ever going to finish setting
 * up (stuck PENDING, no relay/CP ever assigned) or that got assigned but were
 * never explicitly closed by their creator (stuck READY/ACTIVE).
 *
 * The chain has no `sui::clock::Clock` (see `room_manager.move`'s module doc —
 * deliberately not threaded through `create_room`/`pairing.move` to avoid a
 * breaking signature change for a feature that doesn't need on-chain-verified
 * timing). Elapsed wall-clock time is judged ENTIRELY here, off-chain, from
 * `RoomCreated`/`RoomAssigned` event `timestampMs` (Sui attaches this to every
 * event natively — no new on-chain timestamp field needed). The on-chain
 * `room_manager_expiry::close_expired_room` trusts this daemon's CP cap for
 * that judgment; its only guard is that the room's LIVE status still matches
 * the `expectedStatus` this sweep believed when it computed the timeout (a
 * stale-read race against a legitimate assignment aborts instead of wrongly
 * closing the room).
 *
 * Design: clones the `RoomHealthSweep` seam pattern (`room-health-sweep.ts`) —
 * all chain reads go through {@link RoomExpiryChainReader} so the decision
 * logic is unit-testable offline. The live implementation
 * (`room-expiry-chain-state-reader.ts`) wires a real reader at daemon startup.
 *
 * Multiple CP daemons run their own sweep independently and may race to close
 * the same room; the first lands, the rest abort with E_ALREADY_CLOSED — an
 * accepted "wasted retry" cost, the same class already tolerated for
 * E_ALREADY_VOTED-style contention elsewhere in this codebase. No leader-
 * election/coordination is added.
 *
 * Structured logging: every action emits pino JSON with
 *   { trace_id, module: 'room-expiry-sweep', action, context }
 */

import { randomUUID } from 'node:crypto';
import type { SuiEvent } from '@mysten/sui/client';
import type { Logger } from '@dvconf/shared';

const MODULE = 'room-expiry-sweep';

/** MIRROR of Move `constants.move` ROOM_STATUS_* values. */
export const ROOM_STATUS_PENDING = 0;
export const ROOM_STATUS_READY = 1;
export const ROOM_STATUS_ACTIVE = 2;
export const ROOM_STATUS_CLOSED = 3;

export const DEFAULT_PENDING_EXPIRY_MS = 15 * 60 * 1000; // 15 min
export const DEFAULT_READY_EXPIRY_MS = 12 * 60 * 60 * 1000; // 12 hours
export const DEFAULT_POLL_INTERVAL_MS = 60_000; // 1 min — coarser than room-health-sweep's default since expiry timing is itself minute-granularity

/** Env resolver for ROOM_EXPIRY_PENDING_MS: positive integer, fall back + warn on malformed input. */
export function resolvePendingExpiryMs(raw: string | undefined, logger: Logger): number {
  return resolveExpiryMs(raw, DEFAULT_PENDING_EXPIRY_MS, 'ROOM_EXPIRY_PENDING_MS', logger);
}

/** Env resolver for ROOM_EXPIRY_READY_MS: positive integer, fall back + warn on malformed input. */
export function resolveReadyExpiryMs(raw: string | undefined, logger: Logger): number {
  return resolveExpiryMs(raw, DEFAULT_READY_EXPIRY_MS, 'ROOM_EXPIRY_READY_MS', logger);
}

function resolveExpiryMs(raw: string | undefined, fallback: number, envName: string, logger: Logger): number {
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    logger.warn(
      { module: MODULE, context: { raw, fallback } },
      `${envName} malformed or non-positive — using the default`,
    );
    return fallback;
  }
  return parsed;
}

// ── Timestamp capture (fed by index.ts's trackedHandler) ──────────────────────

export interface RoomLifecycleTimestamps {
  createdAtMs?: number;
  readyAtMs?: number;
}

/**
 * Pure, testable event observer — extracts wall-clock RoomCreated/RoomAssigned
 * timestamps into `map`, keyed by room_id. Called from index.ts's existing
 * `trackedHandler` wrapper (which already stamps `newestEventTsMs` off the same
 * event stream for the F61 health signal) so no new poller/cursor is needed —
 * the already-running `room_manager_events` poller replays from genesis on a
 * fresh deploy, so history backfills naturally.
 */
export function recordRoomLifecycleTimestamp(
  ev: SuiEvent,
  map: Map<string, RoomLifecycleTimestamps>,
  extractEventName: (eventType: string) => string,
): void {
  const eventName = extractEventName(ev.type);
  if (eventName !== 'RoomCreated' && eventName !== 'RoomAssigned') return;

  const data = ev.parsedJson as Record<string, unknown> | undefined;
  const roomId = data?.['room_id'];
  if (typeof roomId !== 'string') return;

  const ts = ev.timestampMs ? Number(ev.timestampMs) : 0;
  if (ts <= 0) return;

  const entry = map.get(roomId) ?? {};
  if (eventName === 'RoomCreated') {
    entry.createdAtMs = ts;
  } else {
    entry.readyAtMs = ts;
  }
  map.set(roomId, entry);
}

// ── RoomExpiryChainReader ───────────────────────────────────────────────────

export interface RoomStatusInfo {
  status: number;
  createdAtEpoch: bigint;
}

/**
 * Read seam for on-chain room state + this daemon's observed wall-clock
 * timestamps. Mirrors {@link RoomHealthChainReader} (`room-health-sweep.ts`).
 * No SuiClient dependency in the sweep class — tests inject an in-memory fake.
 */
export interface RoomExpiryChainReader {
  getActiveRoomIds(): Promise<string[]>;
  /** room_manager::get_room_status_info — (status, created_at epoch). */
  getRoomStatusInfo(roomId: string): Promise<RoomStatusInfo>;
  /** Wall-clock ms this daemon observed RoomCreated for roomId, if any. */
  getRoomCreatedAtMs(roomId: string): number | undefined;
  /** Wall-clock ms this daemon observed RoomAssigned for roomId, if any. */
  getRoomReadyAtMs(roomId: string): number | undefined;
}

// ── Submitter ────────────────────────────────────────────────────────────────

/** Submits `room_manager_expiry::close_expired_room`. Chain-free — the live factory wraps `executeWithRetry`. */
export type CloseExpiredRoomSubmitter = (
  roomId: string,
  expectedStatus: number,
  traceId: string,
) => Promise<void>;

export interface RoomExpirySweepOptions {
  pendingExpiryMs?: number;
  readyExpiryMs?: number;
  pollIntervalMs?: number;
}

export interface RoomExpiryAction {
  roomId: string;
  /** The status the room was in when the timeout fired (0=PENDING, 1=READY, 2=ACTIVE). */
  expiredFromStatus: number;
}

// ── RoomExpirySweep ─────────────────────────────────────────────────────────

export class RoomExpirySweep {
  private readonly pendingExpiryMs: number;
  private readonly readyExpiryMs: number;
  private readonly pollIntervalMs: number;
  /** De-dup: one successful close attempt per roomId, for this watcher's lifetime. */
  private readonly actedKeys = new Set<string>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly reader: RoomExpiryChainReader,
    private readonly submitCloseExpiredRoom: CloseExpiredRoomSubmitter,
    private readonly logger: Logger,
    options: RoomExpirySweepOptions = {},
  ) {
    this.pendingExpiryMs = options.pendingExpiryMs ?? DEFAULT_PENDING_EXPIRY_MS;
    this.readyExpiryMs = options.readyExpiryMs ?? DEFAULT_READY_EXPIRY_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  getPollIntervalMs(): number {
    return this.pollIntervalMs;
  }

  start(): void {
    this.logger.info(
      {
        module: MODULE,
        context: {
          intervalMs: this.pollIntervalMs,
          pendingExpiryMs: this.pendingExpiryMs,
          readyExpiryMs: this.readyExpiryMs,
        },
      },
      'Starting room expiry sweep loop',
    );
    const poll = async (): Promise<void> => {
      try {
        await this.scanOnce();
      } catch (err) {
        this.logger.error({ module: MODULE, context: { err } }, 'Room expiry sweep: poll cycle failed');
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
    this.logger.info({ module: MODULE }, 'Room expiry sweep loop stopped');
  }

  /** Core detection + closing logic — exposed for unit testing. `nowMs` is injectable for tests. */
  async scanOnce(nowMs: number = Date.now()): Promise<RoomExpiryAction[]> {
    const traceId = randomUUID();
    const actions: RoomExpiryAction[] = [];
    const roomIds = await this.reader.getActiveRoomIds();

    this.logger.info(
      { trace_id: traceId, module: MODULE, action: 'scan', context: { roomCount: roomIds.length } },
      'Room expiry sweep: scan cycle',
    );

    for (const roomId of roomIds) {
      if (this.actedKeys.has(roomId)) continue;

      const { status } = await this.reader.getRoomStatusInfo(roomId);

      if (status === ROOM_STATUS_PENDING) {
        const createdAtMs = this.reader.getRoomCreatedAtMs(roomId);
        if (createdAtMs === undefined) {
          this.logger.debug(
            { trace_id: traceId, module: MODULE, context: { roomId } },
            'Room expiry sweep: no createdAtMs observed yet — skipping this tick',
          );
          continue;
        }
        if (nowMs - createdAtMs >= this.pendingExpiryMs) {
          await this.tryClose(roomId, ROOM_STATUS_PENDING, actions);
        }
      } else if (status === ROOM_STATUS_READY || status === ROOM_STATUS_ACTIVE) {
        const readyAtMs = this.reader.getRoomReadyAtMs(roomId);
        if (readyAtMs === undefined) {
          this.logger.debug(
            { trace_id: traceId, module: MODULE, context: { roomId } },
            'Room expiry sweep: no readyAtMs observed yet — skipping this tick',
          );
          continue;
        }
        if (nowMs - readyAtMs >= this.readyExpiryMs) {
          await this.tryClose(roomId, status, actions);
        }
      }
      // status === CLOSED shouldn't appear in the active set at all — no-op if it does.
    }

    return actions;
  }

  private async tryClose(roomId: string, expiredFromStatus: number, actions: RoomExpiryAction[]): Promise<void> {
    const actionTraceId = randomUUID();
    try {
      await this.submitCloseExpiredRoom(roomId, expiredFromStatus, actionTraceId);
      this.actedKeys.add(roomId);
      actions.push({ roomId, expiredFromStatus });
      this.logger.info(
        { trace_id: actionTraceId, module: MODULE, action: 'close_expired_room_submitted', context: { roomId, expiredFromStatus } },
        'Room expiry sweep: close_expired_room submitted',
      );
    } catch (err) {
      this.logger.warn(
        { trace_id: actionTraceId, module: MODULE, context: { roomId, expiredFromStatus, err } },
        'Room expiry sweep: close_expired_room failed',
      );
    }
  }
}

// ── Factory function ──────────────────────────────────────────────────────────

/** Construct a `RoomExpirySweep` (starts poll loop). Mirrors `startRoomHealthSweep`. */
export function startRoomExpirySweep(
  reader: RoomExpiryChainReader,
  submitCloseExpiredRoom: CloseExpiredRoomSubmitter,
  logger: Logger,
  options: RoomExpirySweepOptions = {},
): RoomExpirySweep {
  const sweep = new RoomExpirySweep(reader, submitCloseExpiredRoom, logger, options);
  sweep.start();
  return sweep;
}

// ── Live submitter factory (wired in cp-daemon index.ts) ──────────────────────

import type { SuiClient } from '@mysten/sui/client';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { executeWithRetry, type NetworkConfig } from '@dvconf/shared';

/**
 * Live `CloseExpiredRoomSubmitter` — signs + submits `close_expired_room`.
 * CP-cap-gated: requires this daemon's own registered `cpCapId`.
 */
export function makeCloseExpiredRoomSubmitter(
  client: SuiClient,
  signer: Ed25519Keypair,
  config: NetworkConfig,
  cpCapId: string,
  logger: Logger,
): CloseExpiredRoomSubmitter {
  return async (roomId, expectedStatus, traceId) => {
    await executeWithRetry(
      client,
      signer,
      (tx: Transaction) => {
        tx.moveCall({
          // close_expired_room is defined in the room_manager_expiry satellite
          // module (expiry.move), not room_manager itself.
          target: `${config.packageId}::room_manager_expiry::close_expired_room`,
          arguments: [
            tx.object(config.networkRegistryId),
            tx.object(config.roomManagerId),
            tx.object(config.cpRegistryId),
            tx.object(cpCapId),
            tx.pure.id(roomId),
            tx.pure.u8(expectedStatus),
          ],
        });
      },
      'close-expired-room',
      logger,
    );
    logger.info(
      { trace_id: traceId, module: MODULE, action: 'close_expired_room_confirmed', context: { roomId, expectedStatus } },
      'Room expiry sweep: close_expired_room confirmed on-chain',
    );
  };
}
