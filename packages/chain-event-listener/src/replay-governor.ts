/**
 * @dvconf/chain-event-listener — ReplayGovernor (P17 M2b-P2, REQ-DOH-027).
 *
 * A PURE, ISOLATED throttle for the chain-event REPLAY phase: a token bucket
 * that admits ~`rateLimitHz` events/sec while catching up the backlog, plus a
 * per-restart `maxEvents` cap that, once exceeded, signals the caller to abort
 * the replay. The cap is per-ReplayGovernor-INSTANCE (one instance per
 * listener/module — the decided default; NOT a shared cross-module counter).
 *
 * This is the governor ONLY — P2 does NOT wire it into `ChainEventListener`
 * (that is P3). It has no dependency on the listener or the chain and emits NO
 * logs (a pure util; the caller logs the cap-abort decision).
 *
 * Token-bucket model: a bucket of capacity `rateLimitHz` that refills at
 * `rateLimitHz` tokens/sec (one token per `1000/rateLimitHz` ms). The bucket is
 * tracked as a single `availableAt` watermark — the earliest time (via an
 * INJECTED `now`, default `Date.now`) the next event may admit. A fresh bucket
 * is full, so the first `rateLimitHz` acquires admit instantly (`availableAt`
 * stays in the past); once drained, each `acquire()` advances `availableAt` by
 * one token-interval and SERIALIZES the next waiter behind it — so N back-to-
 * back acquires on an empty bucket are spaced one interval apart, not all at
 * once. An empty-bucket waiter sleeps via `setTimeout`, which vitest fake
 * timers make exact. After `goLive()` the throttle is disabled: `acquire()`
 * resolves in the same microtask (and any already-pending waiter is released
 * immediately).
 */

/**
 * Token-bucket throttle + per-restart event cap for the replay phase.
 *
 * Construct one per listener instance/module. `acquire()` paces backlog
 * dispatch to ~`rateLimitHz`; `tick()`/`capExceeded` enforce the `maxEvents`
 * abort cap; `goLive()` switches to the live tip (throttle off).
 */
export class ReplayGovernor {
  private readonly rateLimitHz: number;
  private readonly maxEvents: number;
  private readonly now: () => number;

  /** ms between token refills (`1000 / rateLimitHz`); 0 when throttling is off. */
  private readonly msPerToken: number;
  /** Max past credit (`(rateLimitHz - 1)` intervals) — the burst headroom. */
  private readonly burstFloorMs: number;
  /**
   * Earliest wall-clock time (via `now`) the next event may admit. Initialized
   * `rateLimitHz` intervals in the PAST so a fresh bucket admits a full burst;
   * each admit advances it one interval, serializing queued waiters.
   */
  private availableAt: number;
  /** Events counted via tick(); the cap trips once this EXCEEDS maxEvents. */
  private counted = 0;
  /** True once tick() has exceeded maxEvents (latched — never resets). */
  private exceeded = false;
  /** After goLive() the throttle is disabled and acquire() resolves instantly. */
  private live = false;
  /** Pending throttled waiters, released en masse by goLive(). */
  private readonly waiters: Array<() => void> = [];

  /**
   * @param rateLimitHz max events/sec admitted during replay (also the bucket
   *   capacity, so a burst up to `rateLimitHz` is admitted instantly). `<= 0`
   *   disables throttling (every acquire resolves immediately).
   * @param maxEvents per-restart event cap; once tick() has counted more than
   *   this, tick() returns false and `capExceeded` latches true.
   * @param now injectable clock (default `Date.now`) for deterministic tests.
   */
  constructor(rateLimitHz: number, maxEvents: number, now: () => number = Date.now) {
    this.rateLimitHz = rateLimitHz;
    this.maxEvents = maxEvents;
    this.now = now;
    this.msPerToken = rateLimitHz > 0 ? 1000 / rateLimitHz : 0;
    // A fresh bucket is FULL (capacity = rateLimitHz). Seed `availableAt`
    // `(rateLimitHz - 1)` intervals in the past so EXACTLY `rateLimitHz` acquires
    // admit instantly and the `(rateLimitHz + 1)`-th waits one interval.
    this.burstFloorMs = Math.max(0, rateLimitHz - 1) * this.msPerToken;
    this.availableAt = now() - this.burstFloorMs;
  }

  /**
   * Await a token. During replay, throttles to ~`rateLimitHz` (sleeping until
   * the next refill when the bucket is empty). After `goLive()` — or when the
   * rate limit is non-positive — resolves IMMEDIATELY in the same microtask.
   */
  acquire(): Promise<void> {
    if (this.live || this.rateLimitHz <= 0) return Promise.resolve();

    const t = this.now();
    // Clamp the watermark forward to `now - burstFloor`: idle time refills the
    // bucket but only up to capacity (never bank more than the burst headroom).
    const earliest = Math.max(this.availableAt, t - this.burstFloorMs);
    // This admit consumes one token-interval of allowance; the NEXT acquire is
    // serialized behind it (so queued waiters spread one interval apart).
    this.availableAt = earliest + this.msPerToken;

    const waitMs = earliest - t;
    if (waitMs <= 0) return Promise.resolve(); // a token is available now

    return new Promise<void>((resolve) => {
      let settled = false;
      const release = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // goLive() may fire before the timer — register the waiter so it is freed.
      this.waiters.push(release);
      setTimeout(release, Math.ceil(waitMs));
    });
  }

  /**
   * Count one replayed event. Returns true while at/under the cap, false once
   * the cap is EXCEEDED (the caller then aborts the replay). `maxEvents` events
   * are admitted; the `maxEvents + 1`-th trips the cap. `maxEvents <= 0` trips
   * on the first call.
   */
  tick(): boolean {
    this.counted += 1;
    if (this.counted > this.maxEvents) {
      this.exceeded = true;
      return false;
    }
    return true;
  }

  /**
   * Replay -> live (caught up to head): disable throttling so `acquire()`
   * resolves instantly, and release any waiter currently parked on the bucket.
   */
  goLive(): void {
    this.live = true;
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const release of pending) release();
  }

  /** True once tick() has exceeded `maxEvents` (latched — stays true). */
  get capExceeded(): boolean {
    return this.exceeded;
  }
}

/** Env-derived defaults for a {@link ReplayGovernor}. */
export interface ReplayGovernorConfig {
  rateLimitHz: number;
  maxEvents: number;
}

/**
 * Read the replay-governor config from env, with the design defaults as the
 * fallback (mirrors @dvconf/health-monitor `readCooldownMs`):
 *   `REPLAY_RATE_LIMIT_HZ`           -> rateLimitHz (default 100)
 *   `REPLAY_MAX_EVENTS_PER_RESTART`  -> maxEvents   (default 1000)
 * `Number` (not `parseInt`) parse; an explicit blank guard avoids
 * `Number('') === 0` masking the default; an explicit `0` is honored.
 */
export function readReplayGovernorConfig(env: NodeJS.ProcessEnv = process.env): ReplayGovernorConfig {
  return {
    rateLimitHz: readNumberEnv(env.REPLAY_RATE_LIMIT_HZ, 100),
    maxEvents: readNumberEnv(env.REPLAY_MAX_EVENTS_PER_RESTART, 1000),
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
