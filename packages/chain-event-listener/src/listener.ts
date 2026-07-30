/**
 * @dvconf/chain-event-listener — ChainEventListener (P17 M2b, REQ-DOH-019/026/027/028).
 *
 * A thin COMPOSITION wrapper over the shipped @dvconf/shared `EventPoller`: one
 * poller per Move module, and ownership of the per-module cursor path under
 * DATA_DIR (`<dataDir>/.cursors/<module>.json`). `EventPoller` has no base-dir
 * concept — it defaults `cursorPath` to a bare `cursor.json` — so the listener
 * computes the full path and passes it in, mirroring the 13 existing call sites
 * that hardcode `.cursors/<module>.json`.
 *
 * P1 shipped the SKELETON (subscribe + per-module cursor + stop + an
 * isDegraded() stub); P2 shipped the isolated `ReplayGovernor`. P3 wires them:
 * on subscribe() the listener snapshots the chain tip's timestamp and tags
 * every event delivered while draining the backlog up to head
 * `meta.replayed=true`, throttled to `replayRateLimitHz` and capped at
 * `replayMaxEvents` per restart (DOH-026/027). Live-tip events are NEVER
 * throttled, capped, or dropped. On cap-overflow the default is HALT — abort
 * the replay, shed the in-flight remainder, and latch `isDegraded()` so a
 * downstream /healthz can 503 (P7+); `dropBacklogOnCapExceeded` opts a
 * level-triggered idempotent consumer into DRAIN-FAST instead.
 *
 * `meta.replayed` is a FORENSIC LOG HINT, not a correctness boundary: the
 * replay/live split is a best-effort timestamp watermark (EventPoller surfaces
 * no page-boundary signal to the wrapper), and EventPoller's regenesis
 * self-heal can re-walk old events after goLive(). Handlers MUST therefore be
 * safe under DUPLICATE and out-of-phase delivery (DOH-028) — the listener does
 * NO dedup. The baseline idempotency discipline is the **F49 idempotent-rebuild
 * pattern** (rebuild authoritative state from the CURRENT chain read so a
 * replayed or duplicated historical event is state-inert); a terminal one-shot
 * consumer additionally guards itself at-most-once (the F60 self-shutdown
 * watcher, P4).
 *
 * Logging: the injected `logger` from @dvconf/shared is the ONLY surface — no
 * raw console.*.
 */

import { join } from 'node:path';
import { EventPoller } from '@dvconf/shared';
import type { Logger } from '@dvconf/shared';
import type { SuiEvent } from '@mysten/sui/client';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { ReplayGovernor, readReplayGovernorConfig } from './replay-governor.js';

interface TipQueryResult {
  events: {
    nodes: { timestamp: string | null }[];
  };
}

// See events.ts's EVENTS_QUERY comment: `type` (pinned to the original
// defining package) is used instead of `module` (pinned to whichever
// package version was executing at emit time, which changes on every
// upgrade) so the tip watermark doesn't go stale/empty after an upgrade.
const TIP_QUERY = `
  query ChainTip($eventType: String!) {
    events(filter: { type: $eventType }, last: 1) {
      nodes { timestamp }
    }
  }
`;

export interface ChainEventListenerOptions {
  /** Event queries only -- see @dvconf/shared's createGraphQLClient docstring. */
  client: SuiGraphQLClient;
  /** The ORIGINAL defining package (NetworkConfig.originalPackageId), not the latest upgraded packageId -- see EventPoller's EVENTS_QUERY comment in @dvconf/shared. */
  packageId: string;
  logger: Logger;
  /** Base dir for the per-module cursors; default `process.env.DATA_DIR ?? '.'`. */
  dataDir?: string;
  /**
   * Replay-phase throttle (events/sec). Per-LISTENER (not per-subscribe);
   * default `readReplayGovernorConfig()` (env `REPLAY_RATE_LIMIT_HZ` ?? 100,
   * DOH-027). An explicit `0` disables the throttle.
   */
  replayRateLimitHz?: number;
  /**
   * Per-restart replay cap before abort. Per-LISTENER; default
   * `readReplayGovernorConfig()` (env `REPLAY_MAX_EVENTS_PER_RESTART` ?? 1000,
   * DOH-027).
   */
  replayMaxEvents?: number;
}

export interface SubscribeOptions {
  pollingIntervalMs: number;
  /**
   * On replay cap-overflow: `false` (default) = HALT — abort the replay, shed
   * the in-flight backlog remainder, and latch `isDegraded()` (operator-visible
   * via /healthz 503 on cp/sig/validator; relay surfaces a 200-body flag, F1).
   * `true` = DRAIN-FAST — stop throttling/capping and finish delivering the
   * remaining backlog tagged live, staying healthy (200). Opt in ONLY for a
   * level-triggered, idempotent handler (DOH-028) — the F60 self-shutdown
   * subscription is the sole opt-in (P4).
   */
  dropBacklogOnCapExceeded?: boolean;
}

/**
 * A subscribed handler. `meta.replayed` distinguishes a backlog-replay event
 * from a live-tip event — a FORENSIC HINT only (best-effort timestamp
 * watermark, state-inert under DOH-028 idempotency); never gate correctness on
 * it.
 */
export type ListenerHandler = (
  event: SuiEvent,
  meta: { replayed: boolean },
) => Promise<void>;

export class ChainEventListener {
  private readonly client: SuiGraphQLClient;
  private readonly packageId: string;
  private readonly logger: Logger;
  private readonly dataDir: string;
  private readonly replayRateLimitHz?: number;
  private readonly replayMaxEvents?: number;

  /** One EventPoller per subscribed module; stop() drains them all. */
  private readonly pollers: EventPoller[] = [];

  /**
   * Listener-level OR-latch: set true by ANY module's replay HALT, sticky until
   * restart (matches the per-restart cap). Read by `isDegraded()`.
   */
  private degraded = false;

  constructor(opts: ChainEventListenerOptions) {
    this.client = opts.client;
    this.packageId = opts.packageId;
    this.logger = opts.logger;
    this.dataDir = opts.dataDir ?? process.env.DATA_DIR ?? '.';
    this.replayRateLimitHz = opts.replayRateLimitHz;
    this.replayMaxEvents = opts.replayMaxEvents;
  }

  /**
   * Subscribe to one Move module. Snapshots the chain tip's timestamp (fail-open
   * — any RPC error / missing timestamp ⇒ no replay phase, live from event #1),
   * constructs an `EventPoller` with the computed per-module cursor path, and
   * starts it behind a wrapping closure that derives the replay/live boundary
   * and applies a per-module `ReplayGovernor` to the BACKLOG ONLY.
   */
  async subscribe(
    module: string,
    handler: ListenerHandler,
    opts: SubscribeOptions,
  ): Promise<void> {
    const cursorPath = join(this.dataDir, '.cursors', `${module}.json`);
    const poller = new EventPoller({
      client: this.client,
      packageId: this.packageId,
      module,
      pollingIntervalMs: opts.pollingIntervalMs,
      cursorPath,
      logger: this.logger,
    });
    this.pollers.push(poller);
    this.logger.info({ module, cursorPath }, 'ChainEventListener subscribed');

    // Replay/live watermark: snapshot the tip BEFORE start(). Fail-open — a
    // throw, an empty page, or an absent/blank timestamp ⇒ tipTs=null ⇒ live
    // from event #1 (never wedge a caught-up daemon in permanent replay).
    let tipTs: number | null = null;
    try {
      const result: { data?: TipQueryResult } = await this.client.query<TipQueryResult, { eventType: string }>({
        query: TIP_QUERY,
        variables: { eventType: `${this.packageId}::${module}` },
      });
      const t = result.data?.events.nodes[0]?.timestamp;
      const n = t ? Date.parse(t) : NaN;
      tipTs = Number.isFinite(n) ? n : null;
    } catch {
      tipTs = null;
    }

    const envCfg = readReplayGovernorConfig();
    const rateLimitHz = this.replayRateLimitHz ?? envCfg.rateLimitHz;
    const maxEvents = this.replayMaxEvents ?? envCfg.maxEvents;
    const governor = new ReplayGovernor(rateLimitHz, maxEvents);

    let live = false; // closure-local latch (ReplayGovernor exposes only capExceeded)
    let aborted = false; // per-poller HALT latch
    const goLive = (): void => {
      if (!live) {
        live = true;
        governor.goLive();
      }
    };
    if (tipTs === null) goLive(); // fail-open ⇒ live from event #1

    await poller.start(async (event: SuiEvent) => {
      if (live) {
        // LIVE tip: never throttled / capped / dropped.
        await handler(event, { replayed: false });
        return;
      }
      // Derive the boundary from the event timestamp. A null/absent ts forces
      // live (the `Number(null) === 0` wedge guard); strict `<`, so ties → live.
      const raw = event.timestampMs;
      const evN = raw ? Number(raw) : NaN;
      const eventTs = Number.isFinite(evN) ? evN : null;
      const replayed = tipTs !== null && eventTs !== null && eventTs < tipTs;
      if (!replayed) {
        // Caught up to head — latch live and deliver.
        goLive();
        await handler(event, { replayed: false });
        return;
      }
      if (aborted) return; // HALT already tripped ⇒ shed the in-flight remainder
      await governor.acquire(); // REPLAY only: throttle to ~rateLimitHz
      if (!governor.tick()) {
        // Cap exceeded (the maxEvents+1-th replay event).
        if (opts.dropBacklogOnCapExceeded) {
          // DRAIN-FAST: disable throttle/cap, keep delivering, stay healthy.
          goLive();
          await handler(event, { replayed: true });
          return;
        }
        // HALT (default): abort the replay, latch degraded, stop the NEXT poll
        // cycle. The in-flight pollOnce drain cannot be interrupted (its loop
        // never re-checks `running`) — `aborted` sheds its remainder at the
        // wrapper. Bounded loss: EventPoller's cursor advances past the dropped
        // events, so they are NOT re-drained on restart; operator-visible via 503.
        aborted = true;
        this.degraded = true;
        this.logger.error(
          { module },
          'replay cap exceeded — aborting replay; isDegraded() latched (surfaced downstream via /healthz: 503 on cp/sig/validator, 200-body degraded flag on relay per F1)',
        );
        poller.stop();
        return;
      }
      // DOH-026: per-event replayed log hint (heuristic / forensic only).
      this.logger.debug({ module, replayed: true }, 'replay event');
      await handler(event, { replayed: true });
    });
  }

  /**
   * Whether the listener is shedding load — a sticky OR-latch set true once ANY
   * module's replay aborted on cap-overflow (HALT). Stays true until restart
   * (matches the per-restart cap; the governor's `exceeded` never resets). A
   * downstream /healthz reads this to 503 (cp/sig/validator) or to set a
   * 200-body `degraded` flag (relay, F1). Plain synchronous getter.
   */
  isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Stop every tracked poller, then forget them so a second `stop()` is a no-op
   * (each poller is stopped exactly once). `EventPoller.stop` is itself
   * idempotent, but draining the list keeps the call count tight and makes the
   * idempotency observable.
   */
  async stop(): Promise<void> {
    const count = this.pollers.length;
    // EventPoller.stop() is itself async now (awaits its in-flight poll
    // cycle, including any pending cursor-save write) -- await all of them
    // so a caller that exits the process right after this resolves can't
    // race a cursor write into a truncated/unreadable file.
    await Promise.all(this.pollers.map((poller) => poller.stop()));
    this.pollers.length = 0;
    this.logger.info({ pollers: count }, 'ChainEventListener stopped');
  }
}
