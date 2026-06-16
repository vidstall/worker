/**
 * @dvconf/chain-event-listener — SelfShutdownWatcher (P17 M2b-P4, DOH-020/021/024/028).
 *
 * A per-daemon, self-targeted TERMINAL trigger. It subscribes (via the
 * ChainEventListener) to the frozen-contract reactive events FILTERED BY THIS
 * NODE'S OWN miner id — `RelaySlashed.relay_miner_id == ownMinerId` (economic_layer)
 * and `NodeDegraded.miner_id == ownMinerId && level === 2` (node_health) — plus a
 * periodic `is_paused()` poll (RelayPaused is a network-global bool, not an event).
 * The FIRST match invokes `onSelfShutdown(reason)` AT MOST ONCE (a one-shot guard),
 * so a re-delivered OR replayed trigger (DOH-028) shuts the daemon down exactly once.
 *
 * Arms gate which triggers are live per daemon (D-DOH-M2-F60-1 / -4):
 *   relay               = { slash, degraded, paused }  (the only slashable daemon)
 *   validator/signaling = { degraded, paused }         (report-only on slash)
 *   cp-daemon           = { paused }                    (not slashable; the existing
 *                         cp event-handler RelaySlashed arm for OTHER relays is UNTOUCHED)
 *
 * SELF-FILTER SAFETY — two load-bearing layers:
 *  1. event TYPE FIRST. The economic_layer poller delivers EVERY economic event,
 *     and `SessionProof` ALSO carries a `relay_miner_id` field — so we match
 *     `::RelaySlashed` by the event type before reading the id; a session proof
 *     for OUR own relay must NOT self-shut-down us.
 *  2. own-id. Only THIS node's id triggers — a foreign emit is inert (C7: the
 *     authority residual is bounded to self-noise; `NodeDegraded` is emit-only).
 *
 * Both event subscriptions opt into `dropBacklogOnCapExceeded` (DRAIN-FAST) — the
 * SOLE opt-in in the system (listener.ts SubscribeOptions). This consumer is
 * level-triggered + idempotent + one-shot, so a dropped historical transition is
 * inert (it re-reads authoritative chain state on the next live poll). `meta.replayed`
 * is intentionally IGNORED: a replayed self-slash means the node WAS slashed and
 * SHOULD shut down on restart; the one-shot guard collapses replay/live duplicates.
 *
 * Pause is an INJECTED reader (`isPaused`), mirroring the M2a HealthMonitor's
 * D-DOH-M2-HM-5 injection + the P10 deps-abstracted-reader lesson — NOT the §3.2
 * sketch's `client`+`networkRegistryId`. This keeps the package decoupled from the
 * `network_registry` object layout and fully mock-unit-testable; the daemon wiring
 * (P8-P10) supplies a closure that does the on-chain `is_paused(net_reg)` read and
 * resolves `PAUSE_POLL_INTERVAL_MS`. The §3.2 `startSelfShutdownWatcher` factory is
 * realized as this CLASS (HealthMonitor precedent — the directly unit-assertable
 * primitive; the per-daemon factory wraps it at wiring).
 *
 * Logging: the injected @dvconf/shared `logger` only — no raw console.*.
 */

import type { SuiEvent } from '@mysten/sui/client';
import type { Logger, NodeDegraded, RelaySlashed } from '@dvconf/shared';
import type { ChainEventListener, ListenerHandler } from './listener.js';

/** The terminal reason handed to {@link SelfShutdownWatcherOptions.onSelfShutdown}. */
export type ShutdownReason = 'slashed' | 'degraded' | 'paused';

/** Which self-shutdown triggers are live for this daemon (D-DOH-M2-F60-1 / -4). */
export interface ShutdownArms {
  /** `RelaySlashed(self)` — relay only (the sole slashable daemon). */
  slash: boolean;
  /** `NodeDegraded(self, level===2)` — relay / validator / signaling. */
  degraded: boolean;
  /** `is_paused()` poll — all four daemon types. */
  paused: boolean;
}

export interface SelfShutdownWatcherOptions {
  listener: ChainEventListener;
  /** This node's miner id — the self-filter key for BOTH event arms. */
  ownMinerId: string;
  arms: ShutdownArms;
  /** Invoked AT MOST ONCE on the first matching trigger (one-shot, DOH-028). */
  onSelfShutdown: (reason: ShutdownReason) => void;
  logger: Logger;
  /**
   * Reads `network_registry::is_paused()` (cached or fresh). REQUIRED when
   * `arms.paused` — omitting it logs a WARN and disables the pause arm (no crash).
   * Injected (D-DOH-M2-HM-5 precedent) so the package stays decoupled from the
   * registry object layout; the daemon supplies the on-chain read. A read error
   * is fail-open (treated as not-paused) so a transient RPC hiccup never self-kills.
   */
  isPaused?: () => boolean | Promise<boolean>;
  /**
   * `is_paused()` poll cadence in ms (default 10000 — the daemon resolves
   * `PAUSE_POLL_INTERVAL_MS`). Pause + degraded reaction is poll-latency-bounded by
   * one interval, NOT event-instant (C8 / D-F60-1).
   */
  pausePollIntervalMs?: number;
  /**
   * Event-poll cadence handed to the listener subscribes in ms (default 10000) —
   * distinct from the `is_paused()` object poll.
   */
  eventPollIntervalMs?: number;
}

const DEFAULT_PAUSE_POLL_INTERVAL_MS = 10_000;
const DEFAULT_EVENT_POLL_INTERVAL_MS = 10_000;

export class SelfShutdownWatcher {
  private readonly listener: ChainEventListener;
  private readonly ownMinerId: string;
  private readonly arms: ShutdownArms;
  private readonly onSelfShutdown: (reason: ShutdownReason) => void;
  private readonly logger: Logger;
  private readonly isPaused?: () => boolean | Promise<boolean>;
  private readonly pausePollIntervalMs: number;
  private readonly eventPollIntervalMs: number;

  /** One-shot latch: set true on the FIRST trigger so `onSelfShutdown` fires once. */
  private shuttingDown = false;
  private pauseTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SelfShutdownWatcherOptions) {
    this.listener = opts.listener;
    this.ownMinerId = opts.ownMinerId;
    this.arms = opts.arms;
    this.onSelfShutdown = opts.onSelfShutdown;
    this.logger = opts.logger;
    this.isPaused = opts.isPaused;
    this.pausePollIntervalMs = opts.pausePollIntervalMs ?? DEFAULT_PAUSE_POLL_INTERVAL_MS;
    this.eventPollIntervalMs = opts.eventPollIntervalMs ?? DEFAULT_EVENT_POLL_INTERVAL_MS;
  }

  /**
   * Wire the ENABLED arms: subscribe to economic_layer (slash) / node_health
   * (degraded) via the listener with the sole DRAIN-FAST opt-in, and start the
   * `is_paused()` poll. Disabled arms are never subscribed.
   */
  async start(): Promise<void> {
    const subOpts = {
      pollingIntervalMs: this.eventPollIntervalMs,
      dropBacklogOnCapExceeded: true,
    };

    if (this.arms.slash) {
      await this.listener.subscribe('economic_layer', this.handleSlash, subOpts);
    }
    if (this.arms.degraded) {
      await this.listener.subscribe('node_health', this.handleDegraded, subOpts);
    }
    if (this.arms.paused) {
      if (this.isPaused === undefined) {
        this.logger.warn(
          { ownMinerId: this.ownMinerId },
          'SelfShutdownWatcher: paused arm enabled but no isPaused reader — pause arm disabled',
        );
      } else {
        this.pauseTimer = setInterval(() => {
          void this.checkPauseOnce().catch((err: unknown) => {
            this.logger.error({ err }, 'SelfShutdownWatcher: is_paused poll failed');
          });
        }, this.pausePollIntervalMs);
      }
    }

    this.logger.info(
      { ownMinerId: this.ownMinerId, arms: this.arms },
      'SelfShutdownWatcher started',
    );
  }

  /**
   * One `is_paused()` poll cycle (exported for tests; mirrors HealthMonitor.tick).
   * A `true` reading triggers the paused shutdown once. A read error is fail-open
   * (logged, no shutdown) — a transient RPC hiccup must not self-kill the daemon.
   */
  async checkPauseOnce(): Promise<void> {
    if (this.shuttingDown || this.isPaused === undefined) return;
    let paused: boolean;
    try {
      paused = await this.isPaused();
    } catch (err: unknown) {
      this.logger.warn(
        { err },
        'SelfShutdownWatcher: is_paused read failed; treating as not-paused',
      );
      return;
    }
    if (paused) this.trigger('paused');
  }

  /**
   * Stop the `is_paused()` poll. Idempotent. (Tearing down the ChainEventListener
   * + the rest of the daemon is the graceful-shutdown orchestrator's job, P5.)
   */
  stop(): void {
    if (this.pauseTimer !== undefined) {
      clearInterval(this.pauseTimer);
      this.pauseTimer = undefined;
    }
  }

  /** economic_layer handler: a self-targeted `RelaySlashed` → 'slashed'. */
  private readonly handleSlash: ListenerHandler = async (event: SuiEvent) => {
    if (this.shuttingDown) return;
    // TYPE filter FIRST — SessionProof in this module ALSO carries relay_miner_id.
    if (!event.type?.endsWith('::RelaySlashed')) return;
    const p = event.parsedJson as RelaySlashed | undefined;
    if (p?.relay_miner_id === this.ownMinerId) this.trigger('slashed');
  };

  /** node_health handler: a self-targeted `NodeDegraded` at level 2 → 'degraded'. */
  private readonly handleDegraded: ListenerHandler = async (event: SuiEvent) => {
    if (this.shuttingDown) return;
    if (!event.type?.endsWith('::NodeDegraded')) return;
    const p = event.parsedJson as NodeDegraded | undefined;
    if (p?.miner_id === this.ownMinerId && Number(p.level) === 2) this.trigger('degraded');
  };

  /** One-shot terminal trigger: latch, stop the pause poll, log, invoke the callback once. */
  private trigger(reason: ShutdownReason): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stop(); // no further pause polls
    this.logger.error(
      { reason, ownMinerId: this.ownMinerId },
      'self-shutdown trigger matched; invoking onSelfShutdown',
    );
    this.onSelfShutdown(reason);
  }
}
