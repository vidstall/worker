/**
 * Extracted "this relay is now primary for roomId" promotion logic + the
 * standby-side fast local ping loop that can trigger it (REQ-RO-006).
 *
 * Lives in its OWN module (not inline in index.ts) so it is unit-testable
 * WITHOUT importing index.ts's daemon-`main` side effects -- mirrors
 * reverse-announce-handler.ts's ReverseAnnounceDeps/makeOnReverseAnnounce
 * shape exactly. index.ts wires this factory's real collaborators in;
 * relay-promotion.test.ts runs the SAME factory against mocked deps.
 *
 * Two independent triggers converge on `promoteToPrimary`:
 *   (1) Layer B fast local promotion -- relay-heartbeat.ts's onStandbyReady,
 *       fired when THIS relay's own direct /healthz ping of the primary
 *       misses missThreshold times in a row (~3s at the default cadence),
 *       well ahead of the ~30s on-chain watcher cadence.
 *   (2) The on-chain RelayPromoted event (promote_relay /
 *       promote_relay_after_ejection / promote_relay_via_health_alert),
 *       handled by index.ts's room poller.
 * Idempotent by construction so firing from BOTH (the common case: (1) fires
 * first locally, (2) confirms on-chain moments later) is safe:
 * consumer.resume() on an already-resumed consumer is a no-op,
 * standbyPrewarmRooms.delete / standbyHeartbeats.delete on an absent key are
 * no-ops, and createRelayHeartbeat's own internal `fired` flag stops (1) from
 * calling this twice on its own. LOCAL data-plane action only -- no chain
 * transaction is submitted from here; chain state stays owned by cp-daemon's
 * watchers (relay-heartbeat-watcher.ts / room-health-sweep.ts).
 *
 * Requirements: REQ-RO-006
 */

import type { types as msTypes } from 'mediasoup';
import type { Logger } from '@dvconf/shared';
import type { RelayRole } from '@dvconf/inter-relay-client';
import { createRelayHeartbeat, type RelayHeartbeatController } from './relay-heartbeat.js';

/** Collaborators promoteToPrimary/startStandbyHeartbeat/stopStandbyHeartbeat
 *  orchestrate. Bound by index.ts to the real live objects (standbyWarmPipe,
 *  interRelayContext, probeLiveness, standbyPrewarmRooms, standbyHeartbeats)
 *  so the unit test can mock each independently. */
export interface PromotionDeps {
  /** Resolve this room's paused warm-pipe consumer, or null if none. */
  standbyWarmPipe: {
    currentPipeConsumer(roomId: string): msTypes.Consumer | null;
  };
  /** This relay's role for the rooms it serves (mutated in place). */
  interRelayContext: { role: RelayRole };
  /** The /api/probe response state's role field (mutated in place, mirrors
   *  interRelayContext.role for the RO-020 probe surface). */
  probeLiveness: { role: 'primary' | 'standby' | 'unknown' };
  /** Rooms this relay currently re-warms as standby (see index.ts's periodic
   *  re-warm sweep) -- cleared for a room once it's no longer standby. */
  standbyPrewarmRooms: Map<string, 'sfu' | 'mcu'>;
  /** One relay-heartbeat controller per room this relay is standby for. */
  standbyHeartbeats: Map<string, RelayHeartbeatController>;
  logger: Logger;
}

export interface PromotionHandlers {
  /** The shared "this relay is now primary for roomId" state transition. */
  promoteToPrimary(roomId: string): void;
  /** Start (or restart) this room's fast local ping loop against primaryUrl.
   *  No-op when primaryUrl is null (endpoint not yet resolvable from chain). */
  startStandbyHeartbeat(roomId: string, primaryUrl: string | null): void;
  /** Stop and remove this room's ping loop, if any. Safe no-op otherwise. */
  stopStandbyHeartbeat(roomId: string): void;
}

export function createPromotionHandlers(deps: PromotionDeps): PromotionHandlers {
  function promoteToPrimary(roomId: string): void {
    const consumer = deps.standbyWarmPipe.currentPipeConsumer(roomId);
    if (consumer && !consumer.closed && consumer.paused) {
      void consumer
        .resume()
        .catch((err) => deps.logger.error({ err, roomId }, 'promoteToPrimary: consumer.resume() failed'));
    }
    deps.interRelayContext.role = 'primary';
    deps.probeLiveness.role = 'primary';
    deps.standbyPrewarmRooms.delete(roomId); // no longer standby — stop the re-warm sweep for it
    stopStandbyHeartbeat(roomId);
  }

  function startStandbyHeartbeat(roomId: string, primaryUrl: string | null): void {
    stopStandbyHeartbeat(roomId);
    if (primaryUrl !== null) {
      const hb = createRelayHeartbeat(roomId, primaryUrl, promoteToPrimary);
      hb.start();
      deps.standbyHeartbeats.set(roomId, hb);
    }
  }

  function stopStandbyHeartbeat(roomId: string): void {
    deps.standbyHeartbeats.get(roomId)?.stop();
    deps.standbyHeartbeats.delete(roomId);
  }

  return { promoteToPrimary, startStandbyHeartbeat, stopStandbyHeartbeat };
}
