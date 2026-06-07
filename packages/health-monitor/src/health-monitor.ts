/**
 * @dvconf/health-monitor — F61 daemon self-degradation core (P17 M2a-P6).
 *
 * A generic, daemon-agnostic level machine (REQ-DOH-013 / DOH-018). Each daemon
 * supplies its OWN `HealthSignal[]` readers (REQ-DOH-014, wired in P10); this
 * package owns the shared logic: poll -> map each signal to a 0/1/2 level ->
 * worst-wins MAX aggregation -> report on a level CHANGE via an injected
 * `DegradationReporter`.
 *
 * P6 scope = the scaffold + the level state machine (worst-wins, fail-open,
 * report-on-change, start/stop/tick). P7 layers the per-level cooldown on top
 * (this file + thresholds.ts). The chain PTB reporter (P8) and the `isPaused`
 * gate (P9) follow. No chain, no daemon deps here.
 *
 * Design: DESIGN.md D-DOH-M2-HM-1 (generic class; daemons supply readers) +
 * D-DOH-M2-HM-2 (level = worst-wins MAX; reader error = fail-OPEN level 0 + WARN) +
 * D-DOH-M2-HM-3 (per-level cooldown; a distinct level bypasses).
 */

import type { Logger } from '@dvconf/shared';

/** 0 = healthy, 1 = degraded, 2 = unhealthy. */
export type HealthLevel = 0 | 1 | 2;

/** A raw metric sample: a numeric value plus an OPTIONAL pre-mapped level. */
export interface SignalSample {
  value: number;
  level?: HealthLevel;
}

/** value >= degradedAt => 1, value >= unhealthyAt => 2 (checked unhealthy-first). */
export interface SignalThresholds {
  degradedAt: number;
  unhealthyAt: number;
}

/**
 * A named per-daemon probe (REQ-DOH-014). `read` may throw or return `null` =>
 * fail-OPEN (level 0 + a WARN log). Omit `thresholds` when `read` returns an
 * explicit `level`.
 */
export interface HealthSignal {
  name: string;
  read: () => SignalSample | null | Promise<SignalSample | null>;
  thresholds?: SignalThresholds;
}

/** The injected chain sink (D-DOH-M2-HM-4). Returns true on a confirmed submit. */
export interface DegradationReporter {
  report(level: HealthLevel): Promise<boolean>;
}

export interface HealthMonitorOptions {
  signals: HealthSignal[];
  reporter: DegradationReporter;
  logger: Logger;
  /** Poll cadence in ms (default 10000). */
  intervalMs?: number;
  /**
   * Per-level re-report suppression window in ms (default 60000,
   * `DEGRADATION_COOLDOWN_MS` — read via `readCooldownMs`). After a level is
   * reported, re-reporting that SAME level is suppressed until the window
   * elapses; a change to a DISTINCT not-recently-seen level always reports
   * (escalation / recovery is never delayed). See D-DOH-M2-HM-3.
   */
  cooldownMs?: number;
}

const DEFAULT_INTERVAL_MS = 10_000;

/** Default per-level re-report suppression window (REQ-DOH-016, D-DOH-M2-HM-3). */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** Map a raw value to a level (unhealthy checked first). */
function mapToLevel(value: number, t: SignalThresholds): HealthLevel {
  if (value >= t.unhealthyAt) return 2;
  if (value >= t.degradedAt) return 1;
  return 0;
}

export class HealthMonitor {
  private readonly signals: HealthSignal[];
  private readonly reporter: DegradationReporter;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly cooldownMs: number;

  /** Current aggregated (worst-wins) level — updated every tick. */
  private aggregatedLevel: HealthLevel = 0;
  /** Last level handed to the reporter — drives report-on-CHANGE (the trigger baseline). */
  private reportedLevel: HealthLevel = 0;
  /**
   * `Date.now()` of the most recent report PER level — drives the cooldown
   * debounce. A level absent from the map was never reported (so its first
   * report is never delayed); healthy startup leaves level 0 absent.
   */
  private readonly lastReportAtByLevel = new Map<HealthLevel, number>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: HealthMonitorOptions) {
    this.signals = opts.signals;
    this.reporter = opts.reporter;
    this.logger = opts.logger;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** The current aggregated level (worst-wins across all signals). */
  get level(): HealthLevel {
    return this.aggregatedLevel;
  }

  /** Begin polling on the configured interval. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger.error({ err }, 'health monitor tick failed');
      });
    }, this.intervalMs);
  }

  /** Stop polling. Idempotent. */
  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One poll cycle (exported for tests; mirrors EventPoller.pollOnce): read all
   * signals, aggregate worst-wins, and report on a level CHANGE — debounced by
   * the per-level cooldown (D-DOH-M2-HM-3).
   *
   * Trigger = `aggregated !== reportedLevel` (report-on-CHANGE baseline). A
   * change is suppressed ONLY when that exact level was reported within
   * `cooldownMs` (a flap revisiting a recently-emitted level); a distinct,
   * not-recently-seen level — every monotone escalation 1→2 / recovery 2→0 —
   * always reports. On a suppressed change `reportedLevel` is left unchanged, so
   * the trigger re-fires each tick and self-heals once the window elapses.
   */
  async tick(): Promise<void> {
    const previous = this.reportedLevel;
    const levels = await Promise.all(this.signals.map((s) => this.readSignalLevel(s)));
    const aggregated = levels.reduce<HealthLevel>((worst, l) => (l > worst ? l : worst), 0);
    this.aggregatedLevel = aggregated;

    if (aggregated === previous) return; // steady — nothing to report

    const lastAt = this.lastReportAtByLevel.get(aggregated);
    const now = Date.now();
    if (lastAt !== undefined && now - lastAt < this.cooldownMs) {
      // A re-report of a level emitted within its window: debounce the flap.
      // Keep `reportedLevel` unchanged so this change is re-evaluated next tick.
      this.logger.debug(
        { level: aggregated, sinceMs: now - lastAt, cooldownMs: this.cooldownMs },
        'node health level re-report suppressed within cooldown window',
      );
      return;
    }

    this.logger.info({ from: previous, to: aggregated }, 'node health level changed');
    await this.reporter.report(aggregated);
    this.reportedLevel = aggregated;
    this.lastReportAtByLevel.set(aggregated, now);
  }

  /**
   * Resolve one signal to a level. Explicit `sample.level` wins; else map the
   * raw value through `thresholds`. A throw / null / missing-mapping is
   * fail-OPEN (level 0 + a WARN) so a flaky probe never self-reports a daemon
   * as degraded (D-DOH-M2-HM-2).
   */
  private async readSignalLevel(signal: HealthSignal): Promise<HealthLevel> {
    try {
      const sample = await signal.read();
      if (sample === null) {
        this.logger.warn({ signal: signal.name }, 'health signal returned null; treating as healthy');
        return 0;
      }
      if (sample.level !== undefined) return sample.level;
      if (signal.thresholds !== undefined) return mapToLevel(sample.value, signal.thresholds);
      this.logger.warn(
        { signal: signal.name },
        'health signal has neither an explicit level nor thresholds; treating as healthy',
      );
      return 0;
    } catch (err: unknown) {
      this.logger.warn({ signal: signal.name, err }, 'health signal read failed; treating as healthy');
      return 0;
    }
  }
}
