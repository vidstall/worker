/**
 * @dvconf/chain-event-listener — ChainEventListener (P17 M2b-P1, REQ-DOH-019).
 *
 * A thin COMPOSITION wrapper over the shipped @dvconf/shared `EventPoller`: one
 * poller per Move module, and ownership of the per-module cursor path under
 * DATA_DIR (`<dataDir>/.cursors/<module>.json`). `EventPoller` has no base-dir
 * concept — it defaults `cursorPath` to a bare `cursor.json` — so the listener
 * computes the full path and passes it in, mirroring the 13 existing call sites
 * that hardcode `.cursors/<module>.json`.
 *
 * P1 scope = the SKELETON: subscribe (one poller per module) + per-module cursor
 * + stop (stop every tracked poller, idempotent) + an `isDegraded()` stub. OUT
 * OF SCOPE here: the ReplayGovernor rate-limit/cap (P2) and the replay
 * tip-snapshot/`meta.replayed` tagging (P3). `meta.replayed` is ALWAYS false in
 * P1 and `isDegraded()` always returns false; the `meta` param exists now so P3
 * is a pure internal change with no signature churn.
 *
 * Logging: the injected `logger` from @dvconf/shared is the ONLY surface — no
 * raw console.*.
 */

import { join } from 'node:path';
import { EventPoller } from '@dvconf/shared';
import type { Logger } from '@dvconf/shared';
import type { SuiClient, SuiEvent } from '@mysten/sui/client';

export interface ChainEventListenerOptions {
  client: SuiClient;
  packageId: string;
  logger: Logger;
  /** Base dir for the per-module cursors; default `process.env.DATA_DIR ?? '.'`. */
  dataDir?: string;
}

export interface SubscribeOptions {
  pollingIntervalMs: number;
  // NOTE: `dropBacklogOnCapExceeded` (the replay cap) is added in P3. Not here.
}

/**
 * A subscribed handler. `meta.replayed` distinguishes a backlog-replay event
 * from a live-tip event — ALWAYS `false` in P1 (the replay/tip-snapshot is P3).
 */
export type ListenerHandler = (
  event: SuiEvent,
  meta: { replayed: boolean },
) => Promise<void>;

export class ChainEventListener {
  private readonly client: SuiClient;
  private readonly packageId: string;
  private readonly logger: Logger;
  private readonly dataDir: string;

  /** One EventPoller per subscribed module; stop() drains them all. */
  private readonly pollers: EventPoller[] = [];

  constructor(opts: ChainEventListenerOptions) {
    this.client = opts.client;
    this.packageId = opts.packageId;
    this.logger = opts.logger;
    this.dataDir = opts.dataDir ?? process.env.DATA_DIR ?? '.';
  }

  /**
   * Subscribe to one Move module: construct an `EventPoller` for it with the
   * computed per-module cursor path and start it. The poller decodes via
   * `parsedJson` and calls our wrapping closure, which forwards each event to
   * `handler` tagged `{ replayed: false }` (always false in P1).
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
    await poller.start(async (event: SuiEvent) => {
      await handler(event, { replayed: false });
    });
  }

  /**
   * Whether the listener is shedding load (the ReplayGovernor tripped its cap).
   * P1 STUB — the governor lands in P2/P3, so this is always `false` here.
   */
  isDegraded(): boolean {
    return false;
  }

  /**
   * Stop every tracked poller, then forget them so a second `stop()` is a no-op
   * (each poller is stopped exactly once). `EventPoller.stop` is itself
   * idempotent, but draining the list keeps the call count tight and makes the
   * idempotency observable.
   */
  async stop(): Promise<void> {
    const count = this.pollers.length;
    for (const poller of this.pollers) {
      poller.stop();
    }
    this.pollers.length = 0;
    this.logger.info({ pollers: count }, 'ChainEventListener stopped');
  }
}
