/**
 * @dvconf/chain-event-listener — runGracefulShutdown (P17 M2b-P5, REQ-DOH-021/022/023).
 *
 * The PURE, exit-injected ordered-teardown orchestrator each daemon `main()`
 * wires at P8-P10. It replaces the blind `setTimeout(exit, 5000)` of the
 * chain-triggered shutdown path with a deterministic five-step sequence:
 *
 *   (1) setAccepting(false)               — refuse new connections/joins at once
 *   (2) race(drain(), DRAIN_TIMEOUT_MS)   — drain in-flight, bounded by 30s; a
 *                                           hung drain unblocks at the timeout
 *                                           (DOH-022) — it never wedges teardown
 *   (3) stopReactive()                    — stop chain listeners + business
 *                                           pollers + the M2a HealthMonitor
 *                                           (composition rule C-A: the
 *                                           HealthMonitor is a chain-SUBMITTING
 *                                           reactive loop, so it stops HERE, NOT
 *                                           in the liveness group)
 *   (4) stopHeartbeatAndHealthz()         — tear down heartbeat + /healthz
 *                                           (+ /api/probe for relay) LAST so the
 *                                           chain sees the node LIVE through the
 *                                           whole drain (D-DOH-M2-F60-3, the P15
 *                                           split-brain fix: a relay that stops
 *                                           heartbeating mid-drain gets marked
 *                                           stale and permissionlessly promoted)
 *   (5) exit(0)
 *
 * A FORCE_KILL_TIMEOUT_MS (60s) timer wraps the WHOLE sequence (DOH-023): if any
 * step wedges past it, exit(1) fires unconditionally. Exit is EXACTLY-ONCE — a
 * force-kill that wins a race against a late normal completion exits once (the
 * `exited` latch), mirroring the F60 self-shutdown one-shot guard (D-DOH-M2-F60-5).
 *
 * PURE by design: `exit` is INJECTED (no `process.exit`), there are NO daemon
 * imports, and the only dependency is the `@dvconf/shared` `Logger` TYPE — so the
 * orchestrator is fully unit-testable under fake timers. The per-daemon wiring
 * (P8-P10) supplies the real collaborators (`setAccepting`/`drain`/`stopReactive`/
 * `stopHeartbeatAndHealthz` closures over that daemon's resources) + `exit:
 * process.exit` + the env-resolved timeouts via {@link readGracefulShutdownConfig}.
 *
 * Logging: the injected `@dvconf/shared` `logger` only — no raw console.*.
 */

import type { Logger } from '@dvconf/shared';

/** DRAIN_TIMEOUT_MS default — bound on step (2) in-flight drain (DOH-022). */
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
/** FORCE_KILL_TIMEOUT_MS default — backstop over the whole sequence (DOH-023). */
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 60_000;

export interface GracefulShutdownPlan {
  /** Human-readable shutdown cause (e.g. 'slashed' | 'SIGTERM') — for logs. */
  reason: string;
  logger: Logger;
  /** (1) Stop accepting new connections/joins. Synchronous, runs first. */
  setAccepting: (accepting: boolean) => void;
  /** (2) Drain in-flight work; resolves when empty. Raced against `drainTimeoutMs`. */
  drain: () => Promise<void>;
  /**
   * (3) Stop chain listeners + business pollers + the HealthMonitor (C-A). Runs
   * AFTER the drain and BEFORE the liveness group.
   */
  stopReactive: () => Promise<void>;
  /**
   * (4) Tear down heartbeat + /healthz (+ /api/probe for relay) — LAST, so the
   * chain sees the node live through the drain (D-DOH-M2-F60-3).
   */
  stopHeartbeatAndHealthz: () => Promise<void>;
  /**
   * Process exit, INJECTED for purity/testability (`process.exit` in prod). The
   * orchestrator calls it EXACTLY ONCE: `exit(0)` on clean completion, `exit(1)`
   * on force-kill or a teardown error.
   */
  exit: (code: number) => never;
  /** Step (2) drain bound in ms; default {@link DEFAULT_DRAIN_TIMEOUT_MS} (DOH-022). */
  drainTimeoutMs?: number;
  /** Whole-sequence force-kill bound in ms; default {@link DEFAULT_FORCE_KILL_TIMEOUT_MS} (DOH-023). */
  forceKillTimeoutMs?: number;
}

/**
 * Run the ordered graceful-shutdown sequence and exit. Never returns to the
 * caller — it always ends in a single injected `exit(code)`. A hung drain is
 * bounded by `drainTimeoutMs`; a hung whole sequence by `forceKillTimeoutMs`.
 */
export async function runGracefulShutdown(plan: GracefulShutdownPlan): Promise<never> {
  const {
    reason,
    logger,
    setAccepting,
    drain,
    stopReactive,
    stopHeartbeatAndHealthz,
    exit,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS,
  } = plan;

  // Exactly-once exit latch + the force-kill timer handle. `finish` clears the
  // timer and suppresses any second exit (so a late clean completion cannot
  // exit(0) after the force-kill already exit(1)'d — D-DOH-M2-F60-5 one-shot).
  let exited = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const finish = (code: number): never => {
    // The `exited` latch below is the PRIMARY exactly-once guarantee; clearing
    // the force timer is belt-and-suspenders (and frees the handle so a clean
    // exit leaves no armed timer).
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
      forceTimer = undefined;
    }
    if (exited) return undefined as never; // force-kill won the race
    exited = true;
    return exit(code);
  };

  // Force-kill backstop over the WHOLE sequence (DOH-023). NOT unref'd — it must
  // keep the loop alive until the sequence completes or it fires.
  forceTimer = setTimeout(() => {
    logger.error(
      { reason, forceKillTimeoutMs },
      'graceful shutdown exceeded force-kill timeout; forcing exit(1)',
    );
    finish(1);
  }, forceKillTimeoutMs);

  try {
    logger.info({ reason }, 'graceful shutdown initiated');

    setAccepting(false); // (1)
    await raceDrain(drain, drainTimeoutMs, reason, logger); // (2)
    await stopReactive(); // (3) — incl. HealthMonitor (C-A)
    await stopHeartbeatAndHealthz(); // (4) — LAST (split-brain fix)

    logger.info({ reason }, 'graceful shutdown complete; exiting(0)');
    return finish(0);
  } catch (err: unknown) {
    logger.error({ err, reason }, 'graceful shutdown teardown error; forcing exit(1)');
    return finish(1);
  }
}

/**
 * Race the in-flight drain against `timeoutMs` (DOH-022). Resolves when the drain
 * settles OR the timeout fires — whichever first — and NEVER rejects: a drain
 * that rejects (or throws synchronously) is best-effort, logged, and treated as
 * drained so teardown still proceeds. The drain is invoked exactly once.
 */
function raceDrain(
  drain: () => Promise<void>,
  timeoutMs: number,
  reason: string,
  logger: Logger,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      if (settled) return;
      logger.warn({ reason, drainTimeoutMs: timeoutMs }, 'drain timed out; proceeding to teardown');
      settle();
    }, timeoutMs);
    // `Promise.resolve().then(drain)` normalizes a synchronous throw into a
    // rejection so both paths land in the same handler.
    Promise.resolve()
      .then(() => drain())
      .then(settle, (err: unknown) => {
        logger.warn({ err, reason }, 'drain failed; proceeding to teardown');
        settle();
      });
  });
}

/** Env-derived timeouts for {@link runGracefulShutdown}. */
export interface GracefulShutdownConfig {
  drainTimeoutMs: number;
  forceKillTimeoutMs: number;
}

/**
 * Read the graceful-shutdown timeouts from env, with the design defaults as the
 * fallback (mirrors {@link readReplayGovernorConfig}):
 *   `DRAIN_TIMEOUT_MS`       -> drainTimeoutMs     (default 30000, DOH-022)
 *   `FORCE_KILL_TIMEOUT_MS`  -> forceKillTimeoutMs (default 60000, DOH-023)
 * `Number` (not `parseInt`) parse; an explicit blank guard avoids
 * `Number('') === 0` masking the default; an explicit `0` is honored.
 */
export function readGracefulShutdownConfig(
  env: NodeJS.ProcessEnv = process.env,
): GracefulShutdownConfig {
  return {
    drainTimeoutMs: readNumberEnv(env.DRAIN_TIMEOUT_MS, DEFAULT_DRAIN_TIMEOUT_MS),
    forceKillTimeoutMs: readNumberEnv(env.FORCE_KILL_TIMEOUT_MS, DEFAULT_FORCE_KILL_TIMEOUT_MS),
  };
}

/**
 * Parse an env string to a finite number; fall back on missing / blank / NaN.
 * `Number` so fractional values round-trip; the blank guard avoids
 * `Number('') === 0` masking the default.
 */
function readNumberEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : fallback;
}
