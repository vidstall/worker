/**
 * DVConf Relay Daemon — room_manager_events poller handler.
 *
 * Pure extraction from index.ts Step 7: RoomAssigned / RelayPromoted /
 * RelaySlotReplaced handling for the roomPoller EventPoller. index.ts
 * constructs the EventPoller and calls `roomPoller.start(createRoomEventHandler(deps))`.
 */

import type { Logger, InMemoryRelayEndpointCache } from '@dvconf/shared';
import { determineRole, type RoomTopology } from '@dvconf/inter-relay-client';
import type { InterRelayContext } from './signaling/index.js';
import type { ProbeState } from './metrics-server.js';
import { resolvePrimaryEndpoint, resolveTreeParentDial } from './relay-endpoint-resolver.js';
import { deriveTreePosition, type TreePosition } from './tree-position.js';
import { RMS_TREE_ACTIVE, RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT } from './relay-wiring-context.js';

// RoomTopology is imported only for its role in typings elsewhere; referenced
// here to keep the module's public surface self-describing (unused import
// guards would otherwise flag it — used indirectly via standbyLinkManager.connectTo).
export type { RoomTopology };

export interface RoomEventHandlerDeps {
  myMinerId: string;
  interRelayContext: InterRelayContext;
  probeLiveness: ProbeState;
  roomTreePosition: Map<string, TreePosition>;
  roomAssignedRelays: Map<string, string[]>;
  relayEndpointCacheRef: { current: InMemoryRelayEndpointCache | null };
  standbyLink: { primaryUrl: string | null };
  standbyLinkManager: { connectTo: (url: string) => void };
  standbyPrewarmRooms: Map<string, 'sfu' | 'mcu'>;
  prewarmRoom: (roomId: string, mode: 'sfu' | 'mcu') => Promise<void>;
  startStandbyHeartbeat: (roomId: string, primaryUrl: string | null) => void;
  stopStandbyHeartbeat: (roomId: string) => void;
  promoteToPrimary: (roomId: string) => void;
  logger: Logger;
}

/**
 * Builds the room_manager_events handler passed to `roomPoller.start(...)`.
 * module is 'room_manager_events' (NOT 'room_manager') -- RoomAssigned
 * etc. are defined in the companion room_manager_events module
 * (LOC-budget split, room_manager/events.move); events are pinned to
 * whichever module FIRST DEFINED the struct -- confirmed via live
 * GraphQL introspection against a real create_room tx.
 */
export function createRoomEventHandler(
  deps: RoomEventHandlerDeps,
): (event: { type: string; parsedJson: unknown }) => Promise<void> {
  const {
    myMinerId,
    interRelayContext,
    probeLiveness,
    roomTreePosition,
    roomAssignedRelays,
    relayEndpointCacheRef,
    standbyLink,
    standbyLinkManager,
    standbyPrewarmRooms,
    prewarmRoom,
    startStandbyHeartbeat,
    stopStandbyHeartbeat,
    promoteToPrimary,
    logger,
  } = deps;

  return async (event) => {
    const eventName = event.type.split('::').pop() ?? '';
    if (eventName === 'RoomAssigned') {
      const data = event.parsedJson as Record<string, unknown>;
      const relayIds = data['relay_ids'] as string[] | undefined;
      const relayMode = data['relay_mode'] as number | undefined;
      const roomId = data['room_id'] as string | undefined;
      if (relayIds && roomId) {
        roomAssignedRelays.set(roomId, relayIds);
      }
      if (relayIds && relayIds.includes(myMinerId)) {
        // G1: determine this relay's role for the room (primary = relay_ids[0],
        // standby = [1..]; reads .length, never hardcodes 2). Drives the
        // inter-relay producer-announce direction.
        let role: 'primary' | 'standby' = 'primary';
        try {
          role = determineRole(relayIds, myMinerId);
        } catch (err) {
          logger.warn({ err, roomId, relayIds }, 'G1: could not determine relay role for room');
        }
        interRelayContext.role = role;
        // RO-020: reflect the live role on the /api/probe state box.
        probeLiveness.role = role;

        // T-B (REQ-RMS-042): derive + store THIS relay's deterministic tree position for
        // the room (same tree every assigned relay derives). Flag-gated (RMS_TREE_ACTIVE,
        // default OFF) so the shipped flat-STAR path is byte-identical. No forwarding change
        // here — the tree-aware fan is a later task; this only records position + re-targets
        // the dial. The dial is now a PURE function of tree position (I1): the tree root is the
        // sorted-min canonical id, which need NOT equal chain slot-0 (survives promote_relay /
        // unsorted relay_ids) — so the dial below does not gate on role === 'primary'.
        if (RMS_TREE_ACTIVE && roomId) {
          // TODO(T-B capacity task): compute a capacityCap via deriveDegreeCap(RMS_C_WORKER_PATHS, uLocal, producersPerPeer) and pass it as deriveTreePosition's 5th arg. Omitted now → shape governs (B1).
          const pos = deriveTreePosition(relayIds, myMinerId, RMS_TREE_DEGREE, RMS_TREE_MAX_HEIGHT);
          roomTreePosition.set(roomId, pos);
          if (!pos.withinDiameterBound) {
            logger.warn({ roomId, K: relayIds.length, maxHeight: RMS_TREE_MAX_HEIGHT },
              'T-B: tree exceeds maxHeight — over capacity for the height bound (defer-and-flag, REQ-RMS-041)');
          }
          logger.info({ roomId, role: pos.role, parent: pos.parent, children: pos.children, diameter: pos.diameter },
            'T-B: derived tree position for room');
        }

        if (RMS_TREE_ACTIVE && roomId) {
          // T-B (I1 / N1): under the tree the inter-relay DIAL is a PURE function of tree position,
          // NOT the chain slot-0 role. The tree root (sorted-min canonical id) diverges from chain
          // slot-0 after promote_relay or when relay_ids arrives unsorted (deriveTree is order-
          // independent by design), so gating the dial on role==='primary' would leave a non-root
          // chain-primary never dialing its tree parent. Every node with a parent dials it (child->
          // parent live link); the true tree root (pos.parent===null) dials nobody = accept-only.
          // The WS accept path is unchanged (a node accepts its children's dials automatically).
          // TODO(T-C): the pure dial (resolveTreeParentDial) IS unit-covered RED-on-revert — relay-endpoint-resolver.test.ts pins the non-root chain-primary → tree-parent + root → nobody cases (incl. non-sorted relay_ids). This HANDLER wiring — that THIS RoomAssigned poller runs the dial for a non-root chain-primary, not re-gated on role==='primary' — is REVIEW-ONLY (Task 9's tree-multihop I1 test asserts it as a function COMPOSITION, NOT the booted poller); a RED-on-revert guard on the live handler needs a daemon boot and is a T-C obligation.
          const pos = roomTreePosition.get(roomId);
          const dialUrl = resolveTreeParentDial(pos, relayEndpointCacheRef.current!);
          standbyLink.primaryUrl = dialUrl;
          if (dialUrl !== null) standbyLinkManager.connectTo(dialUrl);
          logger.info(
            { roomId, relayMode, role, treeRole: pos?.role ?? 'unknown', dialUrl, resolved: dialUrl !== null },
            dialUrl !== null
              ? 'T-B: relay opened live inter-relay link to its TREE PARENT'
              : 'T-B: relay is the TREE ROOT (or parent endpoint not yet resolvable) — accept-only, no dial',
          );
        } else if (role === 'primary') {
          // F1: PRIMARY for this room. The live pipe is driven at the produce
          // event (interRelayContext.onPrimaryProducer → PrimaryPipeCoordinator):
          // it mints+connects the primary pipe, pipes the producer, and announces
          // the PIPED consumer id over the accepted standby socket. No work here
          // beyond recording the role.
          if (roomId) {
            standbyPrewarmRooms.delete(roomId); // no longer standby — stop the re-warm sweep for it
            stopStandbyHeartbeat(roomId); // REQ-RO-006: stop any stale ping loop from a prior standby stint
          }
          logger.info({ roomId, relayMode, role }, 'G1: relay is PRIMARY for room');
        } else {
          // STANDBY: resolve the primary's WS endpoint so the inter-relay link
          // can be opened to it. G3.2a (HERE): resolve relayIds[0] -> primaryUrl
          // from the shared endpoint cache (populated by subscribeRelayEndpoints,
          // Step 6.5) and stash it for the live socket open. G3.2b (bench/live):
          // `new WebSocket(primaryUrl)` + feed inbound `pipe-producer` frames
          // into the signaling server's handler. BENCH-2: on first peer join the
          // standby calls standbyWarmPipe.ensure(topology, router, pipePort)
          // (resolves the real producerId, else placeholder) and on each inbound
          // announce standbyWarmPipe.onAnnounce(roomId) re-runs the warm pipe with
          // the real id. The record + resolve + re-run contract is unit-tested
          // (inter-relay-warmpipe.test.ts); resolvePrimaryEndpoint is unit-tested
          // (relay-endpoint-resolver.test.ts).
          const primaryUrl = resolvePrimaryEndpoint(relayEndpointCacheRef.current!, relayIds);
          standbyLink.primaryUrl = primaryUrl;
          // G3.2b: OPEN the live inter-relay link to the primary. The primary
          // pushes pipe-producer announces down it; each cuts the warm pipe over
          // to the real producerId. The paused warm pipe is opened on first peer
          // join (onStandbyRoomReady). Skipped until the URL resolves from chain.
          if (primaryUrl !== null) standbyLinkManager.connectTo(primaryUrl);
          logger.info(
            { roomId, relayMode, role, primaryUrl, resolved: primaryUrl !== null },
            primaryUrl !== null
              ? 'G3.2b: relay is STANDBY for room — opened live inter-relay link to primary'
              : 'G1: relay is STANDBY for room — primary endpoint not yet resolvable from cache (chain not yet observed); retries on next assignment',
          );

          // Pre-warm standby: create this room's Router (and open the warm
          // pipe, onStandbyRoomReady) NOW instead of waiting for the first
          // real peer join, so failover promotion is a fast reconnect, not
          // a cold start. Fire-and-forget (roomId is already known-good at
          // this point); failures are logged, not fatal to the poller.
          // Tracked in standbyPrewarmRooms so the periodic sweep above
          // self-heals a missed one-time warm-up.
          if (roomId) {
            const prewarmMode: 'sfu' | 'mcu' = relayMode === 1 ? 'mcu' : 'sfu';
            standbyPrewarmRooms.set(roomId, prewarmMode);
            void prewarmRoom(roomId, prewarmMode).catch((err) => {
              logger.error({ err, roomId }, 'Standby pre-warm: Router pre-creation failed');
            });

            // REQ-RO-006 (Layer B): ping the primary directly so a genuinely
            // dead primary is caught locally in ~3s instead of waiting on the
            // ~30s on-chain watcher cadence — see promoteToPrimary. Restart
            // fresh on every re-pairing so a stale heartbeat against an old
            // primaryUrl never lingers.
            startStandbyHeartbeat(roomId, primaryUrl);
          }
        }

        if (relayMode === 1) {
          logger.info(
            { roomId, relayMode },
            'MCU pipeline initialized for room — composite output mode',
          );
        } else {
          logger.info(
            { roomId, relayMode },
            'SFU room assigned — individual stream forwarding',
          );
        }
      }
    } else if (eventName === 'RelayPromoted') {
      // Pre-warm standby correctness gap: this relay's local role
      // (interRelayContext.role) was set ONCE at pairing time by the
      // RoomAssigned branch above and never updated again. promote_relay /
      // promote_relay_after_ejection / promote_relay_via_health_alert all
      // emit RelayPromoted (same room_manager_events module this poller
      // already watches) instead of RoomAssigned, so without this branch a
      // promoted standby's Router exists (pre-warmed, good) but its
      // producer/consumer role wiring stays stale. If THIS relay is the
      // new_primary, flip role in memory immediately — no re-pairing
      // needed, the Router was already created by the pre-warm above.
      const data = event.parsedJson as Record<string, unknown>;
      const roomId = data['room_id'] as string | undefined;
      const newPrimary = data['new_primary'] as string | undefined;
      if (roomId && newPrimary === myMinerId) {
        // REQ-RO-006: routed through the SAME promoteToPrimary the fast local
        // ping-based path uses, so this is a harmless no-op if that path
        // already fired for this room (idempotent — see promoteToPrimary's
        // doc) — and, unlike the role-flip-only behavior this replaced, it
        // now ALSO resumes the paused warm-pipe consumer, which nothing
        // previously did for a promotion confirmed only on-chain.
        promoteToPrimary(roomId);
        logger.info({ roomId, newPrimary }, 'RelayPromoted: this relay is now PRIMARY for room (role flipped in memory)');
      }
    } else if (eventName === 'RelaySlotReplaced') {
      // Mid-call standby-swap (relay_replacement.move) — CP-quorum voted a fresh candidate
      // in for a dead STANDBY (never index 0/primary, that's RelayPromoted's event above).
      // Two relays care about this event, mutually exclusive:
      //   - new_relay_id === myMinerId: this relay just became a standby for the room --
      //     treat exactly like the RoomAssigned standby branch (pre-warm + open the inter-
      //     relay link to the primary), reusing the same resolvePrimaryEndpoint/prewarmRoom.
      //   - dead_relay_id === myMinerId: this relay was EJECTED from the room -- stop its
      //     re-warm sweep (it no longer serves this room at all).
      const data = event.parsedJson as Record<string, unknown>;
      const roomId = data['room_id'] as string | undefined;
      const deadRelayId = data['dead_relay_id'] as string | undefined;
      const newRelayId = data['new_relay_id'] as string | undefined;
      if (!roomId) {
        // no-op: malformed event
      } else if (newRelayId === myMinerId) {
        const priorRelayIds = roomAssignedRelays.get(roomId) ?? [];
        const updatedRelayIds = priorRelayIds.map((id) => (id === deadRelayId ? newRelayId : id));
        roomAssignedRelays.set(roomId, updatedRelayIds);

        interRelayContext.role = 'standby';
        probeLiveness.role = 'standby';

        const primaryUrl = resolvePrimaryEndpoint(relayEndpointCacheRef.current!, updatedRelayIds);
        standbyLink.primaryUrl = primaryUrl;
        if (primaryUrl !== null) standbyLinkManager.connectTo(primaryUrl);
        logger.info(
          { roomId, deadRelayId, newRelayId, primaryUrl, resolved: primaryUrl !== null },
          'RelaySlotReplaced: this relay is the newly voted-in STANDBY for room',
        );

        // Pre-warm — same fire-and-forget contract as the RoomAssigned standby branch.
        const prewarmMode: 'sfu' | 'mcu' = 'sfu'; // relay_mode isn't carried on this event; sfu is the pre-warm default (mcu re-warms via the periodic sweep once the room's real mode is observed)
        standbyPrewarmRooms.set(roomId, prewarmMode);
        void prewarmRoom(roomId, prewarmMode).catch((err) => {
          logger.error({ err, roomId }, 'RelaySlotReplaced: standby pre-warm failed');
        });

        // REQ-RO-006 — same fast local ping loop as the RoomAssigned standby
        // branch, against the freshly-resolved primaryUrl for this swap.
        startStandbyHeartbeat(roomId, primaryUrl);
      } else if (deadRelayId === myMinerId) {
        standbyPrewarmRooms.delete(roomId); // ejected from this room — stop the re-warm sweep
        stopStandbyHeartbeat(roomId); // REQ-RO-006: no longer serving this room at all
        logger.info({ roomId, deadRelayId }, 'RelaySlotReplaced: this relay was ejected from room (dead standby replaced)');
      }
    }
  };
}
