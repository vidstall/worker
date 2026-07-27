/**
 * Mutable state + config/deps shapes for the mediasoup signaling server.
 *
 * Mirrors room-handler.ts's pattern: an explicit state interface + factory,
 * holding every mutable collection that used to be a closure variable inside
 * `createSignalingServer`. Every handler takes this state as its first
 * parameter instead of closing over it.
 *
 * Requirements: RELAY-05
 */

import type { WebSocket } from 'ws';
import type { types as msTypes } from 'mediasoup';
import type { RoomState } from '../room-handler.js';
import type { RoomConfig, AttemptRecord } from './helpers.js';
import {
  createInterRelaySocketMap,
  type InterRelaySocketMap,
} from '../inter-relay-socket-map.js';
import type {
  InterRelayProducerRegistry,
  InterRelaySocketLike,
  PipeConnectParams,
  RelayRole,
} from '@dvconf/inter-relay-client';
import type { MediasoupManager } from '../mediasoup-manager.js';
import type { MetricsTracker } from '../metrics.js';
import type { Logger } from '@dvconf/shared';

/**
 * S30.C — Optional TURN credential injection. When provided, the signaling
 * server calls `buildIceServers(peerId)` during createTransport and inlines
 * the result into the `transportCreated` response so mediasoup-client can
 * add TURN relay candidates. Returning null skips for that transport; the
 * server logs and degrades gracefully on errors (no TURN, baseline path).
 */
export interface TurnContext {
  buildIceServers(
    peerId: string,
  ): Promise<
    Array<{ urls: string | string[]; username?: string; credential?: string }> | null
  >;
}

/**
 * G1 inter-relay coordination context. When provided, the signaling server:
 *  - PRIMARY: after handleProduce, calls `announceProducer(roomId, producer)`
 *    to push a `pipe-producer` frame to the paired standby.
 *  - STANDBY: records inbound `pipe-producer` frames into `registry`, and
 *    resolves a client `consume` that omits producerId from room context.
 *
 * Injected by index.ts (the wiring layer) — kept optional + decoupled so the
 * baseline single-relay signaling path is unchanged (mirrors TurnContext).
 *
 * LIVE two-relay verification DEFERRED to bench (Phase 5.3).
 */
export interface InterRelayContext {
  /** This relay's role for the rooms it serves. */
  role: RelayRole;
  /** Standby-side registry of producers announced by the primary. */
  registry: InterRelayProducerRegistry;
  /**
   * Primary-side: push a producer announce to the paired standby.
   * The wiring layer holds the inter-relay WS link to the standby endpoint.
   */
  announceProducer(
    roomId: string,
    producer: Pick<msTypes.Producer, 'id' | 'kind'>,
    producerPeerId?: string,
  ): void;
  /**
   * G3.2b PRIMARY-side: the server accepted a TAGGED inter-relay peer (the
   * standby dialing in over the authenticated link). The wiring layer stores it
   * as the live `interRelayLink.socket` the announce sender transmits over;
   * `null` is passed when that peer disconnects (single-box detach). Optional —
   * absent on the in-process bench (which sets the socket directly).
   */
  attachPeerSocket?(socket: InterRelaySocketLike | null): void;
  /**
   * G3.2b STANDBY-side: fired ONCE on the first peer join for a room this relay
   * is standby for (room creation). The wiring layer builds the room's
   * RoomTopology + calls StandbyWarmPipeCoordinator.ensure() so the paused warm
   * pipe runs in the LIVE signaling path (M1 built ensureWarmPipe but never ran
   * it in production). Optional.
   */
  onStandbyRoomReady?(roomId: string, router: msTypes.Router): void;
  /**
   * REQ-RO-006 dispatch half — the server received an inter-relay pipe-connect
   * frame through the token gate. The wiring layer (PrimaryPipeCoordinator,
   * cluster C) binds + connect()s its PipeTransport to these params. Optional —
   * absent on the in-process bench. Params are the peer's {ip, port[, srtp]}.
   *
   * C6 part-2 (REQ-RMS-008): the THIRD arg is the standby's cascade peerRelayId
   * (carried on its UP pipe-connect frame). The wiring threads it to
   * `PrimaryPipeCoordinator.onStandbyConnectParams(.., peerRelayId)` so the primary
   * connect()s the SAME per-(room,peer) producer pipe leg the cascade minted —
   * undefined (legacy frame) → DEFAULT_PEER_RELAY_ID, single-standby byte-stable.
   */
  onConnectParams?(roomId: string, params: PipeConnectParams, peerRelayId?: string): void;
  /**
   * REQ-RO-001/002 (consumed by Tasks 5-6 + driven by Task 15) — the primary has a real producer to
   * pipe for a room it is primary for. The coordinator mints + connects the
   * primary PipeTransport, pipes the producer, and announces the PIPED consumer
   * id. Declared here (optional, unused by THIS cluster's routing) so the
   * coordinator can plug in without re-touching the context type.
   */
  onPrimaryProducer?(
    roomId: string,
    router: msTypes.Router,
    producer: msTypes.Producer,
    /**
     * REQ-RMS-028 (L1.3-b) — the cascade peer this leg targets. The signaling
     * fanout loop in handleProduce drives onPrimaryProducer ONCE PER attached
     * inter-relay peer (interRelaySockets.keys()), threading each peerRelayId so
     * the PrimaryPipeCoordinator mints a per-peer pipe leg. Omitted (single 3-arg
     * call) when no cascade peer is attached → the legacy single-standby path.
     */
    peerRelayId?: string,
    /**
     * REQ-RMS-029 — the ORIGINAL publishing peer (mapping.peerId). The fanout loop
     * threads it ONLY on the cascade leg so the coordinator drain records it on the
     * inter-relay announce → a cross-relay consume binds the stream/E2EE-key to the
     * real publisher, not the cascade relayId. Omitted on the legacy single-standby
     * (empty-keys) leg → byte-stable.
     */
    producerPeerId?: string,
    /**
     * T-B (REQ-RMS-044) — loop-guard hop budget. The tree DOWN-fan (fanToTreeNeighbors)
     * threads it so the coordinator carries it into the DOWN announce; omitted on the shipped
     * flat-STAR fanout (handleProduce) → byte-stable frame.
     */
    hopTtl?: number,
    /**
     * T-B (REQ-RMS-046) — the IMMUTABLE origin producerId, threaded unchanged across hops so a
     * receiving node dedups per-room on it (the per-hop local id differs under RMS_TREE_ACTIVE).
     * Omitted on the shipped path → byte-stable frame.
     */
    originProducerId?: string,
  ): void;
  /**
   * REQ-RMS-034 (part-3 reverse leg) — a STANDBY-homed local client produced. The
   * reverse-leg sibling of onPrimaryProducer?: the standby drives a reverse
   * consume-onto-pipe UP + announce-UP so the primary mints a hub copy and fans it
   * everywhere (full bidirectional mesh, hub-via-primary). Fired ONLY from
   * handleProduce (a real local-client produce) — a piped/minted producer is created
   * via produceLocalFromPipe and never reaches handleProduce, so this is loop-safe.
   * producerPeerId = the ORIGINAL local publisher (mapping.peerId), threaded so the
   * primary's reverse mint binds the stream/E2EE-key to the real publisher, not this
   * standby's relayId (REQ-RMS-038). Optional — absent on the in-process bench /
   * primary-only deployments, exactly as onPrimaryProducer? is guarded.
   */
  onStandbyProducer?(
    roomId: string,
    router: msTypes.Router,
    producer: msTypes.Producer,
    producerPeerId?: string,
    /**
     * T-B (REQ-RMS-044) — loop-guard hop budget carried UP the reverse leg by the tree UP-fan
     * (fanToTreeNeighbors). Omitted on the shipped local-client reverse path → byte-stable frame.
     */
    hopTtl?: number,
    /**
     * T-B (REQ-RMS-046) — the IMMUTABLE origin producerId, threaded unchanged UP so an internal
     * node preserves the per-room dedup key. Omitted on the shipped path → byte-stable frame.
     */
    originProducerId?: string,
  ): void;
  /** REQ-RMS-034/035 — the PRIMARY received a reverse announce from a standby's
   *  local client. Mint locally + fan + hub-fan. Async (does mediasoup produce). */
  onReverseAnnounce?(
    roomId: string,
    producerId: string,
    kind: msTypes.MediaKind,
    rtpParameters: msTypes.RtpParameters | undefined,
    peerRelayId: string | undefined,
    producerPeerId: string | undefined,
    /**
     * T-B (REQ-RMS-043/044/046) — the IMMUTABLE origin + loop-guard budget read off the inbound
     * reverse PipeProducerAnnounce and threaded into the tree hub-fan (registerReverseMinted →
     * fanToTreeNeighbors). Omitted on a pre-tree / star announce → the shipped hub-flood path.
     */
    originProducerId?: string,
    hopTtl?: number,
  ): Promise<void>;
  /**
   * REQ-RMS-037 (part-3 reverse leg, Task B4b) — eagerly ensure the PRIMARY's
   * reverse pipe leg for a NEWLY-attached inter-relay peer exists, even before
   * that peer's first reverse announce arrives (so a pure-reverse room — one whose
   * only media originates on the standby — still forms its leg). Driven from the
   * signaling attach seam ONCE per tagged-peer connect, alongside the re-fan of
   * existing producers DOWN to that peer. Optional / additive — absent on the
   * in-process bench (which never attaches a peer over the WS upgrade), exactly as
   * attachPeerSocket? / onPrimaryProducer? are guarded.
   */
  ensureReverseLeg?(roomId: string, router: msTypes.Router, peerRelayId: string): Promise<void>;
  /**
   * F1 (REQ-RO-009) — empty-room teardown. The wiring layer releases BOTH the
   * standby + primary pipe ports back to the allocator and drops the coordinator
   * state, so a reused roomId starts fresh and the [min..max] port range does not
   * leak. Routed through the context (mirrors registry.clearRoom) so signaling.ts stays
   * decoupled from the allocator/coordinator handles. Optional — absent on the
   * in-process bench (which builds an InterRelayContext without it), exactly as
   * attachPeerSocket? / onStandbyRoomReady? are guarded.
   */
  releaseRoom?(roomId: string): void;
  /**
   * T-B (REQ-RMS-042) — true when RMS_TREE_ACTIVE is set (cascade-tree data plane). The
   * signaling layer reads it to choose the tree-aware fan over the shipped flat-STAR fan.
   * Optional / additive — undefined (flag off / in-process bench) → the shipped STAR path.
   */
  treeActive?: boolean;
  /**
   * T-B (REQ-RMS-042/043/044) — re-forward a producer along THIS node's tree edges, edge-scoped
   * + hop-guarded, in BOTH directions (DOWN to children, UP to the parent). relayId→URL id-space
   * translation (B2 bridge) happens inside the wiring-layer implementation (index.ts). Bound only
   * when RMS_TREE_ACTIVE; undefined otherwise so the shipped path never calls it (byte-stable).
   *   receiveEdgeUrl  = the peer URL the producer arrived on (null for a local-origin produce).
   *   inboundHopTtl   = the INBOUND hop budget (undefined at a local origin → seeded from diameter).
   */
  fanToTreeNeighbors?: (
    roomId: string,
    router: msTypes.Router,
    producer: msTypes.Producer,
    producerPeerId: string | undefined,
    originProducerId: string,
    receiveEdgeUrl: string | null,
    inboundHopTtl: number | undefined,
  ) => void;
}

/**
 * Env-derived numeric/string config for the signaling server, computed once at
 * `createSignalingServer` call time. Threaded (never re-read from process.env)
 * into every handler that needs it.
 */
export interface SignalingConfig {
  relayMode: 'sfu' | 'mcu';
  audioObserverIntervalMs: number;
  audioObserverThresholdDb: number;
  audioLastNK: number;
  maxIncomingBitrate: number;
  passwordMaxAttempts: number;
  passwordWindowMs: number;
  interRelayToken: string;
}

/** Grouped external dependencies threaded through the signaling handlers. */
export interface SignalingDeps {
  manager: MediasoupManager;
  metrics: MetricsTracker;
  logger: Logger;
  config: SignalingConfig;
  turnContext?: TurnContext;
  interRelay?: InterRelayContext;
}

/**
 * All mutable state that used to be a closure variable declared inline inside
 * `createSignalingServer`. Every handler takes this object as its first
 * parameter (mirrors room-handler.ts's RoomState/PeerState pattern) instead of
 * closing over these collections.
 */
export interface SignalingServerState {
  rooms: Map<string, RoomState>;
  /**
   * REQ-RMS-036 (part-3 reverse leg) — per-room origin registry (producerId ->
   * origin info) for hub-fan exclusion + loop prevention (R-B reads it). Cleared
   * ROOM-WIDE on teardown (and per-producer on the minted producer's '@close').
   * REQ-RMS-037 (Task B4b): the value carries the LIVE minted Producer handle so a
   * newly-attached standby can be re-fanned the reverse-minted hub copies it missed
   * (the entry is removed on the producer's '@close', so the handle never goes stale).
   */
  originRegistry: Map<
    string,
    Map<
      string,
      { originRelayId: string; kind: msTypes.MediaKind; producerPeerId?: string; producer: msTypes.Producer }
    >
  >;
  /**
   * G-DEMO-9 (relay byte accounting) sampler bookkeeping: last observed
   * outbound-rtp byteCount per consumer.id, used to compute per-poll deltas.
   */
  consumerLastByteCount: Map<string, number>;
  /**
   * W5 M2 P1.0 (REQ-MCS-012, D-M2-18): per-room ADMISSION config (passwordHash),
   * co-located with `rooms`. Set by the first joiner (host); checked online for
   * every later joiner. NOT on-chain (D-M2-2). Cleaned when the room empties.
   */
  roomConfigs: Map<string, RoomConfig>;
  /**
   * W5 M2 P1.0 (REQ-MCS-012): per-roomId wrong-password attempt counters for the
   * brute-force rate-limiter. Cleaned when the room empties.
   */
  passwordAttempts: Map<string, AttemptRecord>;
  /** Track which room each WebSocket belongs to for cleanup. */
  wsToRoom: Map<WebSocket, { roomId: string; peerId: string }>;
  /** Per-room async lock for the "get or create" critical section in
   *  handleJoin. Without serialization, two peers arriving in the same
   *  Node tick both observe rooms.get(roomId) === undefined, both await
   *  manager.createRouter, both write rooms.set — second wins, the loser's
   *  Router is orphan and newProducer pushes never cross peers. Real fix
   *  for CI-18; replaces the 250 ms inter-join delay workaround in
   *  scripts/bench/mediasoup-client-harness.ts. */
  roomCreationLocks: Map<string, Promise<void>>;
  /**
   * F60 graceful shutdown (DOH-021): while draining we stop accepting NEW client
   * upgrades (setAccepting(false)). Inter-relay standby peers stay exempt so the
   * G3.2b warm-pipe link is not severed. Default true → normal operation unchanged.
   */
  accepting: boolean;
  /**
   * G3.2b: cross-daemon inter-relay auth. Tagged peers are attached as the
   * announce socket and are the only sockets allowed to inject pipe-producer
   * frames server-side.
   */
  interRelayPeers: WeakSet<WebSocket>;
  /** G3.2b: the LIVE single-box (default-peer) attached inter-relay socket. */
  attachedInterRelaySocket: WebSocket | null;
  /**
   * REQ-RMS-008: per-peer inter-relay socket map (multi-peer cascade). The single
   * attachedInterRelaySocket above stays for the DEFAULT (single-standby) peer; a
   * cascade peer attaches under its own x-inter-relay-peer-id so K_r links co-exist.
   * REQ-RMS-028 (L1.3-b): the wiring layer (index.ts) may PROVIDE this map so the
   * PRIMARY's per-peer send and this server's tagged-peer attach share one map;
   * absent ⇒ a fresh internal map (existing call sites/tests byte-unchanged).
   */
  interRelaySockets: InterRelaySocketMap;
}

/**
 * Construct a fresh SignalingServerState. `providedSockets` mirrors the
 * original `createSignalingServer`'s optional last positional arg — the wiring
 * layer (index.ts) SHARES one InterRelaySocketMap between this server's
 * tagged-peer attach and the PRIMARY's per-peer announce/param send.
 */
export function createSignalingServerState(providedSockets?: InterRelaySocketMap): SignalingServerState {
  return {
    rooms: new Map(),
    originRegistry: new Map(),
    consumerLastByteCount: new Map(),
    roomConfigs: new Map(),
    passwordAttempts: new Map(),
    wsToRoom: new Map(),
    roomCreationLocks: new Map(),
    accepting: true,
    interRelayPeers: new WeakSet(),
    attachedInterRelaySocket: null,
    interRelaySockets: providedSockets ?? createInterRelaySocketMap(),
  };
}

/**
 * REQ-RMS-034/036 (part-3 reverse leg) — return a live room so the wiring layer's
 * onReverseAnnounce can mint the hub copy onto room.router.
 */
export function getRoom(state: SignalingServerState, roomId: string): RoomState | undefined {
  return state.rooms.get(roomId);
}
