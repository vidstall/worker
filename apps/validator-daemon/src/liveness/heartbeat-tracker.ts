/**
 * Liveness sweep -- heartbeat tracking.
 *
 * STALENESS: VALIDATOR-ATTESTED, not on-chain-provable. `cast_liveness_vote` no
 * longer gates on the target's on-chain last_heartbeat/epoch — epoch granularity
 * floors at the network's real epoch length (e.g. 1 HOUR on devnet), which cannot
 * express a sub-hour SLA like "5 minutes no response". Instead this module tracks
 * each node's most recent heartbeat EVENT (RelayHeartbeat / CPHeartbeat /
 * ValidatorHeartbeat), which carries a REAL wall-clock timestamp
 * (unlike the on-chain epoch field), via four EventPoller subscriptions.
 *
 * Extracted from the former `liveness-sweep.ts` monolith.
 */

import { join } from 'node:path';
import type { SuiGraphQLClient } from '@mysten/sui/graphql';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { EventPoller, type NetworkConfig, type Logger } from '@dvconf/shared';

/** Base dir for these cursors -- DATA_DIR (mirrors ChainEventListener's own
 *  default), NOT process.cwd(), so a container recreate (redeploy) doesn't
 *  force a full event-history replay from genesis. */
export const cursorDir = (name: string): string => join(process.env.DATA_DIR ?? '.', '.cursors', name);

/** module name -> the heartbeat event's own `::TypeName` suffix, for filtering. */
const HEARTBEAT_EVENT_MODULES: ReadonlyArray<{ module: string; eventSuffix: string }> = [
  { module: 'relay_registry', eventSuffix: '::RelayHeartbeat' },
  { module: 'control_plane_registry', eventSuffix: '::CPHeartbeat' },
  { module: 'validator_registry', eventSuffix: '::ValidatorHeartbeat' },
];

/**
 * Tracks each miner's most-recently-OBSERVED heartbeat event, in real wall-clock
 * time (`event.timestampMs`, not the on-chain epoch the event also carries) — the
 * mechanism the "5 minutes no response" SLA is actually measured against. Backed
 * by four EventPollers (one per role), each with its own cursor file; on a fresh
 * boot with no cursor, EventPoller replays full history from genesis, which
 * self-seeds `lastSeenMs` for every node's most recent heartbeat before this
 * process started watching live.
 */
export class HeartbeatTracker {
  private readonly lastSeenMs = new Map<string, number>();
  private readonly pollers: EventPoller[];

  constructor(graphqlClient: SuiGraphQLClient, config: NetworkConfig, pollIntervalMs: number, logger: Logger) {
    this.pollers = HEARTBEAT_EVENT_MODULES.map(
      ({ module, eventSuffix }) =>
        new EventPoller({
          client: graphqlClient,
          packageId: config.originalPackageId ?? config.packageId,
          module,
          pollingIntervalMs: pollIntervalMs,
          cursorPath: cursorDir(`liveness-${module}-heartbeat.json`),
          logger: logger.child({ poller: module }),
        }),
    );
    // Bind eventSuffix per poller for the handler below.
    this.pollers.forEach((poller, i) => {
      const { eventSuffix } = HEARTBEAT_EVENT_MODULES[i]!;
      void poller.start(async (event) => {
        if (!event.type?.endsWith(eventSuffix)) return;
        const parsed = event.parsedJson as { miner_id?: string } | undefined;
        if (!parsed?.miner_id) return;
        const minerId = normalizeSuiAddress(parsed.miner_id);
        const seenAtMs = Number(event.timestampMs ?? Date.now());
        const prev = this.lastSeenMs.get(minerId);
        if (prev === undefined || seenAtMs > prev) this.lastSeenMs.set(minerId, seenAtMs);
      });
    });
  }

  /**
   * Most recent real-time heartbeat-event timestamp for `minerId`, or `undefined`
   * if none has ever been observed (a freshly registered/never-heartbeated node,
   * or history not yet replayed) — callers should NOT treat "undefined" as stale.
   */
  lastSeen(minerId: string): number | undefined {
    return this.lastSeenMs.get(minerId);
  }

  /** First-observation default: called once per newly discovered, never-seen node. */
  seed(minerId: string, atMs: number): void {
    if (!this.lastSeenMs.has(minerId)) this.lastSeenMs.set(minerId, atMs);
  }

  stop(): void {
    for (const poller of this.pollers) poller.stop();
  }
}
