/**
 * DVConf Relay Daemon — wiring context assembly.
 *
 * Pure extraction from index.ts: env flags, the mutable state boxes shared
 * across the inter-relay wiring, and the InterRelayContext construction.
 * TURN context lives in relay-wiring-turn.ts; the pipe coordinators
 * (standbyWarmPipe/primaryPipe/standbyLinkManager/fanToTreeNeighbors) live in
 * relay-wiring-pipes.ts — both are assembled here into the single
 * `buildRelayWiring()` entry point index.ts calls. See index.ts for the call
 * sequence; this module has no side effects other than reading process.env
 * at module load (mirrors the original file).
 */

import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Logger, InMemoryRelayEndpointCache } from '@dvconf/shared';
import type { types as msTypes } from 'mediasoup';
import {
  type InterRelayProducerRegistry,
  type StandbyWarmPipeCoordinator,
  type PrimaryPipeCoordinator,
  type InterRelaySocketLike,
  type PipeConnectParams,
  type RoomTopology,
  type createStandbyLinkManager,
  type createPipePortAllocator,
} from '@dvconf/inter-relay-client';
import { buildPipeConnectFrame } from '@dvconf/inter-relay-client';
import type { TurnContext, InterRelayContext } from './signaling/index.js';
import { createInterRelaySocketMap } from './inter-relay-socket-map.js';
import type { TreePosition } from './tree-position.js';
import type { RelayHeartbeatController } from './relay-heartbeat.js';
import { makeOnReverseAnnounce } from './reverse-announce-handler.js';
import { buildTurnContext } from './relay-wiring-turn.js';
import { buildPipeWiring } from './relay-wiring-pipes.js';

// ── Env flags ────────────────────────────────────────────────────────────
/** G3.2b: Bearer token the standby presents on the inter-relay link (and the
 *  primary's signaling server validates). Undefined → single-host / unauthed. */
export const INTER_RELAY_TOKEN = process.env['INTER_RELAY_TOKEN'];
// RMS M4 L1: mesh-mode active-forward gate. Default OFF preserves the REQ-RO-005
// paused-keepalive (M1 / relay-overlap 2-relay failover) bandwidth saving; set to '1'
// in mesh mode (the run-rms-live-local demo sets it alongside cp-daemon RMS_KR_MIN>1).
export const RMS_ACTIVE_FORWARD = process.env['RMS_ACTIVE_FORWARD'] === '1';
// Cascade-tree (T-B) flags. Default OFF → the shipped flat-STAR data-plane is untouched
// (byte-stable). RMS_TREE_ACTIVE gates deriving+storing each room's tree position and
// re-targeting the inter-relay dial from slot-0 to the tree PARENT (N1). RMS_TREE_DEGREE
// is the B1 SHAPING degree (D = min(shapingDegree, live-capacity-cap)); RMS_TREE_MAX_HEIGHT
// is the diameter bound H (REQ-RMS-041).
export const RMS_TREE_ACTIVE = process.env['RMS_TREE_ACTIVE'] === '1';
// NaN-guard: a malformed operator value must fall back to the numeric default, never NaN —
// deriveTree would index ids[NaN] and throw inside the RoomAssigned poller callback.
export const RMS_TREE_MAX_HEIGHT = ((n) => (Number.isFinite(n) ? n : 3))(parseInt(process.env['RMS_TREE_MAX_HEIGHT'] ?? '3', 10));
export const RMS_TREE_DEGREE = ((n) => (Number.isFinite(n) ? n : 2))(parseInt(process.env['RMS_TREE_DEGREE'] ?? '2', 10)); // B1 shaping degree

/**
 * Late-bound handle to the signaling layer's fanLocalProducer/getRoom/
 * registerReverseMinted/reannounceLocalProducersUp. interRelayContext (and
 * standbyWarmPipe) are built BEFORE createSignalingServer returns, and
 * onLocalProducer is a readonly ctor param with no setter, so we box the fns
 * and index.ts assigns them once the server starts. The callbacks only fire
 * after the server is live, so the box is always set in time (mirrors the
 * post-construction interRelayContext.role mutation).
 */
export interface SignalingRef {
  fanLocalProducer:
    | ((
        roomId: string,
        producerPeerId: string | undefined,
        producer: msTypes.Producer,
        peerRelayId?: string,
      ) => void)
    | null;
  getRoom?: (roomId: string) => import('./room-handler.js').RoomState | undefined;
  registerReverseMinted?: (
    roomId: string,
    minted: msTypes.Producer,
    originRelayId: string,
    producerPeerId?: string,
    // T-B (REQ-RMS-043/044/046) — immutable origin + inbound hop budget for the tree hub-fan.
    originProducerId?: string,
    inboundHopTtl?: number,
  ) => void;
  // REQ-RMS-037 (Task B4b): STANDBY re-announce-on-reopen — back-fill local
  // producers UP after an outbound-link flap (late-bound like the rest).
  reannounceLocalProducersUp?: (roomId: string) => void;
}

export interface RelayWiring {
  turnContext: TurnContext | undefined;
  interRelayContext: InterRelayContext;
  signalingRef: SignalingRef;
  standbyWarmPipe: StandbyWarmPipeCoordinator;
  primaryPipe: PrimaryPipeCoordinator;
  interRelayRegistry: InterRelayProducerRegistry;
  interRelayLink: { socket: InterRelaySocketLike | null };
  standbyLink: { primaryUrl: string | null };
  roomTreePosition: Map<string, TreePosition>;
  roomAssignedRelays: Map<string, string[]>;
  standbyHeartbeats: Map<string, RelayHeartbeatController>;
  interRelaySockets: ReturnType<typeof createInterRelaySocketMap>;
  standbyLinkManager: ReturnType<typeof createStandbyLinkManager>;
  pipePortAllocator: ReturnType<typeof createPipePortAllocator>;
  interRelayPeerId: string | undefined;
  /** Filled in by index.ts once relayEndpointCache is constructed (Step 6.5,
   *  after this wiring runs). fanToTreeNeighbors only reads it at call time
   *  (room events, well after Step 6.5), so the box is always set in time. */
  relayEndpointCacheRef: { current: InMemoryRelayEndpointCache | null };
}

export interface RelayWiringParams {
  logger: Logger;
  endpointUrl: string;
  signer: Pick<Ed25519Keypair, 'toSuiAddress'>;
}

/**
 * Assemble the G1/G3.2b inter-relay coordination context: the registry is
 * shared; role + links are populated lazily by the RoomAssigned poller once
 * this relay learns its role + the paired relay's endpoint. The standby OPENS
 * a live WS link to the primary (G3.2b openStandbyLink) to receive
 * `pipe-producer` announces; the primary pushes announces over the accepted
 * socket (attachPeerSocket → interRelayLink.socket).
 *
 * NOTE: this wiring is not unit-tested (mirrors the isMainModule guard in
 * index.ts) but the pieces it assembles ARE: the announce contract +
 * producerId resolution + auth tag/dispatch gate + inbound handler + link
 * dial (inter-relay*.test.ts, inter-relay-auth*.test.ts, inter-relay-link.test.ts).
 */
export function buildRelayWiring(params: RelayWiringParams): RelayWiring {
  const { logger, endpointUrl, signer } = params;

  // S30.C: TurnContext construction (relay-wiring-turn.ts).
  const turnContext = buildTurnContext({ logger, endpointUrl, signer });

  /**
   * G3.2a/b: the STANDBY's resolved PRIMARY endpoint URL. The RoomAssigned
   * poller resolves `relayIds[0]` → primaryUrl via the shared endpoint
   * cache and writes it here. G3.2b READS it in two places: the standby arm
   * dials the live inter-relay link (`openStandbyLink`), and `onStandbyRoomReady`
   * feeds it into `RoomTopology.primaryEndpoint`. `null` until a standby
   * assignment resolves (or while the primary's endpoint is not yet on chain).
   *
   * Single per-DAEMON box (mirrors `interRelayLink`), not per-room. A relay that
   * is primary for room A AND standby for room B at once needs per-room keying
   * (Map<roomId, url>) so the live dial does not pick up a stale primary across
   * role/room transitions — the documented G3.2b carry-forward (single-room K=2
   * demo scope holds today).
   */
  const standbyLink: { primaryUrl: string | null } = { primaryUrl: null };
  // T-B: this relay's tree position per room, derived on RoomAssigned (RMS_TREE_ACTIVE).
  // Read by the tree-active dial (resolveTreeParentDial → tree PARENT) and, later, fanToTreeNeighbors.
  const roomTreePosition = new Map<string, TreePosition>();
  // Mid-call standby-swap (relay_replacement.move): the last-known assigned_relays vector
  // per room, recorded on RoomAssigned and kept current on RelaySlotReplaced (dead id swapped
  // for new id) — needed so a RelaySlotReplaced handler can resolve the primary's endpoint the
  // same way RoomAssigned does, without an extra chain read.
  const roomAssignedRelays = new Map<string, string[]>();
  /**
   * REQ-RO-006 (Layer B fast local promotion) — one relay-heartbeat controller
   * per room this relay is currently STANDBY for. Started whenever this relay
   * resolves a primary to ping (RoomAssigned/RelaySlotReplaced standby
   * branches), stopped on promotion (either via this fast local path or
   * the on-chain RelayPromoted event — see promoteToPrimary), on ejection, or
   * on room teardown (releaseRoom below). Single-room K=2 demo scope, same as
   * standbyLink above.
   */
  const standbyHeartbeats = new Map<string, RelayHeartbeatController>();
  // REQ-RMS-027 (L1.3-b, Bridge B) — late-bound handle to the signaling layer's
  // fanLocalProducer. interRelayContext (and standbyWarmPipe) are built
  // BEFORE createSignalingServer returns, and onLocalProducer is a readonly ctor
  // param with no setter, so we box the fn and assign it once the server starts.
  // The callback only fires after the server is live, so the box is always set
  // in time (mirrors the post-construction interRelayContext.role mutation).
  const signalingRef: SignalingRef = { fanLocalProducer: null };

  const relayEndpointCacheRef: { current: InMemoryRelayEndpointCache | null } = { current: null };

  // interRelayContext is built below, AFTER the pipe wiring (fanToTreeNeighbors
  // needs to call interRelayContext.onPrimaryProducer/onStandbyProducer). This
  // late-bound box breaks that cycle: buildPipeWiring's closures only read
  // `.current` at CALL time (room events, well after construction finishes).
  const interRelayContextRef: { current: InterRelayContext | null } = { current: null };

  const pipes = buildPipeWiring({
    logger,
    endpointUrl,
    signalingRef,
    standbyLink,
    roomTreePosition,
    relayEndpointCacheRef,
    interRelayContextRef,
  });
  const {
    interRelayRegistry,
    interRelayLink,
    interRelaySockets,
    standbyWarmPipe,
    primaryPipe,
    pipePortAllocator,
    standbyLinkManager,
    interRelayPeerId,
    pushAnnounce,
    fanToTreeNeighbors,
  } = pipes;

  const interRelayContext: InterRelayContext = {
    // Default to 'primary'; corrected per-room by the RoomAssigned poller.
    role: 'primary',
    registry: interRelayRegistry,
    announceProducer: (roomId, producer, producerPeerId) => {
      pushAnnounce(roomId, producer, producerPeerId);
    },
    // G3.2b PRIMARY: the signaling server hands us the accepted standby socket
    // (tagged inter-relay) so the announce sender transmits over it; null on detach.
    attachPeerSocket: (socket) => {
      interRelayLink.socket = socket;
    },
    // REQ-RMS-037 (part-3 reverse leg, Task B4b) PRIMARY: on a newly-attached
    // inter-relay peer, eagerly ensure its reverse pipe leg exists (so a pure-
    // reverse room forms its leg before the first reverse announce). DRY — the
    // SAME primaryPipe.ensureReverseLeg already used by makeOnReverseAnnounce below.
    ensureReverseLeg: (roomId, router, peerRelayId) =>
      primaryPipe.ensureReverseLeg(roomId, router, peerRelayId),
    // F1 (REQ-RO-001/002/008) PRIMARY: a real producer was created for a room
    // this relay is primary for. Hand it to the coordinator, which mints+connects
    // the primary pipe (port from the allocator, key `${roomId}:primary`), pipes
    // the producer, and announces the PIPED consumer id. Drains immediately if
    // the standby's connect params already arrived, else queues (pending).
    // REQ-RMS-028 (L1.3-b): forward the cascade peerRelayId so the coordinator
    // mints a per-peer pipe leg (DEFAULT/undefined → the legacy single leg).
    // REQ-RMS-029: also forward the ORIGINAL publisher's producerPeerId so the
    // coordinator drain threads it into the cascade announce.
    // T-B (REQ-RMS-044/046): thread the trailing loop-guard budget + immutable origin into the
    // coordinator so a tree DOWN fan carries them into the announce. Undefined on the shipped
    // flat-STAR fanout (handleProduce) → byte-stable frame.
    onPrimaryProducer: (roomId, router, producer, peerRelayId, producerPeerId, hopTtl, originProducerId) =>
      void primaryPipe.onProducer(roomId, router, producer, peerRelayId, producerPeerId, hopTtl, originProducerId),
    // REQ-RMS-034 (part-3 reverse leg) STANDBY: a standby-homed LOCAL client
    // produced. Consume it onto the warm pipe UP toward the primary + announce UP
    // (the reverse dual of onPrimaryProducer). Key under THIS standby's own
    // interRelayPeerId (same value tagged on the outbound link + ensure()).
    // T-B (REQ-RMS-044/046): thread the trailing loop-guard budget + immutable origin so a tree
    // UP fan carries them onto the reverse announce UP. Undefined on the shipped local-client
    // reverse path (handleProduce) → byte-stable frame.
    onStandbyProducer: (roomId, router, producer, producerPeerId, hopTtl, originProducerId) => {
      void standbyWarmPipe.onLocalClientProducer(
        roomId,
        router,
        producer,
        producerPeerId,
        interRelayPeerId,
        hopTtl,
        originProducerId,
      );
    },
    // REQ-RMS-034/035/037 (part-3 reverse leg) PRIMARY: a reverse announce arrived
    // from a standby's local client. The handler (EXTRACTED to reverse-announce-
    // handler.ts so it is unit-testable without index.ts's main side effects)
    // ensures+drains the reverse leg FIRST, then mints a LOCAL hub copy and seeds +
    // fans it via registerReverseMinted. Fail-safe: a missing room or absent
    // rtpParameters is a no-op; only a truthy mint is registered. peerRelayId
    // undefined (legacy) -> DEFAULT (single-leg). getRoom/registerReverseMinted are
    // bound through the signalingRef box so they return undefined / no-op before the
    // signaling server is live (preserving pre-server-live safety).
    onReverseAnnounce: makeOnReverseAnnounce({
      ensureReverseLeg: (roomId, router, peerRelayId) =>
        primaryPipe.ensureReverseLeg(roomId, router, peerRelayId),
      reverseMint: (roomId, router, announced, peerRelayId) =>
        primaryPipe.reverseMint(roomId, router, announced, peerRelayId),
      getRoom: (roomId) => signalingRef.getRoom?.(roomId),
      // T-B (REQ-RMS-043/044/046): thread the immutable origin + inbound hop budget the handler
      // read off the reverse announce into the tree hub-fan (undefined on a pre-tree frame).
      registerReverseMinted: (roomId, minted, originRelayId, producerPeerId, originProducerId, inboundHopTtl) =>
        signalingRef.registerReverseMinted?.(roomId, minted, originRelayId, producerPeerId, originProducerId, inboundHopTtl),
    }),
    // F1 (REQ-RO-003/008): the standby's UP pipe-connect frame, delivered through
    // the SAME interRelayPeers token gate as pipe-producer announces. PRIMARY
    // feeds it to the coordinator, which binds + connect()s the primary pipe to
    // these params, then replies DOWN with its own tuple (paramSender) and drains
    // any pending producers.
    // C6 part-2: thread the standby's peerRelayId → connect the SAME per-(room,peer)
    // producer pipe leg the cascade onPrimaryProducer minted (undefined → DEFAULT).
    // WAN PRODUCER-FIRST fix: also thread the room ROUTER (via signalingRef.getRoom
    // — same accessor onReverseAnnounce/onLocalProducer use) so the coordinator can
    // mint the forward pipe HERE when the all-local producer arrived first and is
    // queued. getRoom is late-bound (undefined pre-server-live) → the coordinator
    // falls back to the record-only path, byte-stable.
    onConnectParams: (roomId, params, peerRelayId) => {
      const router = signalingRef.getRoom?.(roomId)?.router;
      void primaryPipe.onStandbyConnectParams(roomId, params, peerRelayId, router);
    },
    // G3.2b STANDBY: on the first peer join for a standby room, build the room's
    // topology + open the paused warm pipe in the LIVE signaling path. F1: the
    // pipe port is now ALLOCATED per room (REQ-RO-009) instead of the single
    // hardcoded min, and the standby announces its bound {ip,port} UP to the
    // primary over the link's new send() path so both ends connect() before RTP.
    onStandbyRoomReady: (roomId, router) => {
      const pipePort = pipePortAllocator.allocate(roomId);
      const topology: RoomTopology = {
        roomId,
        role: 'standby',
        primaryEndpoint: standbyLink.primaryUrl ?? '',
        standbyEndpoint: endpointUrl,
        pipePort,
        pipeConsumer: null,
        pipeTransport: null,
      };
      void standbyWarmPipe
        // C6 (REQ-RMS-008): key the warm-pipe state under this standby's OWN
        // peerRelayId (same value tagged on the outbound link) so the primary-
        // echoed announce re-run (onAnnounce above) finds this state instead of
        // missing under DEFAULT. undefined (non-mesh) → DEFAULT — byte-stable.
        .ensure(topology, router, pipePort, interRelayPeerId)
        .then(() => {
          // F1 (REQ-RO-003): announce the standby's bound {ip,port} UP to the
          // primary so it can connect() its end. ANNOUNCED_IP default 127.0.0.1
          // (single-host/localnet scope, design §9.5; enableSrtp:false). Best-
          // effort: send() is OPEN-guarded — dropped if the link is not yet up
          // (the standby re-announces on reconnect; the coordinator re-drives).
          const ip = process.env['ANNOUNCED_IP'] ?? '127.0.0.1';
          const params: PipeConnectParams = { ip, port: pipePort };
          // C6 part-2: tag the UP pipe-connect with this standby's OWN peerRelayId
          // (same value as the link header + ensure() key) so the primary binds the
          // RIGHT per-(room,peer) leg. undefined (non-mesh) → frame omits it → DEFAULT.
          standbyLinkManager.send(JSON.stringify(buildPipeConnectFrame(roomId, params, interRelayPeerId)));
        })
        .catch((err) => logger.error({ err, roomId }, 'G3.2b: standby warm-pipe ensure failed'));
    },
    // F1 (REQ-RO-009): room teardown — release the standby pipe port and drop
    // both coordinator states, so a reused roomId starts fresh and the port
    // range does not leak. Routed through the context (mirrors registry.clear)
    // so signaling.ts stays decoupled from the allocator/coordinator handles.
    //
    // REQ-RMS-008: the `${roomId}:primary` slot is released by
    // primaryPipe.clear(roomId) itself — its DEFAULT-peer primaryPortKey
    // degrades to exactly `${roomId}:primary` (inter-relay.ts:78-82), and clear
    // releases that key (inter-relay.ts:1061, proven by
    // inter-relay-primary-coordinator.test.ts:240 + warmpipe-rtp integration
    // :714). So PrimaryPipeCoordinator is the SOLE owner of that slot's
    // lifecycle — we no longer double-release it here, avoiding two owners of one
    // key as the M2 cascade lands real per-peer primary legs.
    releaseRoom: (roomId) => {
      pipePortAllocator.release(roomId);
      // B6b (REQ-RMS-036): clearRoom drops EVERY (room, peer) leg across all
      // peerRelayId buckets, not just DEFAULT. `clear(roomId)` left the cascade
      // legs (states + reverse dedup/pending maps) alive -> stale state on a reused
      // roomId. clearRoom still tears down the DEFAULT leg (so the `${roomId}:primary`
      // slot release is preserved) and additionally every cascade leg.
      primaryPipe.clearRoom(roomId);
      standbyWarmPipe.clearRoom(roomId);
      // REQ-RO-006: stop this room's fast-promotion ping loop, if any — a
      // reused roomId must not resume pinging a now-stale primaryUrl.
      // Bridges to createPromotionHandlers' stopStandbyHeartbeat, which index.ts
      // assembles AFTER this wiring returns (mirrors the signalingRef late-
      // binding pattern already used in this file) — index.ts MUST set
      // `.current` before any room can be released.
      stopStandbyHeartbeatBox.current?.(roomId);
    },
  };

  // Now that interRelayContext exists, unblock fanToTreeNeighbors' calls into
  // it (see interRelayContextRef above).
  interRelayContextRef.current = interRelayContext;

  // T-B: bind the tree fan + the tree-active flag onto the signaling context so the fan sites
  // (Task 7) can route through them. Flag OFF → fanToTreeNeighbors undefined → the shipped
  // flat-STAR data plane is untouched (byte-stable).
  // ⚠️ OPERATIONAL CAUTION: RMS_TREE_ACTIVE is NOT live-safe until Task 7 wires the fan sites.
  // Enabling it at THIS commit yields a relay that dials its TREE PARENT (Task 4) + mints FRESH
  // per-hop ids (Task 5) but STILL fans media via the flat-STAR interRelaySockets.keys() flood
  // (nothing calls fanToTreeNeighbors yet) — a half-migrated data plane. Do NOT set it in a
  // live / multi-host environment until Task 7 routes the three fan sites through the helper.
  interRelayContext.fanToTreeNeighbors = RMS_TREE_ACTIVE ? fanToTreeNeighbors : undefined;
  interRelayContext.treeActive = RMS_TREE_ACTIVE;

  return {
    turnContext,
    interRelayContext,
    signalingRef,
    standbyWarmPipe,
    primaryPipe,
    interRelayRegistry,
    interRelayLink,
    standbyLink,
    roomTreePosition,
    roomAssignedRelays,
    standbyHeartbeats,
    interRelaySockets,
    standbyLinkManager,
    pipePortAllocator,
    interRelayPeerId,
    relayEndpointCacheRef,
  };
}

/**
 * Bridges `interRelayContext.releaseRoom` (built inside buildRelayWiring,
 * before createPromotionHandlers exists) to the real `stopStandbyHeartbeat`
 * function index.ts assembles afterward. index.ts MUST set `.current` before
 * any room can be released (mirrors the existing signalingRef late-binding
 * pattern already used in this file).
 */
export const stopStandbyHeartbeatBox: { current: ((roomId: string) => void) | null } = { current: null };
