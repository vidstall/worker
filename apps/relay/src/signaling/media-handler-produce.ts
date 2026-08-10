/**
 * mediasoup produce signaling: handleProduce (SFU fan-out + inter-relay drive).
 *
 * Pure extraction from media-handler.ts. See that file's barrel re-export.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { Logger } from '@dvconf/shared';
import { notifyNewProducer } from '../room-handler.js';
import { shouldRecordPath } from '../inter-relay-socket-map.js';
import type { SpillTrigger } from '../spill-trigger.js';
import type { ProduceMessage } from './messages.js';
import { sendJson } from './helpers.js';
import type { SignalingServerState, InterRelayContext } from './state.js';

export async function handleProduce(
  state: SignalingServerState,
  ws: WebSocket,
  msg: ProduceMessage,
  interRelay: InterRelayContext | undefined,
  spillTrigger: SpillTrigger | undefined,
  logger: Logger,
): Promise<void> {
  const mapping = state.wsToRoom.get(ws);
  if (!mapping) return;

  const room = state.rooms.get(mapping.roomId);
  const peer = room?.peers.get(mapping.peerId);
  if (!room || !peer || !peer.sendTransport) {
    sendJson(ws, { type: 'error', message: 'No send transport' });
    return;
  }

  const producer = await peer.sendTransport.produce({
    kind: msg.kind,
    rtpParameters: msg.rtpParameters,
  });

  peer.producers.push(producer);

  // W5 M1 P5 (REQ-MCS-003): register AUDIO producers with the room's
  // AudioLevelObserver so it can surface the dominant speaker. Guarded on the
  // observer existing (undefined when attach failed / MCU). mediasoup auto-
  // detaches a producer from the observer when the producer closes (removePeer
  // → producer.close()), so no explicit removeProducer is required here; we
  // defensively removeProducer on the close event regardless.
  if (msg.kind === 'audio' && room.audioLevelObserver) {
    try {
      await room.audioLevelObserver.addProducer({ producerId: producer.id });
      producer.on('@close', () => {
        room.audioLevelObserver
          ?.removeProducer({ producerId: producer.id })
          .catch(() => {
            /* observer/producer already gone — auto-detached; ignore */
          });
      });
    } catch (err) {
      logger.warn(
        { roomId: mapping.roomId, producerId: producer.id, err: (err as Error).message },
        'AudioLevelObserver.addProducer failed — speaker detection skips this producer',
      );
    }
  }

  sendJson(ws, {
    type: 'produced',
    producerId: producer.id,
  });

  // Notify all other peers about the new producer (SFU fan-out)
  await notifyNewProducer(room, mapping.peerId, producer, logger);

  // REQ-RMS-006/008: record a forward path on the self-observed spill trigger so a
  // room that crosses the worker-path threshold fires a one-shot spill REQUEST.
  // Gated by the TESTED shouldRecordPath(spillTrigger) — true only when the trigger
  // was wired (RMS_C_WORKER_PATHS set), so the M1 single-room path (no trigger) is
  // byte-unchanged. A produce success is one new forward path for the room.
  if (shouldRecordPath(spillTrigger)) {
    spillTrigger!.recordPath(mapping.roomId);
  }

  // F1 (CONSISTENCY-FIX HIGH#2, REQ-RO-001/002) PRIMARY side — DRIVE the
  // PrimaryPipeCoordinator at the produce event (the ONLY place a real
  // producerId exists). It mints+connects the primary pipe, pipes the producer,
  // and announces the PIPED consumer id (NOT producer.id) via its own announcer
  // dep. This REPLACES the old direct announceProducer(producer.id) — keeping
  // both would double-announce (producer.id + the piped id). When onPrimaryProducer
  // is absent (in-process bench / no coordinator), fall back to the legacy direct
  // announce so the bench path is unaffected.
  if (interRelay?.treeActive && interRelay.fanToTreeNeighbors) {
    // UNIFORM (§3.3, T-B T7 follow-up — concern #1/#2) — ANY own local produce fans through the
    // single edge-scoped + hop-guarded helper to ALL tree neighbors (UP to parent + DOWN to
    // children), driven by TREE position (pos), INDEPENDENT of chain role. Closes two gaps the old
    // role-branched wiring left: (#1) an INTERNAL node's own produce now reaches its OWN subtree —
    // it was UP-only, and the root's reverse hub-fan EXCLUDES the origin edge, so R1's children never
    // saw R1's media; (#2) a tree ROOT that is a chain-STANDBY (I1: tree root = sorted-min id may
    // diverge from chain slot-0 after promote_relay / unsorted relay_ids) now fans DOWN correctly
    // instead of announcing UP to a non-existent parent. fanToTreeNeighbors reads pos → root
    // (parent=null) fans DOWN only; internal fans UP+DOWN; leaf (children=∅) fans UP only. Local-
    // origin produce → receiveEdgeUrl = null (fan ALL neighbors) + inboundHopTtl = undefined → the
    // helper SEEDS the budget from pos.diameter; originProducerId = this producer's id (an OWN
    // produce IS the origin). onPrimaryProducer/onStandbyProducer are daemon-level bindings (NOT
    // role-gated), so a chain-standby internal node drives BOTH legs = the intended dual-role
    // (§3.1/§3.2). Flag OFF → treeActive undefined → the two role branches below are byte-for-byte
    // the shipped path.
    interRelay.fanToTreeNeighbors(
      mapping.roomId, room.router, producer, mapping.peerId, producer.id, null, undefined,
    );
    logger.info(
      { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId, producerPeerId: mapping.peerId },
      'T-B: routed OWN-produce fan through fanToTreeNeighbors — uniform, tree-position-driven (tree active)',
    );
  } else if (interRelay && interRelay.role === 'primary') {
    if (interRelay.onPrimaryProducer) {
      // REQ-RMS-028 (L1.3-b, Bridge A) — N-1 mesh fanout. Fan onPrimaryProducer
      // to every attached inter-relay peer (interRelaySockets.keys()), each on
      // its own per-peer pipe leg. interRelaySockets is a PER-DAEMON map (keyed
      // by peerRelayId, populated when ANY tagged inter-relay peer connects), NOT
      // per-room. Under the single-room demo scope (RMS-live LOCAL) every attached
      // peer IS a cascade standby of this room, so this equals "this room's
      // standbys". MULTI-ROOM CARRY-FORWARD: a per-(room,peer) filter is needed
      // before multi-room — a peer that is a standby of room Y but not room X
      // would otherwise get an undrained pendingProducers entry per produce. With
      // NO cascade peer attached the keys are empty → ONE legacy 3-arg call (the
      // default single-standby leg, byte-identical to the pre-mesh path — the
      // primary-produce-drive test deletes INTER_RELAY_TOKEN, leaving an empty
      // map, and expects exactly that single 3-arg call).
      const peerIds = state.interRelaySockets.keys();
      if (peerIds.length === 0) {
        interRelay.onPrimaryProducer(mapping.roomId, room.router, producer);
      } else {
        for (const p of peerIds) {
          // REQ-RMS-029: thread the ORIGINAL publishing peer (mapping.peerId) on the
          // CASCADE leg so the coordinator drain records it on the announce (the
          // cross-relay consume then binds to the real publisher, not the relayId).
          interRelay.onPrimaryProducer(mapping.roomId, room.router, producer, p, mapping.peerId);
        }
      }
      logger.info(
        {
          producerId: producer.id,
          kind: producer.kind,
          roomId: mapping.roomId,
          producerPeerId: mapping.peerId,
          cascadePeers: peerIds.length,
        },
        'Inter-relay: drove PrimaryPipeCoordinator at produce (primary) — announces PIPED id',
      );
    } else {
      // Legacy in-process bench path (no coordinator wired): direct announce.
      interRelay.announceProducer(mapping.roomId, producer, mapping.peerId);
      logger.info(
        { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId },
        'Inter-relay: announced producer to standby (primary, legacy direct)',
      );
    }
  } else if (interRelay && interRelay.role === 'standby') {
    // REQ-RMS-034 (part-3 reverse leg) — announce this standby's LOCAL-client
    // producer UP to the primary. notifyNewProducer (above) already local-fanned it
    // to this standby's own clients; this adds the reverse hop so the primary mints
    // a hub copy and fans it everywhere (full bidirectional mesh, hub-via-primary).
    // Fires ONLY for a real local-client produce (handleProduce); a piped/minted
    // producer is created via produceLocalFromPipe and NEVER reaches handleProduce
    // — so this can never re-announce a hub-minted stream (loop-safe, REQ-RMS-036;
    // regression guard: inter-relay-warmpipe.test.ts RED-RB-2). producerPeerId
    // = the ORIGINAL local publisher (mapping.peerId) for stream/E2EE fidelity.
    // Gated on the hook being present (mirrors the primary onPrimaryProducer block):
    // until A4 wires it (and on the in-process bench) the hook is absent — without the
    // guard the "drove..." log would over-claim a reverse hop that never happened.
    // NOTE (T-B T7 follow-up): under the tree the OWN-produce fan is handled UNIFORMLY above
    // (treeActive branch → fanToTreeNeighbors, tree-position-driven). This role==='standby' branch
    // is therefore reached ONLY flag-off → it stays byte-for-byte the shipped UP-only announce.
    if (interRelay.onStandbyProducer) {
      interRelay.onStandbyProducer(mapping.roomId, room.router, producer, mapping.peerId);
      logger.info(
        { producerId: producer.id, kind: producer.kind, roomId: mapping.roomId, producerPeerId: mapping.peerId },
        'Inter-relay: drove reverse consume-onto-pipe at produce (standby) — announces UP to primary',
      );
    }
  }

  logger.info(
    { producerId: producer.id, kind: msg.kind, peerId: mapping.peerId, roomId: mapping.roomId },
    'Producer created',
  );
}
