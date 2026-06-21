/**
 * Self-observed spill trigger (REQ-RMS-006).
 *
 * The relay tracks a per-room forward-path count (active producers + consumers
 * across the room's peers). When a room crosses SPILL_FRACTION_BPS of the env
 * RMS_C_WORKER_PATHS ceiling, it fires `onSpillRequested` ONCE for that room — the
 * relay is REQUESTING help (a self-observed trigger), NOT claiming capacity (the
 * placement scorer uses canary-attested signals, REQ-RMS-005/019, out of M2 scope; a
 * spill REQUEST is request-side and cannot win the requester placement, so it does NOT
 * re-open the M1 team-review QC-1 self-report concern — see Open Issues carry-forwards).
 *
 * RMS_C_WORKER_PATHS is the SAME env knob cp-daemon placement reads — verify:
 * `cp-daemon/src/event-handler.ts` reads `process.env['RMS_C_WORKER_PATHS'] ?? '300'` (the
 * RMS_C_WORKER_PATHS grep hits exactly these two read sites + this file's tests), so both
 * sides resolve ONE calibration source with the SAME default. (The relay reads it to size its
 * own spill threshold; cp-daemon reads it to size placement capacity. Wiring a single
 * config-server push of this value is out of M2 Task1 scope; today the sharing is by-convention
 * — same env var name, same default — not a single runtime source.)
 * RMS_C_WORKER_PATHS + SPILL_FRACTION_BPS are parseInt-from-env (NEVER hardcoded — follows the
 * NUM_WORKERS / RELAY_MAX_INCOMING_BITRATE idiom in mediasoup-manager.ts).
 * Additive + optional: when no SpillTrigger is wired, the M1 single-room path is
 * unchanged.
 */
import type { Logger } from '@dvconf/shared';

export interface SpillTriggerDeps {
  /** Fired ONCE per room when its path-count first crosses the threshold. */
  onSpillRequested: (roomId: string, paths: number) => void;
  logger?: Logger;
}

export interface SpillTrigger {
  /** Increment a room's forward-path count (on produce/consume success). */
  recordPath(roomId: string): void;
  /** Decrement a room's forward-path count (on consumer/producer close). */
  releasePath(roomId: string): void;
  /** Drop a room's state (room close). */
  clearRoom(roomId: string): void;
  /** Test/diagnostic — current path-count for a room. */
  pathCount(roomId: string): number;
}

/** Per-room ceiling = one worker's forward-path capacity, read from the SAME `RMS_C_WORKER_PATHS`
 *  env var cp-daemon placement reads at `event-handler.ts` (`process.env['RMS_C_WORKER_PATHS'] ?? '300'`),
 *  with the SAME `?? '300'` default — so relay-spill and cp-placement calibrate off ONE env knob
 *  (sharing is by-convention via the env name+default, NOT a single runtime push — config-server
 *  wiring is out of M2 Task1 scope). Re-tuning 300->540 per the M1 bench (REQ-RMS-001 carry-forward (c))
 *  must update BOTH read sites. Default 300 mirrors the shipped cp-daemon default (M1 team-review must-fix #1). */
function readCWorker(): number {
  return parseInt(process.env['RMS_C_WORKER_PATHS'] ?? '300', 10);
}

/** Fraction of C_worker (basis points) at which a room requests a spill. */
function readSpillFractionBps(): number {
  return parseInt(process.env['SPILL_FRACTION_BPS'] ?? '8000', 10); // default 80%
}

const BASIS = 10_000;

export function createSpillTrigger(deps: SpillTriggerDeps): SpillTrigger {
  const cWorker = readCWorker();
  const fractionBps = readSpillFractionBps();
  const threshold = Math.floor((cWorker * fractionBps) / BASIS);
  const counts = new Map<string, number>();
  const fired = new Set<string>();

  return {
    recordPath(roomId: string): void {
      const next = (counts.get(roomId) ?? 0) + 1;
      counts.set(roomId, next);
      if (next >= threshold && !fired.has(roomId)) {
        fired.add(roomId);
        deps.logger?.info({ roomId, paths: next, threshold, cWorker }, 'REQ-RMS-006: spill requested (self-observed)');
        deps.onSpillRequested(roomId, next);
      }
    },
    releasePath(roomId: string): void {
      const cur = counts.get(roomId);
      if (cur === undefined) return;
      const next = Math.max(0, cur - 1);
      counts.set(roomId, next);
    },
    clearRoom(roomId: string): void {
      counts.delete(roomId);
      fired.delete(roomId);
    },
    pathCount(roomId: string): number {
      return counts.get(roomId) ?? 0;
    },
  };
}
