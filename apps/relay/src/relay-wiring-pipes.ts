/**
 * DVConf Relay Daemon — inter-relay pipe coordinator wiring.
 *
 * Pure extraction from relay-wiring-context.ts: the registry/socket state,
 * the standby warm-pipe coordinator, the primary pipe coordinator, the
 * standby link manager, and fanToTreeNeighbors (T-B tree fan-out). These are
 * mutually referential with `InterRelayContext` (built by the caller AFTER
 * this wiring runs), so `interRelayContextRef` is a late-bound box — mirrors
 * the `signalingRef` pattern already used across this wiring: nothing here
 * calls into it before the caller finishes constructing InterRelayContext
 * and sets `.current`.
 */

import type { Logger, InMemoryRelayEndpointCache } from '@dvconf/shared';
import type { types as msTypes } from 'mediasoup';
import {
  InterRelayProducerRegistry,
  createInterRelayAnnouncer,
  createWsInterRelaySender,
  StandbyWarmPipeCoordinator,
  PrimaryPipeCoordinator,
  handleInboundInterRelayFrame,
  buildPipeConnectFrame,
  DEFAULT_PEER_RELAY_ID,
  openInterRelayLink,
  createStandbyLinkManager,
  parsePipePortRange,
  createPipePortAllocator,
  type InterRelaySocketLike,
} from '@dvconf/inter-relay-client';
import type { InterRelayContext } from './signaling/index.js';
import { createInterRelaySocketMap } from './inter-relay-socket-map.js';
import { ensureRelayProbe } from './room-handler.js';
import { resolveRelayEndpoint } from './relay-endpoint-resolver.js';
import { computeTreeFanPlan, type TreePosition } from './tree-position.js';
import { INTER_RELAY_TOKEN, RMS_ACTIVE_FORWARD, RMS_TREE_ACTIVE, type SignalingRef } from './relay-wiring-context.js';

export interface PipeWiringParams {
  logger: Logger;
  endpointUrl: string;
  signalingRef: SignalingRef;
  standbyLink: { primaryUrl: string | null };
  roomTreePosition: Map<string, TreePosition>;
  relayEndpointCacheRef: { current: InMemoryRelayEndpointCache | null };
  /** Set by the caller once InterRelayContext is fully constructed. */
  interRelayContextRef: { current: InterRelayContext | null };
}

export interface PipeWiring {
  interRelayRegistry: InterRelayProducerRegistry;
  interRelayLink: { socket: InterRelaySocketLike | null };
  interRelaySockets: ReturnType<typeof createInterRelaySocketMap>;
  standbyWarmPipe: StandbyWarmPipeCoordinator;
  primaryPipe: PrimaryPipeCoordinator;
  pipePortAllocator: ReturnType<typeof createPipePortAllocator>;
  standbyLinkManager: ReturnType<typeof createStandbyLinkManager>;
  interRelayPeerId: string | undefined;
  sendToPeer: (p: string | undefined, data: string) => void;
  pushAnnounce: ReturnType<typeof createInterRelayAnnouncer>;
  /**
   * T-B (REQ-RMS-042/043/044): re-forward a producer along THIS node's tree edges, edge-scoped +
   * hop-guarded, in BOTH directions. The relayId→URL translation (B2 id-space bridge) happens
   * here, where the endpoint cache + tree position + both legs are in scope.
   */
  fanToTreeNeighbors: (
    roomId: string,
    router: msTypes.Router,
    producer: msTypes.Producer,
    producerPeerId: string | undefined,
    originProducerId: string,
    receiveEdgeUrl: string | null,
    inboundHopTtl: number | undefined,
  ) => void;
}

export function buildPipeWiring(params: PipeWiringParams): PipeWiring {
  const { logger, endpointUrl, signalingRef, standbyLink, roomTreePosition, relayEndpointCacheRef, interRelayContextRef } = params;

  const interRelayRegistry = new InterRelayProducerRegistry();
  /**
   * G1/G3.2b: the LIVE accepted standby socket on the PRIMARY. Held in a mutable
   * box and read by the WS sender on every announce. Set by the signaling
   * server's `attachPeerSocket` callback when a tagged inter-relay peer (the
   * standby's authenticated link) connects; reset to null on its close. Until a
   * socket is attached the sender drops best-effort (no throw). Single
   * per-daemon box (per-room keying is the carry-forward — see standbyLink).
   */
  const interRelayLink: { socket: InterRelaySocketLike | null } = { socket: null };
  /**
   * REQ-RMS-028 (L1.3-b, Bridge A) — the per-peer inter-relay socket map, OWNED
   * here and SHARED into createSignalingServer (its tagged-peer attach writes
   * cascade legs into it). The PRIMARY reads it to route per-peer announce/param
   * sends: `socketFor` resolves a cascade peerRelayId to its own live socket, and
   * the DEFAULT peer (undefined / DEFAULT_PEER_RELAY_ID) to the legacy
   * interRelayLink.socket so the single-standby path stays byte-identical.
   */
  const interRelaySockets = createInterRelaySocketMap();
  const socketFor = (p?: string): InterRelaySocketLike | null =>
    p && p !== DEFAULT_PEER_RELAY_ID ? interRelaySockets.get(p) : interRelayLink.socket;
  const sendToPeer = (p: string | undefined, data: string): void => {
    try {
      // REUSE the OPEN/null-guarded WS sender per-peer (drops best-effort).
      createWsInterRelaySender(() => socketFor(p), logger).send(data);
    } catch {
      /* OPEN/null guarded by the sender; a momentary link-down must not throw. */
    }
  };
  /**
   * Outbound inter-relay link sink — now a REAL transmitter (was a no-op log
   * stub that never put bytes on the wire). When a standby socket is attached
   * and OPEN, the announce frame is actually sent; otherwise dropped best-effort.
   */
  const interRelaySender = createWsInterRelaySender(() => interRelayLink.socket, logger);

  /**
   * T-B (REQ-RMS-042/043/044): re-forward a producer along THIS node's tree edges, edge-scoped +
   * hop-guarded, in BOTH directions. The relayId→URL translation (B2 id-space bridge) happens
   * here, where the endpoint cache + tree position + both legs are in scope.
   *   receiveEdgeUrl = the peer URL the producer arrived on; null for a local-origin produce.
   *   inboundHopTtl  = the INBOUND budget (undefined at a local origin → seeded from pos.diameter).
   *
   * NOTE (T4/Task 6): the helper is DEFINED + bound here but NOT yet wired to any fan site — the
   * three fan sites (handleProduce forward, onLocalProducer, reverse) route through it in Task 7.
   * Bound on interRelayContext only when RMS_TREE_ACTIVE (undefined otherwise → byte-stable).
   */
  function fanToTreeNeighbors(
    roomId: string,
    router: msTypes.Router,
    producer: msTypes.Producer,
    producerPeerId: string | undefined,
    originProducerId: string,
    receiveEdgeUrl: string | null,
    inboundHopTtl: number | undefined,
  ): void {
    if (!RMS_TREE_ACTIVE) return;
    const pos = roomTreePosition.get(roomId);
    if (!pos) return;
    // Compute the tree-position-driven fan PLAN (pure + unit-tested — computeTreeFanPlan /
    // tree-forwarding.test.ts): the post-transition hop budget + edge-scoped DOWN child URLs +
    // the (optional) UP parent URL. ROOT → parentUrl null (DOWN only); INTERNAL → both legs; LEAF →
    // childUrls empty (UP only) — this is the §3.3 uniform, role-independent fan. M-2: the hop-guard
    // lives in ONE place — computeTreeFanPlan returns an EMPTY plan (childUrls [], parentUrl null)
    // when hop <= 0, so the loop + UP-branch below no-op naturally (no redundant `plan.hop <= 0`
    // guard here). Local clients were already fanned by the caller regardless.
    const resolve = (id: string) =>
      resolveRelayEndpoint(relayEndpointCacheRef.current!, id);
    const plan = computeTreeFanPlan(pos, receiveEdgeUrl, inboundHopTtl, resolve);
    // DOWN to children (via the shipped primary pipe primitive).
    for (const childUrl of plan.childUrls) {
      interRelayContextRef.current?.onPrimaryProducer?.(roomId, router, producer, childUrl, producerPeerId, plan.hop, originProducerId);
    }
    // UP to the parent (via the shipped reverse announcer) — a single up-link (null = root /
    // unresolved / arrived-from-parent edge-scope).
    if (plan.parentUrl !== null) {
      interRelayContextRef.current?.onStandbyProducer?.(roomId, router, producer, producerPeerId, plan.hop, originProducerId);
    }
  }

  /**
   * STANDBY warm-pipe coordinator (BENCH-2 / G1). Resolves the primary's real
   * producerId from the announce registry on first peer join + drives the
   * not-ready re-run on announce arrival. The standby's signaling layer hands
   * it the room topology/router at the bench; instantiated here so the wiring
   * owns a single coordinator backed by the shared registry.
   */
  const standbyWarmPipe = new StandbyWarmPipeCoordinator(
    interRelayRegistry,
    logger,
    // REQ-RMS-027: a standby minted a LOCAL forwarded producer → fan it to this
    // relay's OWN local clients. Bind to the ORIGINAL publisher (producerPeerId)
    // when the announce carried it, else the cascade peerRelayId.
    // REQ-RMS-034: pass RAW producerPeerId + peerRelayId — the publisher-binding
    // `??` resolution now lives INSIDE fanLocalProducer (behavior-neutral for the
    // shipped forward leg; C1 later replaces it with the E2EE gate).
    (roomId, producer, producerPeerId, peerRelayId, originProducerId, inboundHopTtl) => {
      signalingRef.fanLocalProducer?.(roomId, producerPeerId, producer, peerRelayId);
      // T-B (REQ-RMS-042/043/044) — INTERNAL-node received-DOWN re-forward (the dual role). The
      // standby coordinator just minted a FRESH local producer from its PARENT's pipe; re-forward
      // it DOWN this node's tree edges via fanToTreeNeighbors. peerRelayId is the edge (URL) it
      // arrived on = the PARENT link, so the helper edge-scopes it (fans to CHILDREN only, never
      // echoes back UP the parent). origin id = the IMMUTABLE origin off the announce (NOT
      // producer.id — Task 5 mints a fresh local id per hop); router from getRoom (NOT a fabricated
      // producer.appData.router); inboundHopTtl decrements + the helper's `<= 0` guard terminates a
      // leaf / exhausted budget. Flag OFF → return before any tree work (shipped star path
      // byte-identical: this is exactly the prior single fanLocalProducer call).
      if (!RMS_TREE_ACTIVE) return;
      const room = signalingRef.getRoom?.(roomId);
      if (!room) return;
      // M-3 observability — this producer was minted from the PARENT's pipe (cross-relay), so a
      // MISSING originProducerId is a THREADING GAP (not a real local origin): the fallback to
      // producer.id (the fresh per-hop mint) mislabels the origin → per-room dedup degrades. WARN as
      // an anomaly (fires ~never once the announce carries originProducerId end-to-end).
      if (originProducerId === undefined) {
        logger.warn(
          { roomId, mintedId: producer.id, peerRelayId },
          'T-B: internal re-forward missing originProducerId — threading gap, dedup may degrade',
        );
      }
      fanToTreeNeighbors(
        roomId, room.router, producer, producerPeerId,
        originProducerId ?? producer.id, peerRelayId, inboundHopTtl,
      );
    },
    // L1.4: opt in to active-forward only in mesh mode (RMS_ACTIVE_FORWARD='1').
    // Default false preserves the REQ-RO-005 paused-keepalive BW saving for M1 /
    // relay-overlap 2-relay failover rooms where the flag is not set.
    RMS_ACTIVE_FORWARD,
    // T6 (REQ-RMS-046): cascade-tree data plane — fresh local id per hop + per-room
    // origin dedup. Default false (flag off) → the shipped star mint stays byte-stable.
    RMS_TREE_ACTIVE,
    // Lane-B t_hop_network sampler (REQ-WLM-08). BENCH_LATENCY unset → probe is null
    // → undefined passed → zero-cost no-op inside the coordinator (byte-identical).
    // When enabled: starts a roundTripTime interval poller on the freshly-minted piped
    // producer (RECEIVER/inbound-rtp stat, empirically verified). `endpointUrl` is this
    // relay's stable unique identity (used as peerRelayId for the outbound link as well).
    (() => {
      const _benchProbe = ensureRelayProbe(logger);
      if (_benchProbe === null) return undefined;
      const _localRelayId = endpointUrl;
      return (producer: import('mediasoup').types.Producer, fromRelayId: string): (() => void) =>
        _benchProbe.startRtpStreamSampler(producer, { fromRelay: fromRelayId, toRelay: _localRelayId });
    })(),
  );

  // ── G3.2b: live cross-daemon inter-relay LINK glue ───────────────────────
  // isMainModule wiring that assembles the unit-tested pieces: openInterRelayLink
  // (the live dial), createStandbyLinkManager (the dedup/reconnect state machine),
  // handleInboundInterRelayFrame (inbound routing), StandbyWarmPipeCoordinator,
  // the signaling-side attach/dispatch gate. PIPE_PORT_RANGE.min is the standby
  // pipe port for the single-room demo; multi-room port allocation + per-room link
  // keying are the documented carry-forward (single-box interRelayLink/standbyLink).
  const pipePortRange = parsePipePortRange(process.env['PIPE_PORT_RANGE']);
  // F1 (REQ-RO-009): per-(room, role) PIPE_PORT allocator over [min..max].
  // Idempotent per key (preserves the N3 re-run invariant); released on room
  // close. Replaces the single hardcoded pipePortRange.min (EADDRINUSE for >1
  // room). Keyed `${roomId}` (standby) + `${roomId}:primary` (primary) so a
  // same-host primary+standby pair never collide. Mesh carry-forward (§12): the
  // key generalizes to per-(roomId, peerRelayId) additively.
  const pipePortAllocator = createPipePortAllocator(pipePortRange);
  const reconnectMs = parseInt(process.env['INTER_RELAY_RECONNECT_MS'] ?? '3000', 10);

  // C6 (REQ-RMS-008): this standby's DISTINCT inter-relay peer id, tagged on the
  // outbound link so the primary buckets ≥2 standbys (the live K_r≥2 mesh) each
  // under their own peerRelayId instead of colliding on DEFAULT_PEER_RELAY_ID
  // (the displaced standby would then mint 0 — the live C6 root cause). We reuse
  // endpointUrl — already this relay's stable, unique identity (standbyEndpoint
  // below) — so no extra chain read is needed; the peerRelayId is an opaque
  // routing/keying token (socket map + registry meshKey), never compared to an
  // on-chain miner_id. GATED on the active-forward mesh flag: when OFF (M1 /
  // relay-overlap failover) we send NO peer id → the primary resolves DEFAULT →
  // that path is byte-stable. The SAME value keys ensure() below so the
  // primary-echoed announce re-run matches the warm-pipe state it recorded.
  const interRelayPeerId = RMS_ACTIVE_FORWARD ? endpointUrl : undefined;

  // The standby's outbound link lifecycle (dedup + reconnect) lives in the
  // unit-tested createStandbyLinkManager; index.ts only supplies the live socket
  // factory (openInterRelayLink) + the inbound-frame → registry/cutover routing.
  const standbyLinkManager = createStandbyLinkManager({
    open: (url) =>
      openInterRelayLink({
        url,
        ...(INTER_RELAY_TOKEN ? { token: INTER_RELAY_TOKEN } : {}),
        ...(interRelayPeerId ? { peerRelayId: interRelayPeerId } : {}),
        onFrame: (raw) =>
          handleInboundInterRelayFrame(raw, {
            registry: interRelayRegistry,
            // C6 (REQ-RMS-008): thread the frame's cascade peerRelayId into the
            // coordinator re-run so it keys the SAME (room, peer) warm-pipe
            // state ensure() recorded (undefined/legacy frame → DEFAULT).
            onAnnounce: (roomId, peerRelayId) => {
              void standbyWarmPipe.onAnnounce(roomId, undefined, undefined, undefined, peerRelayId);
            },
            // F1 (REQ-RO-003/008): the primary's DOWN pipe-connect reply.
            // Feed its {ip,port} into the standby's already-bound PipeTransport
            // so the link is connect()'d BEFORE the announce arrives (the
            // coordinator drains pending producers once both ends connect).
            // C6 part-2: thread the echoed peerRelayId → connect the SAME
            // per-(room,peer) warm-pipe leg ensure() bound (undefined → DEFAULT).
            onConnectParams: (roomId, params, peerRelayId) => {
              void standbyWarmPipe.onPrimaryConnectParams(roomId, params, peerRelayId);
            },
            logger,
          }),
        logger,
      }),
    reconnectMs,
    // REQ-RMS-037 (D3, static-mesh-hardening): on link RE-open, re-deliver reverse
    // announces that were silently dropped during the down window. First-open is
    // back-filled by the A2 reversePending drain -- never resend there. Defensive: the
    // manager already guards this callback against throws; we also isolate per-room so
    // one bad room does not skip the rest.
    onOpen: (url, isReopen) => {
      if (!isReopen) return;
      for (const roomId of standbyWarmPipe.roomsWithStoredAnnounces()) {
        try {
          standbyWarmPipe.resendReverseAnnounces(roomId);
        } catch (err) {
          logger.warn({ err, roomId }, 'REQ-RMS-037: resend-on-reopen failed for room (isolated)');
        }
      }
      logger.info({ url }, 'REQ-RMS-037: link reopen -- stored reverse announces re-delivered');
    },
    logger,
  });

  /** Primary-side producer announcer (unit-tested factory). */
  const pushAnnounce = createInterRelayAnnouncer(interRelaySender);
  // F1 (REQ-RO-001/002/008): the PRIMARY half driver. Mints + connects the
  // primary PipeTransport, pipes the room's real producer onto it, and announces
  // the PIPED consumer id (NOT producer.id) via pushAnnounce. Holds per-room
  // {pipeTransport|null, connected, pendingProducers[], standbyParams|null} and
  // drains pendingProducers once the standby's connect params arrive — tolerates
  // either arrival order (producer-first or params-first). All logic is in the
  // factory; index.ts only injects the announcer + port allocator + the
  // standby->primary param sender (the link's new send() path).
  const primaryPipe = new PrimaryPipeCoordinator({
    // The coordinator's announcer dep + createInterRelayAnnouncer's closure now share
    // the SAME arg order (roomId, producer, producerPeerId?, peerRelayId?, rtpParameters?),
    // so the adapter forwards each slot 1:1.
    //   • producerPeerId (REQ-RMS-029): the drain threads the ORIGINAL publisher's
    //     peerId on the CASCADE/mesh path so a cross-relay consume binds the stream/
    //     E2EE-key to the real publisher (not the cascade relayId). The publisher
    //     peerId travels ALONGSIDE the piped consumer id; it is undefined on the
    //     DEFAULT/legacy single-standby leg → that part of the frame stays byte-stable.
    //   • peerRelayId (REQ-RMS-008) is DEFAULT-gated in drain (DEFAULT → undefined) →
    //     omitted on the legacy/default path → that part of the frame stays byte-stable.
    //   • rtpParameters (REQ-RMS-026) is supplied UNCONDITIONALLY by drain (a real
    //     Consumer always has it) → the live single-standby (DEFAULT) frame intentionally
    //     NOW carries it (additive — a standby that ignores it still parses via the
    //     unchanged guard); it is NOT byte-identical to the pre-REQ-RMS-026 frame.
    //     Builder-level byte-identity holds only when the 5th arg is OMITTED (the
    //     in-process announceProducer path below, which passes no rtpParameters).
    // REQ-RMS-028 (L1.3-b): route the cascade announce to the RIGHT per-peer
    // socket via sendToPeer (DEFAULT peer → the legacy interRelayLink.socket).
    // REUSE createInterRelayAnnouncer to build the locked frame (producerPeerId +
    // peerRelayId + rtpParameters) and hand its bytes to sendToPeer.
    // T-B (REQ-RMS-044/046): thread the trailing loop-guard budget + immutable origin so a
    // tree DOWN announce carries them. Undefined on the shipped forward path → the builder
    // omits both → byte-identical frame.
    announcer: (roomId, producer, producerPeerId, peerRelayId, rtpParameters, hopTtl, originProducerId) =>
      createInterRelayAnnouncer({ send: (data) => sendToPeer(peerRelayId, data) })(
        roomId,
        producer,
        producerPeerId,
        peerRelayId,
        rtpParameters,
        hopTtl,
        originProducerId,
      ),
    portAllocator: pipePortAllocator,
    // REQ-RMS-028 (L1.3-b): the DOWN pipe-connect reply routes to the SAME
    // per-peer socket (C contract is (roomId, params[, peerRelayId])).
    // C6 part-2: carry peerRelayId BACK on the reply frame so the standby
    // connect()s the SAME leg (sendToPeer already routes by it). The DEFAULT
    // sentinel is mapped to undefined so the legacy single-standby reply frame
    // stays byte-identical (omits the field) — only a real cascade peer carries it.
    paramSender: (roomId, params, peerRelayId) =>
      sendToPeer(
        peerRelayId,
        JSON.stringify(
          buildPipeConnectFrame(
            roomId,
            params,
            peerRelayId === DEFAULT_PEER_RELAY_ID ? undefined : peerRelayId,
          ),
        ),
      ),
    // REQ-RMS-037 (Task B4a): close the A6 double-race fan tail. When BOTH the
    // reverse leg AND the standby params were absent at announce time the handler
    // QUEUES the announce (reverseMint -> null) so its immediate
    // registerReverseMinted never ran. drainReverseMints (run by ensureReverseLeg
    // on a later reverse announce / inter-relay peer attach -- its SOLE caller; the
    // forward onStandbyConnectParams/onProducer drain only the FORWARD queue) now
    // fires onReverseMinted per drained mint -> registerReverseMinted fans it to
    // local clients + hub-fans DOWN, threading the ORIGINAL publisher's
    // producerPeerId carried on the queue entry.
    // T-B (REQ-RMS-043/044/046, T7 I-1): thread the IMMUTABLE origin + inbound hop budget the drain
    // carried off the queued announce, so the DRAIN Path B feeds the tree hub-fan the SAME origin +
    // budget the immediate path does — NOT minted.id / a reseeded full diameter. Undefined on a pre-
    // tree drain → registerReverseMinted's flag-off flood path is byte-stable.
    onReverseMinted: (roomId, minted, originRelayId, producerPeerId, originProducerId, inboundHopTtl) =>
      signalingRef.registerReverseMinted?.(roomId, minted, originRelayId, producerPeerId, originProducerId, inboundHopTtl),
    // T6 (REQ-RMS-046): cascade-tree reverse hub mint uses a fresh local id per hop.
    // Default false (flag off) → the shipped same-id reverse mint stays byte-stable.
    treeActive: RMS_TREE_ACTIVE,
    logger,
  });

  // standbyLink is currently used only inside onStandbyRoomReady (built by the
  // caller); referencing it here keeps the param plumbed for that closure's
  // benefit without an unused-var lint hit if a future edit inlines it here.
  void standbyLink;

  return {
    interRelayRegistry,
    interRelayLink,
    interRelaySockets,
    standbyWarmPipe,
    primaryPipe,
    pipePortAllocator,
    standbyLinkManager,
    interRelayPeerId,
    sendToPeer,
    pushAnnounce,
    fanToTreeNeighbors,
  };
}
